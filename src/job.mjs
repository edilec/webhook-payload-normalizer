/**
 * webhook-payload-normalizer -- the job schema, its bounds, and the validator.
 *
 * A job declares the providers, the per-version mappings, the fixtures and the
 * equivalence groups. It is configuration, and it is validated exactly as
 * strictly as the payloads are: an unknown key is refused rather than ignored,
 * because a one-character typo in `unknownFields` must not quietly turn a
 * rejection policy into the default one.
 */

import { parsePointer } from './pointer.mjs'
import { sanitize } from './text.mjs'

/** The job file itself is bounded, and the bound is reported by name. */
export const MAX_JOB_BYTES = 1048576

export const MAX_PROVIDERS = 64
export const MAX_FIELDS_PER_MAPPING = 64
export const MAX_EQUIVALENCE_GROUPS = 64
export const MAX_REFS_PER_GROUP = 16
export const MAX_VALUE_MAP_ENTRIES = 64

/**
 * The configurable bounds and their defaults.
 *
 * `maxSteps` is this tool's timeout. It counts work rather than milliseconds --
 * see `createBudget` in `text.mjs` for why a wall clock is the wrong bound for
 * a tool whose verdict must not depend on how fast the machine is.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxEvents: 500,
  maxFindings: 500,
  maxMappings: 200,
  maxPayloadBytes: 65536,
  maxPayloadDepth: 16,
  maxSteps: 200000,
  maxUnknownFields: 128,
  maxValueChars: 512,
})

/** The ceiling each configurable bound may be raised to. */
export const HARD_LIMITS = Object.freeze({
  maxEvents: 5000,
  maxFindings: 5000,
  maxMappings: 2000,
  maxPayloadBytes: 4194304,
  maxPayloadDepth: 64,
  maxSteps: 5000000,
  maxUnknownFields: 4096,
  maxValueChars: 65536,
})

/** The declared policies for a field no mapping claimed. Silence is not one. */
export const UNKNOWN_FIELD_POLICIES = Object.freeze(['preserve', 'report', 'reject'])

/** The source types this tool checks. It converts between none of them. */
export const SUPPORTED_TYPES = Object.freeze(['boolean', 'integer', 'number', 'string'])

/** The transforms this tool applies. Each is explicit and each is total. */
export const SUPPORTED_TRANSFORMS = Object.freeze(['lowercase', 'none', 'trim', 'uppercase'])

const JOB_KEYS = Object.freeze([
  'canonicalVersion',
  'equivalence',
  'events',
  'eventsRoot',
  'limits',
  'mappings',
  'providers',
  'unknownFields',
])
const PROVIDER_KEYS = Object.freeze(['name', 'typeAt', 'versionAt'])
const MAPPING_KEYS = Object.freeze([
  'canonicalType',
  'fields',
  'provider',
  'sourceId',
  'sourceType',
  'unknownFields',
  'version',
])
const FIELD_KEYS = Object.freeze(['as', 'from', 'required', 'to', 'transform', 'values'])
const EVENT_KEYS = Object.freeze(['file', 'payload', 'provider', 'ref', 'version'])
const EQUIVALENCE_KEYS = Object.freeze(['id', 'refs'])

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function problem(problems, pointer, message, suggestion) {
  problems.push({ pointer, ruleId: 'job-invalid', message, ...(suggestion === undefined ? {} : { suggestion }) })
}

function unknownKeys(problems, record, allowed, prefix) {
  for (const key of Object.keys(record)) {
    if (allowed.includes(key)) continue
    problems.push({
      pointer: `${prefix}/${sanitize(key, 80)}`,
      ruleId: 'job-unknown-key',
      message: `"${sanitize(key, 80)}" is not a key this schema defines, so it was refused rather than ignored.`,
      suggestion: `Remove the key, or correct it to one of: ${allowed.join(', ')}.`,
    })
  }
}

