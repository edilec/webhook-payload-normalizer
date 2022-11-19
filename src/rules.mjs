/**
 * webhook-payload-normalizer -- the rules, and the one table that pins them.
 *
 * Severity is the whole difference between a run that fails and one that
 * passes. Written as a literal at each construction site it drifts silently,
 * and demoting `mapping-version-unknown` to a warning turns "this payload was
 * refused because nobody has written rules for its version" into a green build
 * that normalized nothing.
 *
 * So there is exactly one table, every finding takes its severity from it, and
 * an unknown rule id throws rather than defaulting. The table is the source of
 * truth -- it is not the test. `test/severity-decides.test.mjs` and
 * `test/severity-incomplete.test.mjs` drive real fixtures through the real
 * binary and pin exit code, status and the counted errors, warnings and info,
 * because three declarations agreeing with each other can be edited together
 * and an exit code cannot be edited at all.
 */

import { TEXT_LIMIT, byCodeUnit, sanitize } from './text.mjs'

export const RULE_SEVERITY = Object.freeze({
  'equivalence-confirmed': 'info',
  'equivalence-mismatch': 'error',
  'equivalence-unresolved': 'error',
  'event-file-not-json': 'error',
  'event-file-not-utf8': 'error',
  'event-file-outside-root': 'error',
  'event-file-unreadable': 'error',
  'event-type-unresolved': 'error',
  'event-version-conflict': 'error',
  'event-version-unresolved': 'error',
  'field-optional-missing': 'info',
  'field-required-missing': 'error',
  'field-type-mismatch': 'error',
  'field-value-unmapped': 'error',
  'job-invalid': 'error',
  'job-not-json': 'error',
  'job-not-utf8': 'error',
  'job-unknown-key': 'error',
  'job-unreadable': 'error',
  'limit-events-exceeded': 'error',
  'limit-findings-exceeded': 'error',
  'limit-job-bytes-exceeded': 'error',
  'limit-mappings-exceeded': 'error',
  'limit-payload-bytes-exceeded': 'error',
  'limit-payload-depth-exceeded': 'error',
  'limit-steps-exceeded': 'error',
  'limit-unknown-fields-exceeded': 'error',
  'limit-value-chars-exceeded': 'error',
  'mapping-duplicate': 'error',
  'mapping-event-unknown': 'error',
  'mapping-unsupported-construct': 'error',
  'mapping-unused': 'info',
  'mapping-version-unknown': 'error',
  'no-events-checked': 'error',
  'output-unwritable': 'error',
  'output-withheld': 'warning',
  'provider-unknown': 'error',
  'source-id-missing': 'error',
  'text-sanitised': 'warning',
  'unknown-fields-preserved': 'info',
  'unknown-fields-rejected': 'error',
  'unknown-fields-reported': 'warning',
})

export const SEVERITY_VALUES = Object.freeze(['error', 'warning', 'info'])

/**
 * The error rules whose severity is the only thing standing between the run and
 * a pass.
 *
 * Every other error rule also sets the `incomplete` flag, so it exits 2
 * whatever its severity says. These twelve have no second line of defence:
 * demote one and a refused payload becomes a green build.
 */
export const SEVERITY_DECIDES = Object.freeze([
  'equivalence-mismatch',
  'event-file-outside-root',
  'event-version-conflict',
  'field-required-missing',
  'field-type-mismatch',
  'field-value-unmapped',
  'mapping-event-unknown',
  'mapping-version-unknown',
  'output-unwritable',
  'provider-unknown',
  'source-id-missing',
  'unknown-fields-rejected',
])

const MESSAGE_LIMIT = 400
const PATH_LIMIT = 200

/**
 * Build one finding, taking its severity from the single table.
 *
 * Every untrusted string is sanitised here -- the file label and the pointer as
 * much as the message and the evidence. A provider event id carrying a newline
 * would otherwise forge whole lines in the human report, and a report a reader
 * cannot trust line by line is worse than no report at all.
 */
export function createFinding(row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) {
    throw new Error(
      `Rule "${sanitize(row.ruleId, 80)}" is not in RULE_SEVERITY; add it to the table and to docs/normalization-rules.md.`,
    )
  }
  const finding = {
    ruleId: row.ruleId,
    severity,
    message: sanitize(row.message, MESSAGE_LIMIT),
    location: { file: sanitize(row.file, PATH_LIMIT), pointer: sanitize(row.pointer, PATH_LIMIT) },
  }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = sanitize(row.evidence, TEXT_LIMIT)
  if (row.suggestion !== undefined) finding.suggestion = sanitize(row.suggestion, MESSAGE_LIMIT)
  return finding
}

/**
 * The documented sort key: file, pointer, ruleId, message, evidence.
 *
 * Every comparison is by code unit. The pointer is compared as the string it
 * is, so `/events/10` precedes `/events/2` -- unlovely, and deterministic,
 * which is the property that matters. The normalized events themselves are
 * emitted in declared order, which is not a comparison at all.
 */
export function compareFindings(left, right) {
  // ORDERING SITES 1-5. Each is swappable on its own, and each is driven
  // through the real binary in test/finding-order.test.mjs.
  return (
    byCodeUnit(left.location.file, right.location.file) ||
    byCodeUnit(left.location.pointer, right.location.pointer) ||
    byCodeUnit(left.ruleId, right.ruleId) ||
    byCodeUnit(left.message, right.message) ||
    byCodeUnit(left.evidence ?? '', right.evidence ?? '')
  )
}

/** Findings in the documented order. The input array is not mutated. */
export function sortFindings(findings) {
  return [...findings].sort(compareFindings)
}
