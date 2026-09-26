/**
 * webhook-payload-normalizer -- the mapping engine.
 *
 * One provider payload plus one mapping becomes one canonical event, or a list
 * of reasons it did not. Nothing in here reads a file, a clock, an environment
 * variable or a socket: it is a pure function of the payload and the mapping,
 * which is what makes two runs over the same bytes produce the same report.
 *
 * The rule that matters most is the one that is *absent*: there is no fallback.
 * A mapping is selected by an exact `(provider, version, sourceType)` match and
 * by nothing else. No nearest version, no numeric comparison, no "latest", no
 * prefix. Silently mapping a v3 payload with the v2 rules is how wrong data
 * enters a system, and a tool that guesses once will guess again.
 */

import { covers, enumerateLeaves, escapeToken, resolvePointer } from './pointer.mjs'
import { byCodeUnit, sanitize, sanitizeValue } from './text.mjs'

/**
 * The provider envelope: where the version and the event name live.
 *
 * Both must resolve to a non-empty string that can be rendered unchanged. A
 * hidden mark or folded whitespace can make two different raw identifiers
 * display identically; such evidence cannot prove a mapping absent. A version
 * that arrives as the number
 * `2` is not the string `"2"`: treating them as the same value is the first
 * step of exactly the coercion this tool exists to refuse, so it is reported as
 * unresolved and the payload is not mapped.
 */
export function resolveEnvelope(payload, provider) {
  const version = resolvePointer(payload, provider.versionTokens)
  const type = resolvePointer(payload, provider.typeTokens)
  return {
    version: version.found && displayStableIdentifier(version.value) ? version.value : null,
    versionKind: version.found ? envelopeKind(version.value) : 'absent',
    type: type.found && displayStableIdentifier(type.value) ? type.value : null,
    typeKind: type.found ? envelopeKind(type.value) : 'absent',
  }
}

function displayStableIdentifier(value) {
  return typeof value === 'string' && value !== '' && sanitize(value, value.length) === value
}

function envelopeKind(value) {
  if (typeof value === 'string' && value !== '' && !displayStableIdentifier(value)) return 'string that changes when rendered'
  return kindOf(value)
}

function kindOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** The declared type check. No conversion happens anywhere in this tool. */
function matchesType(value, as) {
  if (as === 'string') return typeof value === 'string'
  if (as === 'boolean') return typeof value === 'boolean'
  if (as === 'integer') return typeof value === 'number' && Number.isInteger(value)
  return typeof value === 'number' && Number.isFinite(value)
}

function applyTransform(text, transform) {
  if (transform === 'lowercase') return text.toLowerCase()
  if (transform === 'uppercase') return text.toUpperCase()
  if (transform === 'trim') return text.trim()
  return text
}

/**
 * Apply one mapping to one payload.
 *
 * Returns `{ ok, event, rows, sanitised }`. `rows` are finding rows without a
 * file label -- the caller attaches the fixture's label, because only the
 * caller knows whether the payload came from a file or from the job itself.
 *
 * `ok: false` means no canonical event was produced. It is never a partially
 * mapped event: a payload that failed one required field is not normalized at
 * all, because half a canonical event downstream is worse than none.
 */