/**
 * Apply configured limits over the defaults.
 *
 * An unknown limit name is refused, and a value above its ceiling is refused.
 * Accepting a bound nobody can honour would leave a documented limit
 * unenforced, which is how a tool comes to advertise a guarantee it does not
 * have.
 */
export function applyLimits(limits, problems, prefix = '/limits') {
  const value = { ...DEFAULT_LIMITS }
  if (limits === undefined) return value
  if (!isRecord(limits)) {
    problem(problems, prefix, '"limits" must be an object.')
    return value
  }
  unknownKeys(problems, limits, Object.keys(DEFAULT_LIMITS), prefix)
  for (const [name, raw] of Object.entries(limits)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) continue
    if (!Number.isInteger(raw) || raw < 1) {
      problem(problems, `${prefix}/${name}`, `"${name}" must be a positive integer.`)
      continue
    }
    if (raw > HARD_LIMITS[name]) {
      problem(problems, `${prefix}/${name}`, `"${name}" is ${raw}, above the ceiling of ${HARD_LIMITS[name]}.`)
      continue
    }
    value[name] = raw
  }
  return value
}

function pointerField(problems, raw, pointer, what) {
  const parsed = parsePointer(raw)
  if (parsed.ok) return parsed.tokens
  problems.push({
    pointer,
    ruleId: 'mapping-unsupported-construct',
    message: `${what} is not a pointer this tool supports: ${parsed.reason}.`,
    evidence: typeof raw === 'string' ? sanitize(raw, 120) : undefined,
    suggestion: 'See "The supported pointer subset" in docs/normalization-rules.md.',
  })
  return null
}

function validateProviders(raw, problems) {
  const providers = new Map()
  if (!Array.isArray(raw)) {
    problem(problems, '/providers', '"providers" must be an array of provider declarations.')
    return providers
  }
  if (raw.length === 0) problem(problems, '/providers', '"providers" must declare at least one provider.')
  if (raw.length > MAX_PROVIDERS) {
    problem(problems, '/providers', `"providers" declares ${raw.length} providers, above the fixed bound of ${MAX_PROVIDERS}.`)
    return providers
  }

  raw.forEach((entry, index) => {
    const at = `/providers/${index}`
    if (!isRecord(entry)) {
      problem(problems, at, 'A provider declaration must be an object.')
      return
    }
    unknownKeys(problems, entry, PROVIDER_KEYS, at)
    if (typeof entry.name !== 'string' || !NAME.test(entry.name)) {
      problem(problems, `${at}/name`, 'A provider "name" must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}.')
      return
    }
    if (providers.has(entry.name)) {
      problem(problems, `${at}/name`, `This provider is declared more than once; its first declaration is at /providers/${providers.get(entry.name).index}/name.`)
      return
    }
    const versionTokens = pointerField(problems, entry.versionAt, `${at}/versionAt`, '"versionAt"')
    const typeTokens = pointerField(problems, entry.typeAt, `${at}/typeAt`, '"typeAt"')
    if (versionTokens === null || typeTokens === null) return
    providers.set(entry.name, {
      index,
      name: entry.name,
      versionAt: entry.versionAt,
      typeAt: entry.typeAt,
      versionTokens,
      typeTokens,
    })
  })
  return providers
}

function validateValueMap(raw, at, problems) {
  if (raw === undefined) return null
  if (!isRecord(raw)) {
    problem(problems, at, '"values" must be an object mapping source values to canonical values.')
    return null
  }
  const entries = Object.entries(raw)
  if (entries.length === 0) {
    problem(problems, at, '"values" must declare at least one mapping; an empty map rejects every value.')
    return null
  }
  if (entries.length > MAX_VALUE_MAP_ENTRIES) {
    problem(problems, at, `"values" declares ${entries.length} entries, above the fixed bound of ${MAX_VALUE_MAP_ENTRIES}.`)
    return null
  }
  const map = new Map()
  for (const [key, value] of entries) {
    const kind = value === null ? 'null' : typeof value
    if (!['null', 'boolean', 'number', 'string'].includes(kind)) {
      problem(problems, `${at}/${sanitize(key, 60)}`, 'A "values" entry must map to a string, number, boolean or null.')
      continue
    }
    if (kind === 'number' && !Number.isFinite(value)) {
      problem(problems, `${at}/${sanitize(key, 60)}`, 'A "values" entry must map to a finite number.')
      continue
    }
    map.set(key, value)
  }
  return map
}

