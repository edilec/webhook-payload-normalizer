/**
 * webhook-payload-normalizer
 *
 * Maps versioned provider event fixtures into one canonical event shape, and
 * reports every payload it would not map.
 *
 * Four properties are structural rather than incidental:
 *
 * 1. **A mapping is never guessed.** Selection is an exact
 *    `(provider, version, sourceType)` match. There is no nearest-version
 *    fallback, no numeric comparison, no "latest" and no prefix match, because
 *    mapping a v3 payload with the v2 rules is how wrong data enters a system.
 *    An unknown version is a refusal that fails the run.
 * 2. **Provenance survives.** Every canonical event carries the provider, the
 *    provider's own version string and the provider's own event id. A payload
 *    whose id cannot be read is refused rather than normalized anonymously.
 * 3. **A field nobody mapped is handled by a declared policy.** `preserve`
 *    carries it under `extensions`, `report` names it and drops it, `reject`
 *    refuses the payload. Silence is not one of the policies.
 * 4. **Unknown is never a pass.** A fixture that could not be read, decoded or
 *    parsed, a bound that stopped the walk, an equivalence group the run did not
 *    finish comparing -- whether because a member never normalized or because
 *    the step budget ran out part-way through it -- and a run that reached a
 *    verdict on nothing each make the report `incomplete`. A `pass` with
 *    `checked: 0` is not reachable, and neither is a group confirmed on
 *    comparisons that never ran.
 *
 * There is no network in this package. It imports no socket, HTTP, datagram,
 * resolver or TLS module, invokes no fetch primitive and spawns no process, so
 * there is no code path a fixture could steer towards one.
 */

import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

import {
  DEFAULT_LIMITS,
  HARD_LIMITS,
  MAX_JOB_BYTES,
  isRecord,
  validateJob,
} from './job.mjs'
import { applyMapping, compareCanonical, resolveEnvelope } from './normalize.mjs'
import { RULE_SEVERITY, compareFindings, createFinding, sortFindings } from './rules.mjs'
import { assertWritableDestination } from './write-guard.mjs'
import {
  byCodeUnit, createBudget, decodeUtf8, joinRelative, parseFailureDetail, sanitize,
} from './text.mjs'

export const TOOL_ID = 'webhook-payload-normalizer'
export const REPORT_SCHEMA_VERSION = '1'

const JOB_OPTION_KEYS = Object.freeze(['baseDir', 'inputs', 'label', 'limits', 'outPath'])
const FILE_OPTION_KEYS = Object.freeze(['label', 'limits', 'outPath'])

/**
 * Containment, decided on real paths.
 *
 * Refusing `../` is not confinement: a symbolic link planted inside the events
 * root resolves out of the tree without ever spelling a traversal. Both sides
 * of this comparison have been through `realpath` before they arrive --
 * comparing a real root against an unresolved candidate is the over-correction,
 * and it refuses fixtures that genuinely are inside a root reached through a
 * symlink. A false refusal is a bug too.
 */
export function isInside(root, candidate) {
  if (candidate === root) return true
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

function createCollector(label) {
  return { label, rows: [], incomplete: false }
}

function record(collector, row) {
  collector.rows.push({ file: row.file ?? collector.label, ...row })
}

function emptyCounts() {
  return { events: 0, checked: 0, normalized: 0, rejected: 0, skipped: 0, unknownFields: 0, extensions: 0 }
}

function emptyNormalization() {
  return { canonicalVersion: null, unknownFields: null, providers: [], mappings: [], events: [], equivalence: [] }
}

function buildReport(collector, counts, normalization, limits, budget) {
  let findings = sortFindings(collector.rows.map(createFinding))
  let truncated = false

  if (findings.length > limits.maxFindings) {
    const dropped = findings.length - limits.maxFindings + 1
    findings = findings.slice(0, limits.maxFindings - 1)
    findings.push(
      createFinding({
        file: collector.label,
        pointer: '/',
        ruleId: 'limit-findings-exceeded',
        message: `This run produced more findings than the maxFindings limit of ${limits.maxFindings}; ${dropped} of them are not in this report.`,
        suggestion: 'Raise limits.maxFindings or normalize fewer fixtures, then re-run; this report is partial.',
      }),
    )
    findings.sort(compareFindings)
    truncated = true
  }

  let errors = 0
  let warnings = 0
  for (const finding of findings) {
    if (finding.severity === 'error') errors += 1
    else if (finding.severity === 'warning') warnings += 1
  }

  const incomplete = collector.incomplete || truncated
  const status = incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: counts.checked,
      errors,
      warnings,
      info: findings.length - errors - warnings,
      events: counts.events,
      normalized: counts.normalized,
      rejected: counts.rejected,
      skipped: counts.skipped,
      unknownFields: counts.unknownFields,
      extensions: counts.extensions,
      steps: budget.spent,
    },
    findings,
    normalization,
  }
}