export function applyMapping({ payload, mapping, provider, canonicalVersion, version, sourceType, limits, budget, pointer }) {
  const rows = []
  const altered = []
  const data = {}
  let ok = true
  let incomplete = false

  const note = (row) => rows.push({ pointer, ...row })

  const clean = (value, where) => {
    const result = sanitizeValue(value)
    if (result.changed) altered.push(where)
    return result.text
  }

  const sourceIdAt = resolvePointer(payload, mapping.sourceIdTokens)
  const rawId = sourceIdAt.found ? sourceIdAt.value : undefined
  const idIsUsable =
    sourceIdAt.found &&
    ((typeof rawId === 'string' && rawId !== '') || (typeof rawId === 'number' && Number.isSafeInteger(rawId)))
  if (!idIsUsable) {
    note({
      ruleId: 'source-id-missing',
      message: `The source event id at "${mapping.sourceId}" is ${sourceIdAt.found ? `a ${kindOf(rawId)}, not an identifier` : 'absent'}, so this payload's provenance would not survive normalization and it was not normalized.`,
      evidence: mapping.sourceId,
      suggestion: 'Point "sourceId" at the provider\'s own event id -- a non-empty string or a safe integer.',
    })
    ok = false
  }

  for (const field of mapping.fields) {
    if (!budget.spend()) return { ok: false, rows, altered, budgetExhausted: true }
    const at = resolvePointer(payload, field.fromTokens)

    if (!at.found) {
      if (field.required) {
        note({
          ruleId: 'field-required-missing',
          message: `Required field "${field.to}" reads "${field.from}", which this payload does not have, so the payload was not normalized.`,
          evidence: field.from,
          suggestion: `Correct the mapping's "from" pointer, or declare "required": false for "${field.to}".`,
        })
        ok = false
      } else {
        note({
          ruleId: 'field-optional-missing',
          message: `Optional field "${field.to}" reads "${field.from}", which this payload does not have, so the canonical event omits it.`,
          evidence: field.from,
        })
      }
      continue
    }

    if (!matchesType(at.value, field.as)) {
      note({
        ruleId: 'field-type-mismatch',
        message: `Field "${field.to}" reads "${field.from}", declared "${field.as}", and this payload has a ${kindOf(at.value)} there. This tool converts between types nowhere, so the payload was not normalized.`,
        evidence: field.from,
        suggestion: `Correct "as", or map the value explicitly with "values".`,
      })
      ok = false
      continue
    }

    let value = at.value
    if (field.as === 'string') {
      value = applyTransform(value, field.transform)
      if (field.values !== null) {
        if (!field.values.has(value)) {
          note({
            ruleId: 'field-value-unmapped',
            message: `Field "${field.to}" enumerates the source values it accepts and this payload carries one that is not among them, so the payload was not normalized rather than carried across unmapped.`,
            evidence: value.slice(0, 120),
            suggestion: `Add the value to "values" for "${field.to}", or correct the payload.`,
          })
          ok = false
          continue
        }
        value = field.values.get(value)
      }
    }

    if (typeof value === 'string') {
      if (value.length > limits.maxValueChars) {
        note({
          ruleId: 'limit-value-chars-exceeded',
          message: `Field "${field.to}" is ${value.length} characters, above the maxValueChars limit of ${limits.maxValueChars}. It was not truncated and the payload was not normalized.`,
          evidence: field.from,
          suggestion: 'Raise limits.maxValueChars, or map a shorter field.',
        })
        ok = false
        incomplete = true
        continue
      }
      value = clean(value, `data/${field.to}`)
    }
    data[field.to] = value
  }

  const claimed = [provider.versionAt, provider.typeAt, mapping.sourceId, ...mapping.fields.map((field) => field.from)]
  const walk = enumerateLeaves(payload, { maxDepth: limits.maxPayloadDepth, budget })
  if (!walk.ok) return { ok: false, rows, altered, budgetExhausted: true }
  if (walk.depthExceeded) {
    note({
      ruleId: 'limit-payload-depth-exceeded',
      message: `This payload nests deeper than the maxPayloadDepth limit of ${limits.maxPayloadDepth}. The fields below that depth were not examined, so whether they are unknown is not something this run established.`,
      suggestion: 'Raise limits.maxPayloadDepth, or flatten the fixture.',
    })
    incomplete = true
    ok = false
  }

  let unknown = walk.leaves.filter((leaf) => !claimed.some((path) => covers(path, leaf.pointer)))
  if (unknown.length > limits.maxUnknownFields) {
    note({
      ruleId: 'limit-unknown-fields-exceeded',
      message: `This payload has ${unknown.length} fields no mapping claims, above the maxUnknownFields limit of ${limits.maxUnknownFields}; the last ${unknown.length - limits.maxUnknownFields} are not in this report.`,
      suggestion: 'Raise limits.maxUnknownFields, or map the fields the canonical event needs.',
    })
    unknown = unknown.slice(0, limits.maxUnknownFields)
    incomplete = true
    ok = false
  }

  /**
   * Unknown fields, handled by the declared policy and never in silence.
   *
   * One finding per field, with a message that says only what the policy is and
   * the field's pointer in `evidence`. Keeping the pointer out of the message
   * is deliberate: it makes the evidence field the thing that distinguishes two
   * findings which are otherwise identical, so the report's last sort key is a
   * key a fixture can actually exercise.
   */
  const extensions = []
  for (const leaf of unknown) {
    if (!budget.spend()) return { ok: false, rows, altered, budgetExhausted: true }
    const where = clean(leaf.pointer, `extensions${leaf.pointer}`)
    if (mapping.unknownFields === 'reject') {
      note({
        ruleId: 'unknown-fields-rejected',
        message: 'This payload carries a field no mapping claims, and the mapping\'s unknownFields policy is "reject", so the payload was not normalized.',
        evidence: where,
        suggestion: 'Map the field, or change the mapping\'s "unknownFields" policy to "preserve" or "report".',
      })
      ok = false
      continue
    }
    if (mapping.unknownFields === 'report') {
      note({
        ruleId: 'unknown-fields-reported',
        message: 'This payload carries a field no mapping claims, and the mapping\'s unknownFields policy is "report", so it is named here and is not in the canonical event.',
        evidence: where,
        suggestion: 'Map the field, or change the policy to "preserve" to carry it under "extensions".',
      })
      continue
    }
    note({
      ruleId: 'unknown-fields-preserved',
      message: 'This payload carries a field no mapping claims, and the mapping\'s unknownFields policy is "preserve", so it is carried across under "extensions".',
      evidence: where,
    })
    let value = leaf.value
    if (typeof value === 'string') {
      if (value.length > limits.maxValueChars) {
        note({
          ruleId: 'limit-value-chars-exceeded',
          message: `An unclaimed field is ${value.length} characters, above the maxValueChars limit of ${limits.maxValueChars}. It was not truncated and the payload was not normalized.`,
          evidence: where,
          suggestion: 'Raise limits.maxValueChars, or drop the field with the "report" policy.',
        })
        ok = false
        incomplete = true
        continue
      }
      value = clean(value, `extensions${leaf.pointer}`)
    }
    extensions.push({ pointer: where, value })
  }

  const cleanType = clean(sourceType, 'source/type')
  const cleanVersion = clean(version, 'source/version')
  const cleanId = typeof rawId === 'string' ? clean(rawId, 'source/id') : rawId

  if (altered.length > 0) {
    note({
      ruleId: 'text-sanitised',
      message: `${altered.length} string(s) reaching output carried control, DEL, C1, line-separator or bidirectional formatting characters. Each was replaced with a space rather than emitted as written, and this finding is that record.`,
      evidence: altered[0],
      suggestion: 'Check the fixture: a control character in a payload string is usually an encoding accident, and sometimes not.',
    })
  }

  if (!ok) return { ok: false, rows, altered, incomplete }

  // ORDERING SITE 7 -- the key order of the canonical "data" object, which is
  // the key order of the emitted JSON. Pinned through the CLI.
  const ordered = {}
  for (const key of Object.keys(data).sort(byCodeUnit)) ordered[key] = data[key]

  return {
    ok: true,
    incomplete,
    rows,
    altered,
    event: {
      canonical: { version: canonicalVersion, type: mapping.canonicalType, data: ordered },
      source: { provider: provider.name, version: cleanVersion, type: cleanType, id: cleanId },
      ...(mapping.unknownFields === 'preserve' ? { extensions } : {}),
    },
  }
}

/**
 * Compare two canonical bodies, and name the first place they differ.
 *
 * The canonical body -- version, type and data -- is what "the same internal
 * shape" means. `source` and `extensions` are provenance and leftovers, and two
 * providers are expected to differ in both: that is the entire point of keeping
 * them separate from the canonical body.
 */
export function compareCanonical(left, right) {
  if (left.version !== right.version) return { equal: false, difference: 'version' }
  if (left.type !== right.type) return { equal: false, difference: 'type' }

  const keys = [...new Set([...Object.keys(left.data), ...Object.keys(right.data)])]
  // ORDERING SITE 10 -- which difference gets named first when several fields
  // differ. Pinned through the CLI in test/finding-order.test.mjs.
  keys.sort(byCodeUnit)

  for (const key of keys) {
    const here = Object.hasOwn(left.data, key) ? JSON.stringify(left.data[key]) : undefined
    const there = Object.hasOwn(right.data, key) ? JSON.stringify(right.data[key]) : undefined
    if (here !== there) return { equal: false, difference: `data/${escapeToken(key)}` }
  }
  return { equal: true }
}