function validateFields(raw, at, problems) {
  const fields = []
  if (!Array.isArray(raw)) {
    problem(problems, `${at}/fields`, '"fields" must be an array.')
    return fields
  }
  if (raw.length === 0) problem(problems, `${at}/fields`, '"fields" must declare at least one field; a mapping that maps nothing produces an empty canonical event.')
  if (raw.length > MAX_FIELDS_PER_MAPPING) {
    problem(problems, `${at}/fields`, `"fields" declares ${raw.length} fields, above the fixed bound of ${MAX_FIELDS_PER_MAPPING}.`)
    return fields
  }

  const seen = new Set()
  raw.forEach((entry, index) => {
    const here = `${at}/fields/${index}`
    if (!isRecord(entry)) {
      problem(problems, here, 'A field declaration must be an object.')
      return
    }
    unknownKeys(problems, entry, FIELD_KEYS, here)

    if (typeof entry.to !== 'string' || !FIELD_NAME.test(entry.to)) {
      problem(problems, `${here}/to`, 'A canonical field name "to" must match [A-Za-z][A-Za-z0-9_-]{0,63}.')
      return
    }
    if (seen.has(entry.to)) {
      problem(problems, `${here}/to`, `Canonical field "${sanitize(entry.to, 80)}" is declared twice in one mapping.`)
      return
    }
    if (!SUPPORTED_TYPES.includes(entry.as)) {
      problems.push({
        pointer: `${here}/as`,
        ruleId: 'mapping-unsupported-construct',
        message: `"as" must be one of ${SUPPORTED_TYPES.join(', ')}; this tool checks types and converts between none of them.`,
        evidence: typeof entry.as === 'string' ? sanitize(entry.as, 60) : undefined,
      })
      return
    }
    const transform = entry.transform ?? 'none'
    if (!SUPPORTED_TRANSFORMS.includes(transform)) {
      problems.push({
        pointer: `${here}/transform`,
        ruleId: 'mapping-unsupported-construct',
        message: `"transform" must be one of ${SUPPORTED_TRANSFORMS.join(', ')}.`,
        evidence: typeof transform === 'string' ? sanitize(transform, 60) : undefined,
      })
      return
    }
    if (transform !== 'none' && entry.as !== 'string') {
      problem(problems, `${here}/transform`, `"transform" applies to a string source value; this field declares "as": "${entry.as}".`)
      return
    }
    if (entry.required !== undefined && typeof entry.required !== 'boolean') {
      problem(problems, `${here}/required`, '"required" must be a boolean.')
      return
    }
    if (entry.values !== undefined && entry.as !== 'string') {
      problem(problems, `${here}/values`, '"values" enumerates source strings, so the field must declare "as": "string".')
      return
    }
    const values = validateValueMap(entry.values, `${here}/values`, problems)
    if (entry.values !== undefined && values === null) return

    const fromTokens = pointerField(problems, entry.from, `${here}/from`, '"from"')
    if (fromTokens === null) return

    seen.add(entry.to)
    fields.push({
      from: entry.from,
      fromTokens,
      to: entry.to,
      as: entry.as,
      required: entry.required ?? true,
      transform,
      values,
    })
  })
  return fields
}