/** A report that carries the reason an input could not be evaluated. */
function unreadableReport(label, ruleId, message, suggestion) {
  const collector = createCollector(label)
  collector.incomplete = true
  record(collector, { pointer: '/', ruleId, message, ...(suggestion === undefined ? {} : { suggestion }) })
  record(collector, {
    pointer: '/events',
    ruleId: 'no-events-checked',
    message: 'No fixture reached a verdict, so this run checked nothing. A report with no evidence in it is not a passing report.',
  })
  return buildReport(collector, emptyCounts(), emptyNormalization(), DEFAULT_LIMITS, createBudget(1))
}

async function resolveEventsRoot(collector, baseDir, eventsRoot) {
  if (eventsRoot === null) return null
  if (typeof baseDir !== 'string' || baseDir === '') {
    throw new TypeError('A job that declares "eventsRoot" must be normalized with a baseDir to resolve it against')
  }
  try {
    return await realpath(resolve(baseDir, eventsRoot))
  } catch (error) {
    record(collector, {
      pointer: '/eventsRoot',
      ruleId: 'event-file-unreadable',
      message: `The events root could not be resolved: ${error.code ?? 'unknown error'}. No fixture that names a file was read.`,
      evidence: eventsRoot,
      suggestion: 'Check "eventsRoot" against the directory layout next to the job file.',
    })
    collector.incomplete = true
    return null
  }
}

/**
 * Read one fixture's payload from its file.
 *
 * A file that resolved outside the root is a *refusal* -- a verdict this tool
 * reached, which fails the run. A file that could not be read, decoded or
 * parsed is evidence nobody obtained, which makes the run incomplete instead.
 * The two are not interchangeable and they do not share an exit code.
 */
async function loadFixture(collector, event, rootReal, limits, inputs) {
  const label = event.fileLabel
  const pointer = `/events/${event.index}`

  if (rootReal === null) return { ok: false, outcome: 'skipped' }

  const absolute = resolve(rootReal, event.file)
  let real
  try {
    real = await realpath(absolute)
  } catch (error) {
    record(collector, {
      file: label,
      pointer,
      ruleId: 'event-file-unreadable',
      message: `Fixture file could not be read: ${error.code ?? 'unknown error'}. Fixture "${sanitize(event.ref, 80)}" was not normalized.`,
      evidence: label,
    })
    collector.incomplete = true
    return { ok: false, outcome: 'skipped' }
  }

  if (!isInside(rootReal, real)) {
    record(collector, {
      file: label,
      pointer,
      ruleId: 'event-file-outside-root',
      message: `Fixture file resolves outside the declared events root, so fixture "${sanitize(event.ref, 80)}" was refused unread. Its contents are not in this report.`,
      evidence: label,
      suggestion: 'Move the fixture inside the events root, or point "eventsRoot" at the directory that really holds it.',
    })
    return { ok: false, outcome: 'rejected' }
  }

  /**
   * Size first, then the bytes, under one failure handler.
   *
   * The size is read from the filesystem rather than inferred from the parsed
   * payload: a payload whose serialized form is small can still sit in an
   * enormous file, and reading that file in to discover it was small is the
   * failure this bound exists to prevent.
   */
  let bytes
  let info
  try {
    info = await stat(real)
    if (info.size > limits.maxPayloadBytes) {
      record(collector, {
        file: label,
        pointer,
        ruleId: 'limit-payload-bytes-exceeded',
        message: `Fixture file is ${info.size} bytes, above the maxPayloadBytes limit of ${limits.maxPayloadBytes}; it was not read, not truncated and not normalized.`,
        evidence: label,
        suggestion: 'Raise limits.maxPayloadBytes, or shrink the fixture.',
      })
      collector.incomplete = true
      return { ok: false, outcome: 'skipped' }
    }
    bytes = await readFile(real)
  } catch (error) {
    record(collector, {
      file: label,
      pointer,
      ruleId: 'event-file-unreadable',
      message: `Fixture file could not be read: ${error.code ?? 'unknown error'}. Fixture "${sanitize(event.ref, 80)}" was not normalized.`,
      evidence: label,
    })
    collector.incomplete = true
    return { ok: false, outcome: 'skipped' }
  }
  inputs.push({ dev: info.dev, ino: info.ino, label })

  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    record(collector, {
      file: label,
      pointer,
      ruleId: 'event-file-not-utf8',
      message: `Fixture file is not valid UTF-8; fixture "${sanitize(event.ref, 80)}" was not normalized.`,
      evidence: label,
      suggestion: 'Re-encode the fixture as UTF-8.',
    })
    collector.incomplete = true
    return { ok: false, outcome: 'skipped' }
  }

  try {
    return { ok: true, payload: JSON.parse(decoded.text) }
  } catch (error) {
    record(collector, {
      file: label,
      pointer,
      ruleId: 'event-file-not-json',
      message: `Fixture file is not valid JSON: ${parseFailureDetail(error)}. Fixture "${sanitize(event.ref, 80)}" was not normalized.`,
      evidence: label,
      suggestion: 'Validate the fixture with a JSON parser before re-running.',
    })
    collector.incomplete = true
    return { ok: false, outcome: 'skipped' }
  }
}

