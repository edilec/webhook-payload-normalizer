/**
 * webhook-payload-normalizer -- text handling for everything untrusted.
 *
 * A provider fixture is untrusted input. Its event ids, type names, object
 * keys, field values and file paths all reach the report or the canonical
 * event, and every one of them passes through this module first. Nothing here
 * touches the filesystem, the clock, the locale or the network.
 */

/**
 * Order by UTF-16 code unit.
 *
 * Never a locale-aware comparison, under any of its spellings. `localeCompare`
 * and `Intl.Collator` collate identically and depend on the ICU data compiled
 * into whichever Node build happens to run, so both drift the same way and a
 * source grep for one of them catches neither. `Z` must precede `a`, `a-b` must
 * precede `a_b`, and `README` must precede `assets`, on every machine, for
 * ever.
 *
 * Pinning this function is not pinning the tool: each of the ten call sites can
 * be swapped on its own. `test/finding-order.test.mjs` drives values whose
 * collation order and code-unit order disagree through the real binary at every
 * site, and enumerates the one site whose alphabet makes both orders identical.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * The characters removed from every untrusted string before it reaches output.
 *
 * Written as escapes rather than literally, because a literal U+2028 inside a
 * module is a hazard of its own. Five classes, each for a reason a reader of
 * the report would care about:
 *
 * - C0 and DEL: a newline forges a report line, an ESC opens a terminal escape
 *   sequence.
 * - C1, half-forgotten and twice as dangerous: U+0085 NEL is a line break to a
 *   great many readers, and U+009B is the 8-bit form of CSI, so it opens a
 *   terminal control sequence with no ESC in sight.
 * - The line and paragraph separators, which JSON.stringify does not escape.
 * - The bidirectional formatting characters. U+202E RIGHT-TO-LEFT OVERRIDE
 *   reverses everything displayed after it, so a provider event id can be made
 *   to read as something else entirely while the bytes say otherwise.
 *
 * This is applied to identifiers, not only to excerpts. A provider name or an
 * event id carrying U+0085 forges a report line exactly as well as an evidence
 * excerpt would, and identifiers are what this tool prints most.
 */
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

export const TEXT_LIMIT = 160

/**
 * A bounded, single-line, control-free rendering of an untrusted string, for
 * report prose: messages, evidence, labels, pointers.
 *
 * Every removed character becomes a space rather than vanishing, so two ids
 * that differ only by a stripped character do not silently become one string.
 */
export function sanitize(value, limit = TEXT_LIMIT) {
  const flattened = String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/**
 * The same strip set applied to a *data* string on its way into a canonical
 * event or an extensions entry, and a flag saying whether anything changed.
 *
 * Data is not prose. Whitespace is not collapsed, nothing is trimmed and
 * nothing is truncated here, because all three would alter a payload value the
 * caller asked to be carried through. Only the dangerous characters change --
 * and when any of them does, the caller raises `text-sanitised`, so an altered
 * value is never a silent one. Length is a separate, explicit bound.
 */
export function sanitizeValue(value) {
  const original = String(value)
  const cleaned = original.replace(CONTROL, ' ')
  return { text: cleaned, changed: cleaned !== original }
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the entire point. Decoding leniently and then hunting for a
 * replacement character cannot tell undecodable bytes from a fixture that
 * legitimately contains one, and that confusion is exactly how an unreadable
 * input comes to report a pass. Every byte source in this tool goes through
 * here, the job file included -- a tool that hardens its data path and leaves
 * its own configuration path lossy has hardened nothing.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

/**
 * Join a declared root and a declared relative path into one display path.
 *
 * Both halves come from the job, and the result is only ever a label: it is
 * never resolved, opened, or compared against a real path. Containment is
 * decided on real paths elsewhere.
 */
export function joinRelative(root, file) {
  const left = String(root).replace(/^\.\/+/, '').replace(/\/+$/, '')
  const right = String(file).replace(/^\.\/+/, '')
  if (left === '' || left === '.') return right
  return `${left}/${right}`
}

/**
 * A deterministic work budget.
 *
 * This tool has no wall-clock timeout, deliberately. A deadline measured
 * against `Date.now` makes the report a function of machine speed and load: the
 * same bytes would produce `incomplete` on a busy laptop and `pass` in CI, and
 * "unknown is never a pass" would become "unknown is a pass when the machine is
 * fast enough". The bound is on work instead -- nodes visited, fields resolved,
 * comparisons made -- so a run that is too large is too large everywhere, and
 * two runs over the same bytes always agree.
 */
export function createBudget(maxSteps) {
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new TypeError('A step budget must be a positive integer')
  let spent = 0
  return {
    get spent() {
      return spent
    },
    get exhausted() {
      return spent > maxSteps
    },
    /** Spend `amount` steps; false once the budget is past its bound. */
    spend(amount = 1) {
      spent += amount
      return spent <= maxSteps
    },
  }
}