function validateMappings(raw, providers, defaultPolicy, limits, problems) {
  const mappings = []
  if (!Array.isArray(raw)) {
    problem(problems, '/mappings', '"mappings" must be an array of mapping declarations.')
    return mappings
  }
  if (raw.length === 0) problem(problems, '/mappings', '"mappings" must declare at least one mapping.')
  if (raw.length > limits.maxMappings) {
    problems.push({
      pointer: '/mappings',
      ruleId: 'limit-mappings-exceeded',
      message: `The job declares ${raw.length} mappings, above the maxMappings limit of ${limits.maxMappings}; none were applied.`,
      suggestion: 'Raise limits.maxMappings, or split the job.',
    })
    return mappings
  }

  const seen = new Map()
  raw.forEach((entry, index) => {
    const at = `/mappings/${index}`
    if (!isRecord(entry)) {
      problem(problems, at, 'A mapping declaration must be an object.')
      return
    }
    unknownKeys(problems, entry, MAPPING_KEYS, at)

    if (typeof entry.provider !== 'string' || !NAME.test(entry.provider)) {
      problem(problems, `${at}/provider`, 'A mapping "provider" must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}.')
      return
    }
    if (!providers.has(entry.provider)) {
      problem(problems, `${at}/provider`, `Mapping names provider "${sanitize(entry.provider, 80)}", which "providers" does not declare.`)
      return
    }
    if (typeof entry.version !== 'string' || !VERSION.test(entry.version)) {
      problem(problems, `${at}/version`, 'A mapping "version" must match [A-Za-z0-9][A-Za-z0-9._-]{0,31}. It is compared literally, never numerically.')
      return
    }
    if (typeof entry.sourceType !== 'string' || entry.sourceType === '' || entry.sourceType.length > 120) {
      problem(problems, `${at}/sourceType`, 'A mapping "sourceType" must be a non-empty string of at most 120 characters.')
      return
    }
    if (sanitize(entry.sourceType, entry.sourceType.length) !== entry.sourceType) {
      problem(problems, `${at}/sourceType`, 'A mapping "sourceType" must remain unchanged when rendered safely; otherwise a different event could appear to name the same mapping.')
      return
    }
    if (typeof entry.canonicalType !== 'string' || !NAME.test(entry.canonicalType)) {
      problem(problems, `${at}/canonicalType`, 'A mapping "canonicalType" must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}.')
      return
    }
    const policy = entry.unknownFields ?? defaultPolicy
    if (!UNKNOWN_FIELD_POLICIES.includes(policy)) {
      problem(problems, `${at}/unknownFields`, `"unknownFields" must be one of ${UNKNOWN_FIELD_POLICIES.join(', ')}.`)
      return
    }
    const sourceIdTokens = pointerField(problems, entry.sourceId, `${at}/sourceId`, '"sourceId"')
    if (sourceIdTokens === null) return

    const key = `${entry.provider}@${entry.version}@${entry.sourceType}`
    if (seen.has(key)) {
      problems.push({
        pointer: at,
        ruleId: 'mapping-duplicate',
        message: `A second mapping claims provider "${sanitize(entry.provider, 60)}" version "${sanitize(entry.version, 40)}" event "${sanitize(entry.sourceType, 60)}", already claimed at /mappings/${seen.get(key)}. Which one applies is not something this tool will guess.`,
        suggestion: 'Delete one of the two mappings, or give them different source event types.',
      })
      return
    }
    const fields = validateFields(entry.fields, at, problems)
    seen.set(key, index)
    mappings.push({
      index,
      key,
      provider: entry.provider,
      version: entry.version,
      sourceType: entry.sourceType,
      canonicalType: entry.canonicalType,
      sourceId: entry.sourceId,
      sourceIdTokens,
      unknownFields: policy,
      fields,
    })
  })
  return mappings
}