/**
 * Decide whether the normalized bundle may be written, and write it.
 *
 * The destination is checked before anything is opened, and a destination that
 * cannot be written to safely throws out of the run: it is a configuration
 * error, so the CLI exits 2 with an empty stdout rather than reporting on a
 * subject it never had. `assertWritableDestination` carries the reasoning for
 * all three holes -- a symlink at the destination, a symlinked parent, and a
 * hard link to an input -- and none of them catches the other two.
 *
 * The second refusal is the tool's own: a run that did not fully succeed
 * withholds its bundle, because a partially normalized set of events written to
 * disk is the kind of output a pipeline picks up without noticing what is
 * missing. It is reported rather than thrown, because that run did have a
 * subject and the report is the verdict about it.
 */
async function writeBundle(collector, normalization, outPath, inputs, root, clean) {
  const absolute = await assertWritableDestination(outPath, { inputs, root, label: '--out' })

  if (!clean) {
    record(collector, {
      pointer: '/',
      ruleId: 'output-withheld',
      message: 'The run did not complete cleanly, so no normalized bundle was written. A partial bundle is the kind of file a pipeline consumes without noticing what is missing.',
      evidence: outPath,
      suggestion: 'Fix the findings above and re-run; the bundle is written only when the run passes.',
    })
    return
  }

  try {
    await writeFile(absolute, `${JSON.stringify(normalization, null, 2)}\n`)
  } catch (error) {
    record(collector, {
      pointer: '/',
      ruleId: 'output-unwritable',
      message: `The normalized bundle could not be written: ${error.code ?? 'unknown error'}.`,
      evidence: outPath,
      suggestion: 'Check the --out path and its directory permissions.',
    })
  }
}

/**
 * Normalize a job object.
 *
 * `baseDir` is required only when the job declares `eventsRoot`; a job whose
 * fixtures are all inline needs no filesystem at all.
 */
export async function normalizeJob(job, options = {}) {
  if (!isRecord(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options)) {
    if (!JOB_OPTION_KEYS.includes(key)) throw new TypeError(`Unknown option "${key}"`)
  }
  const label = options.label ?? 'job.json'
  const inputs = [...(options.inputs ?? [])]
  const collector = createCollector(label)
  const counts = emptyCounts()

  const overrides = {}
  for (const [name, value] of Object.entries(options.limits ?? {})) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new TypeError(`Unknown limit "${name}"`)
    if (!Number.isInteger(value) || value < 1 || value > HARD_LIMITS[name]) {
      throw new TypeError(`Limit "${name}" must be an integer between 1 and ${HARD_LIMITS[name]}`)
    }
    overrides[name] = value
  }
  const validated = validateJob(job, overrides)
  const limits = validated.limits
  const budget = createBudget(limits.maxSteps)

  for (const row of validated.problems) record(collector, row)
  if (validated.problems.length > 0) collector.incomplete = true

  if (!validated.ok) {
    record(collector, {
      pointer: '/events',
      ruleId: 'no-events-checked',
      message: 'The job was refused, so no fixture reached a verdict and this run checked nothing.',
      suggestion: 'Fix the job findings above and re-run.',
    })
    return buildReport(collector, counts, emptyNormalization(), limits, budget)
  }

  const declared = validated.value
  counts.events = declared.events.length
  const rootReal = await resolveEventsRoot(collector, options.baseDir, declared.eventsRoot)

  const byKey = new Map()
  const versionsByProvider = new Map()
  for (const mapping of declared.mappings) {
    byKey.set(mapping.key, mapping)
    if (!versionsByProvider.has(mapping.provider)) versionsByProvider.set(mapping.provider, new Set())
    versionsByProvider.get(mapping.provider).add(mapping.version)
  }
  const used = new Set()
  const normalized = new Map()
  const events = []

  for (const event of declared.events) {
    const pointer = `/events/${event.index}`
    event.fileLabel = event.file === null ? label : joinRelative(declared.eventsRoot ?? '', event.file)
    const file = event.fileLabel

    if (budget.exhausted) break

    const provider = declared.providers.get(event.provider)
    if (provider === undefined) {
      record(collector, {
        file,
        pointer,
        ruleId: 'provider-unknown',
        message: `Fixture "${sanitize(event.ref, 80)}" names provider "${sanitize(event.provider, 80)}", which this job does not declare, so it was refused rather than mapped with somebody else's rules.`,
        evidence: event.provider,
        suggestion: 'Declare the provider in "providers", or correct the fixture.',
      })
      counts.checked += 1
      counts.rejected += 1
      continue
    }

    let payload
    if (event.file === null) {
      payload = event.payload
    } else {
      const loaded = await loadFixture(collector, event, rootReal, limits, inputs)
      if (!loaded.ok) {
        if (loaded.outcome === 'rejected') {
          counts.checked += 1
          counts.rejected += 1
        } else {
          counts.skipped += 1
        }
        continue
      }
      payload = loaded.payload
    }

    if (!budget.spend()) break
    const envelope = resolveEnvelope(payload, provider)

    if (envelope.version === null) {
      record(collector, {
        file,
        pointer,
        ruleId: 'event-version-unresolved',
        message: `The provider version at "${provider.versionAt}" is ${envelope.versionKind === 'absent' ? 'absent' : `a ${envelope.versionKind}, not an unambiguous non-empty string`}, so which mapping applies is not something this run established. Nothing was mapped.`,
        evidence: provider.versionAt,
        suggestion: 'Correct the provider\'s "versionAt" pointer, or the fixture.',
      })
      collector.incomplete = true
      counts.skipped += 1
      continue
    }

    if (event.version !== null && event.version !== envelope.version) {
      record(collector, {
        file,
        pointer,
        ruleId: 'event-version-conflict',
        message: 'The fixture declaration and its payload provide different version values. Neither answer wins, so nothing was mapped.',
        evidence: `job ${pointer}/version; provider versionAt declaration`,
        suggestion: 'Correct the declared "version", or the fixture.',
      })
      counts.checked += 1
      counts.rejected += 1
      continue
    }

    if (envelope.type === null) {
      record(collector, {
        file,
        pointer,
        ruleId: 'event-type-unresolved',
        message: `The provider event name at "${provider.typeAt}" is ${envelope.typeKind === 'absent' ? 'absent' : `a ${envelope.typeKind}, not an unambiguous non-empty string`}, so which mapping applies is not something this run established. Nothing was mapped.`,
        evidence: provider.typeAt,
        suggestion: 'Correct the provider\'s "typeAt" pointer, or the fixture.',
      })
      collector.incomplete = true
      counts.skipped += 1
      continue
    }

    const known = versionsByProvider.get(provider.name) ?? new Set()
    if (!known.has(envelope.version)) {
      record(collector, {
        file,
        pointer,
        ruleId: 'mapping-version-unknown',
        message: `No mapping declares provider "${sanitize(provider.name, 60)}" version "${sanitize(envelope.version, 40)}". This tool does not fall back to the nearest known version, so the payload was refused rather than mapped with rules written for something else.`,
        evidence: envelope.version,
        suggestion: `Write a mapping for this version. Versions with a mapping: ${[...known].sort(byCodeUnit).join(', ') || 'none'}.`,
      })
      counts.checked += 1
      counts.rejected += 1
      continue
    }

    const mapping = byKey.get(`${provider.name}@${envelope.version}@${envelope.type}`)
    if (mapping === undefined) {
      const rendered = sanitize(envelope.type, 60)
      const collision = declared.mappings
        .filter((candidate) => candidate.provider === provider.name && candidate.version === envelope.version &&
          sanitize(candidate.sourceType, 60) === rendered)
        .sort((left, right) => byCodeUnit(left.sourceType, right.sourceType))[0]
      record(collector, {
        file,
        pointer,
        ruleId: 'mapping-event-unknown',
        message: 'The payload event type does not exactly match any mapping for its declared provider and version, so the payload was refused. Inspect the source positions rather than trusting a bounded excerpt.',
        evidence: `job ${pointer}; job ${collision === undefined ? '/mappings' : `/mappings/${collision.index}/sourceType`}`,
        suggestion: 'Write a mapping for this source event type, or drop the fixture from the job.',
      })
      counts.checked += 1
      counts.rejected += 1
      continue
    }
    used.add(mapping.key)

    const result = applyMapping({
      payload,
      mapping,
      provider,
      canonicalVersion: declared.canonicalVersion,
      version: envelope.version,
      sourceType: envelope.type,
      limits,
      budget,
      pointer,
    })
    for (const row of result.rows) record(collector, { file, ...row })
    counts.unknownFields += result.rows.filter((row) => row.ruleId.startsWith('unknown-fields-')).length

    if (result.budgetExhausted === true) {
      counts.skipped += 1
      break
    }
    if (result.incomplete === true) collector.incomplete = true
    if (!result.ok) {
      if (result.incomplete === true) counts.skipped += 1
      else {
        counts.checked += 1
        counts.rejected += 1
      }
      continue
    }

    counts.checked += 1
    counts.normalized += 1
    counts.extensions += result.event.extensions === undefined ? 0 : result.event.extensions.length
    const emitted = { ref: event.ref, ...result.event }
    events.push(emitted)
    normalized.set(event.ref, emitted)
  }

  for (const mapping of declared.mappings) {
    if (used.has(mapping.key)) continue
    record(collector, {
      pointer: `/mappings/${mapping.index}`,
      ruleId: 'mapping-unused',
      message: `No fixture in this job selected the mapping for provider "${sanitize(mapping.provider, 60)}" version "${sanitize(mapping.version, 40)}" event "${sanitize(mapping.sourceType, 60)}", so nothing here exercises it.`,
      evidence: mapping.key,
    })
  }

  /**
   * The equivalence verdicts, and the budget that can stop them halfway.
   *
   * `match` starts at `true` and only a completed sweep of the group can leave
   * it there, so the budget has to be accounted for at both loops rather than
   * broken out of. An inner `break` that fell through to the `if (match)` below
   * would record "this group holds" on comparisons that never ran -- a positive
   * claim about work the run did not do, written into the report and into the
   * `--out` bundle. Every way this loop can stop early therefore lands on
   * `equivalence-unresolved` and `match: null`: a comparison that stopped
   * halfway is not a group that holds, and it is not a mismatch either. Groups
   * the loop never reached at all are listed too, so the bundle never quietly
   * omits a claim rather than answering it.
   */
  const equivalence = []
  for (const group of declared.equivalence) {
    const unresolved = (message, evidence, suggestion) => {
      record(collector, {
        pointer: `/equivalence/${group.index}`,
        ruleId: 'equivalence-unresolved',
        message,
        evidence,
        suggestion,
      })
      collector.incomplete = true
      equivalence.push({ id: group.id, refs: [...group.refs], match: null })
    }
    const refList = group.refs.map((ref) => sanitize(ref, 40)).join(' ')

    if (!budget.spend()) {
      unresolved(
        `Equivalence group "${sanitize(group.id, 60)}" was never compared: this run reached the maxSteps budget of ${limits.maxSteps} before it got here, so whether the group agrees is not something this run established.`,
        refList,
        'Raise limits.maxSteps, or split the job; an equivalence nobody compared is not a satisfied one.',
      )
      continue
    }

    const missing = group.refs.filter((ref) => !normalized.has(ref))
    if (missing.length > 0) {
      unresolved(
        `Equivalence group "${sanitize(group.id, 60)}" names ${missing.length} fixture(s) that produced no canonical event, so whether the group agrees is not something this run established.`,
        missing.map((ref) => sanitize(ref, 40)).join(' '),
        'Fix the findings for those fixtures; an unchecked equivalence is not a satisfied one.',
      )
      continue
    }

    const [first, ...rest] = group.refs
    let match = true
    let compared = 0
    for (const ref of rest) {
      if (!budget.spend()) break
      compared += 1
      const verdict = compareCanonical(normalized.get(first).canonical, normalized.get(ref).canonical)
      if (verdict.equal) continue
      match = false
      record(collector, {
        pointer: `/equivalence/${group.index}`,
        ruleId: 'equivalence-mismatch',
        message: `Equivalence group "${sanitize(group.id, 60)}" requires "${sanitize(ref, 40)}" to normalize to the same canonical body as "${sanitize(first, 40)}", and they differ.`,
        evidence: verdict.difference,
        suggestion: 'Correct the mapping for one of the two providers, or drop the claim that they are equivalent.',
      })
    }

    if (compared < rest.length) {
      unresolved(
        `Equivalence group "${sanitize(group.id, 60)}" got through ${compared} of its ${rest.length} comparison(s) before this run reached the maxSteps budget of ${limits.maxSteps}, so whether the group agrees is not something this run established.`,
        refList,
        'Raise limits.maxSteps, or split the job; a comparison that stopped halfway is not a group that holds.',
      )
      continue
    }

    if (match) {
      record(collector, {
        pointer: `/equivalence/${group.index}`,
        ruleId: 'equivalence-confirmed',
        message: `Equivalence group "${sanitize(group.id, 60)}" holds: all ${group.refs.length} fixtures normalized to the same canonical body, differing only in the provenance this tool keeps separate.`,
        evidence: refList,
      })
    }
    equivalence.push({ id: group.id, refs: [...group.refs], match })
  }

  /**
   * The budget, re-read after every loop that could have exhausted it.
   *
   * Checked before the equivalence loop instead, this finding records the
   * fixtures the events loop skipped and stays silent about an equivalence
   * sweep the same budget cut short -- which is how a run with an unexamined
   * claim in it reached `pass` with no finding saying so.
   */
  if (budget.exhausted) {
    record(collector, {
      pointer: '/events',
      ruleId: 'limit-steps-exceeded',
      message: `This run reached the maxSteps budget of ${limits.maxSteps} and stopped. The work past that point -- fixtures left to normalize and equivalence groups left to compare alike -- was not done, so this report is partial.`,
      suggestion: 'Raise limits.maxSteps, or split the job.',
    })
    collector.incomplete = true
  }

  /**
   * Green on no evidence is a defect, not a clean bill of health. The test is
   * `checked` -- the field the guarantee is written in terms of -- so a job
   * that declared fifty fixtures and reached a verdict on none of them is
   * reported here rather than passing quietly.
   */
  if (counts.checked === 0) {
    record(collector, {
      pointer: '/events',
      ruleId: 'no-events-checked',
      message: `No fixture reached a verdict, so this run checked nothing. ${counts.events} fixture(s) were declared and ${counts.skipped} were not examined.`,
      suggestion: 'Check the job, the fixtures and the limits; an empty run proves nothing about the mappings.',
    })
    collector.incomplete = true
  }

  const normalization = {
    canonicalVersion: declared.canonicalVersion,
    unknownFields: declared.unknownFields,
    // ORDERING SITE 8 -- the provider list in the report.
    providers: [...declared.providers.keys()].map((name) => sanitize(name, 80)).sort(byCodeUnit),
    // ORDERING SITE 9 -- the mapping list in the report.
    mappings: declared.mappings.map((mapping) => sanitize(mapping.key, 160)).sort(byCodeUnit),
    events,
    equivalence,
  }

  if (options.outPath !== undefined && options.outPath !== null) {
    const clean = !collector.incomplete && !collector.rows.some((row) => RULE_SEVERITY[row.ruleId] === 'error')
    const outRoot = typeof options.baseDir === 'string' && options.baseDir !== '' ? options.baseDir : null
    await writeBundle(collector, normalization, options.outPath, inputs, outRoot, clean)
  }

  return buildReport(collector, counts, normalization, limits, budget)
}