function validateEvents(raw, limits, problems) {
  const events = []
  if (!Array.isArray(raw)) {
    problem(problems, '/events', '"events" must be an array of fixture declarations.')
    return { events, truncated: 0 }
  }

  let entries = raw
  let truncated = 0
  if (raw.length > limits.maxEvents) {
    truncated = raw.length - limits.maxEvents
    entries = raw.slice(0, limits.maxEvents)
  }

  const refs = new Set()
  entries.forEach((entry, index) => {
    const at = `/events/${index}`
    if (!isRecord(entry)) {
      problem(problems, at, 'A fixture declaration must be an object.')
      return
    }
    unknownKeys(problems, entry, EVENT_KEYS, at)

    if (typeof entry.ref !== 'string' || !REF.test(entry.ref)) {
      problem(problems, `${at}/ref`, 'A fixture "ref" must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}.')
      return
    }
    if (refs.has(entry.ref)) {
      problem(problems, `${at}/ref`, `Fixture ref "${sanitize(entry.ref, 80)}" is used more than once.`)
      return
    }
    if (typeof entry.provider !== 'string' || !NAME.test(entry.provider)) {
      problem(problems, `${at}/provider`, 'A fixture "provider" must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}.')
      return
    }
    const hasFile = entry.file !== undefined
    const hasPayload = entry.payload !== undefined
    if (hasFile === hasPayload) {
      problem(problems, at, 'A fixture must declare exactly one of "file" or "payload".')
      return
    }
    if (hasFile && (typeof entry.file !== 'string' || entry.file === '' || entry.file.length > 200)) {
      problem(problems, `${at}/file`, 'A fixture "file" must be a non-empty relative path of at most 200 characters.')
      return
    }
    if (hasFile && entry.file.startsWith('/')) {
      problem(problems, `${at}/file`, 'A fixture "file" must be relative to "eventsRoot"; an absolute path is refused.')
      return
    }
    if (entry.version !== undefined && (typeof entry.version !== 'string' || !VERSION.test(entry.version))) {
      problem(problems, `${at}/version`, 'A fixture "version", when declared, must match [A-Za-z0-9][A-Za-z0-9._-]{0,31}.')
      return
    }
    refs.add(entry.ref)
    events.push({
      index,
      ref: entry.ref,
      provider: entry.provider,
      version: entry.version ?? null,
      file: hasFile ? entry.file : null,
      payload: hasPayload ? entry.payload : undefined,
    })
  })
  return { events, truncated }
}

function validateEquivalence(raw, events, problems) {
  const groups = []
  if (raw === undefined) return groups
  if (!Array.isArray(raw)) {
    problem(problems, '/equivalence', '"equivalence" must be an array of groups.')
    return groups
  }
  if (raw.length > MAX_EQUIVALENCE_GROUPS) {
    problem(problems, '/equivalence', `"equivalence" declares ${raw.length} groups, above the fixed bound of ${MAX_EQUIVALENCE_GROUPS}.`)
    return groups
  }
  const known = new Set(events.map((event) => event.ref))
  const ids = new Set()

  raw.forEach((entry, index) => {
    const at = `/equivalence/${index}`
    if (!isRecord(entry)) {
      problem(problems, at, 'An equivalence group must be an object.')
      return
    }
    unknownKeys(problems, entry, EQUIVALENCE_KEYS, at)
    if (typeof entry.id !== 'string' || !NAME.test(entry.id)) {
      problem(problems, `${at}/id`, 'An equivalence group "id" must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}.')
      return
    }
    if (ids.has(entry.id)) {
      problem(problems, `${at}/id`, `Equivalence group id "${sanitize(entry.id, 80)}" is used more than once.`)
      return
    }
    if (!Array.isArray(entry.refs) || entry.refs.length < 2) {
      problem(problems, `${at}/refs`, 'An equivalence group must name at least two fixture refs; comparing one shape with itself proves nothing.')
      return
    }
    if (entry.refs.length > MAX_REFS_PER_GROUP) {
      problem(problems, `${at}/refs`, `An equivalence group may name at most ${MAX_REFS_PER_GROUP} refs.`)
      return
    }
    let bad = false
    for (const ref of entry.refs) {
      if (typeof ref !== 'string' || !known.has(ref)) {
        problem(
          problems,
          `${at}/refs`,
          `Equivalence group names fixture ref "${typeof ref === 'string' ? sanitize(ref, 80) : String(ref)}", which "events" does not declare.`,
        )
        bad = true
      }
    }
    if (bad) return
    ids.add(entry.id)
    groups.push({ index, id: entry.id, refs: [...entry.refs] })
  })
  return groups
}