/**
 * Read a job file and normalize it.
 *
 * The job file is decoded with the same strict decoder as every fixture: a tool
 * that hardens its data path and leaves its own configuration path lossy has
 * hardened nothing.
 */
export async function normalizeJobFile(jobPath, options = {}) {
  if (typeof jobPath !== 'string' || jobPath.trim() === '') throw new TypeError('A job path is required')
  if (!isRecord(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options)) {
    if (!FILE_OPTION_KEYS.includes(key)) throw new TypeError(`Unknown option "${key}"`)
  }
  const label = options.label ?? jobPath

  const absolute = resolve(jobPath)
  let info
  try {
    info = await stat(absolute)
  } catch (error) {
    return unreadableReport(label, 'job-unreadable', `The job file could not be read: ${error.code ?? 'unknown error'}.`, 'Check the --job path and its permissions.')
  }
  if (!info.isFile()) {
    return unreadableReport(label, 'job-unreadable', 'The job path is not a regular file.', 'Pass the JSON job file to --job.')
  }
  if (info.size > MAX_JOB_BYTES) {
    return unreadableReport(
      label,
      'limit-job-bytes-exceeded',
      `The job file is ${info.size} bytes, above the limit of ${MAX_JOB_BYTES}; it was not parsed and nothing was normalized.`,
      'Split the job, or move payloads into files under "eventsRoot".',
    )
  }

  let bytes
  try {
    bytes = await readFile(absolute)
  } catch (error) {
    return unreadableReport(label, 'job-unreadable', `The job file could not be read: ${error.code ?? 'unknown error'}.`, 'Check the --job path and its permissions.')
  }

  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    return unreadableReport(label, 'job-not-utf8', 'The job file is not valid UTF-8; it was not parsed and nothing was normalized.', 'Re-encode the job as UTF-8.')
  }

  let parsed
  try {
    parsed = JSON.parse(decoded.text)
  } catch (error) {
    return unreadableReport(label, 'job-not-json', `The job file is not valid JSON: ${parseFailureDetail(error)}.`, 'Validate the job with a JSON parser before re-running.')
  }

  let baseDir
  try {
    baseDir = await realpath(dirname(absolute))
  } catch {
    baseDir = dirname(absolute)
  }

  return normalizeJob(parsed, {
    label,
    baseDir,
    inputs: [{ dev: info.dev, ino: info.ino, label }],
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.outPath === undefined ? {} : { outPath: options.outPath }),
  })
}

export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

/** The JSON report, exactly as it goes to stdout. */
export function serializeReport(report) {
  return JSON.stringify(report, null, 2)
}

const SEVERITY_WIDTH = 7

/**
 * The human summary. Every untrusted string in it was sanitised on the way into
 * the finding, so a fixture cannot forge a line here.
 */
export function formatReport(report) {
  const { summary, normalization } = report
  const lines = [
    `${summary.checked} of ${summary.events} fixture(s) reached a verdict: ${summary.normalized} normalized, ${summary.rejected} refused, ${summary.skipped} not examined.`,
    `canonical version ${normalization.canonicalVersion ?? 'none'}, ${normalization.mappings.length} mapping(s), ${summary.unknownFields} unclaimed field(s), ${summary.extensions} preserved under extensions.`,
    `${summary.errors} error, ${summary.warnings} warning, ${summary.info} info, status ${report.status}, ${summary.steps} step(s).`,
  ]
  for (const finding of report.findings) {
    const quoted = finding.evidence === undefined ? '' : ` -- ${finding.evidence}`
    lines.push(
      `${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ${finding.location.file}${finding.location.pointer} ${finding.ruleId} ${finding.message}${quoted}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export { DEFAULT_LIMITS, HARD_LIMITS, MAX_JOB_BYTES, SUPPORTED_TRANSFORMS, SUPPORTED_TYPES, UNKNOWN_FIELD_POLICIES, applyLimits, isRecord, validateJob } from './job.mjs'
export { applyMapping, compareCanonical, resolveEnvelope } from './normalize.mjs'
export { POINTER_MAX_LENGTH, POINTER_MAX_TOKENS, covers, enumerateLeaves, escapeToken, parsePointer, readPointer, resolvePointer } from './pointer.mjs'
export { RULE_SEVERITY, SEVERITY_DECIDES, SEVERITY_VALUES, compareFindings, createFinding, sortFindings } from './rules.mjs'
export { DestinationError, assertWritableDestination, isSameFile } from './write-guard.mjs'
export {
  TEXT_LIMIT, byCodeUnit, createBudget, decodeUtf8, joinRelative, parseFailureDetail, sanitize,
  sanitizeValue,
} from './text.mjs'