/**
 * Validate a job object.
 *
 * Every problem is collected rather than thrown on, so one run reports
 * everything wrong with a job instead of one thing at a time. `ok` is false if
 * anything at all was refused: a job this tool did not fully understand is a
 * job it will not act on.
 */
export function validateJob(job, overrides = {}) {
  const problems = []
  if (!isRecord(job)) {
    problem(problems, '/', 'The job must be a JSON object.')
    return { ok: false, problems, value: null, limits: { ...DEFAULT_LIMITS, ...overrides } }
  }
  unknownKeys(problems, job, JOB_KEYS, '')

  /**
   * Caller overrides win over the job's own limits, and they are applied here
   * rather than after validation.
   *
   * Applying them afterwards is the shape of a limit that is documented,
   * accepted on the command line and never enforced: `--max-events 1` would
   * reach the engine while the *validator* had already decided how many
   * fixtures to keep, using a number nobody asked for.
   */
  const limits = { ...applyLimits(job.limits, problems), ...overrides }

  if (typeof job.canonicalVersion !== 'string' || !VERSION.test(job.canonicalVersion)) {
    problem(problems, '/canonicalVersion', '"canonicalVersion" must match [A-Za-z0-9][A-Za-z0-9._-]{0,31}.')
  }
  const defaultPolicy = job.unknownFields ?? 'preserve'
  if (!UNKNOWN_FIELD_POLICIES.includes(defaultPolicy)) {
    problem(problems, '/unknownFields', `"unknownFields" must be one of ${UNKNOWN_FIELD_POLICIES.join(', ')}.`)
  }
  if (job.eventsRoot !== undefined) {
    if (typeof job.eventsRoot !== 'string' || job.eventsRoot === '' || job.eventsRoot.length > 200) {
      problem(problems, '/eventsRoot', '"eventsRoot" must be a non-empty relative path of at most 200 characters.')
    } else if (job.eventsRoot.startsWith('/')) {
      problem(problems, '/eventsRoot', '"eventsRoot" must be relative to the job file; an absolute path is refused.')
    }
  }

  const providers = validateProviders(job.providers, problems)
  const mappings = validateMappings(job.mappings, providers, UNKNOWN_FIELD_POLICIES.includes(defaultPolicy) ? defaultPolicy : 'preserve', limits, problems)
  const { events, truncated } = validateEvents(job.events, limits, problems)
  const equivalence = validateEquivalence(job.equivalence, events, problems)

  if (job.eventsRoot === undefined && events.some((event) => event.file !== null)) {
    problem(
      problems,
      '/eventsRoot',
      'A fixture declares "file" and the job declares no "eventsRoot", so there is no root to resolve it against and no root to confine it to.',
      'Declare "eventsRoot" relative to the job file, or move the payload inline.',
    )
  }

  if (truncated > 0) {
    problems.push({
      pointer: '/events',
      ruleId: 'limit-events-exceeded',
      message: `The job declares ${events.length + truncated} fixtures, above the maxEvents limit of ${limits.maxEvents}; the last ${truncated} were not examined and are not in this report.`,
      suggestion: 'Raise limits.maxEvents, or split the job.',
    })
  }

  const fatal = problems.some((row) => row.ruleId !== 'limit-events-exceeded')
  return {
    ok: !fatal,
    problems,
    limits,
    value: {
      canonicalVersion: typeof job.canonicalVersion === 'string' ? job.canonicalVersion : '',
      unknownFields: UNKNOWN_FIELD_POLICIES.includes(defaultPolicy) ? defaultPolicy : 'preserve',
      eventsRoot: typeof job.eventsRoot === 'string' ? job.eventsRoot : null,
      providers,
      mappings,
      events,
      equivalence,
      limits,
    },
  }
}
