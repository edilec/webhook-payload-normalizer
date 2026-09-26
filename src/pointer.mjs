/**
 * webhook-payload-normalizer -- the JSON Pointer subset this tool supports,
 * and the leaf walk that finds fields no mapping claimed.
 *
 * The subset is bounded on purpose and declared rather than assumed. Anything
 * outside it is reported as an unsupported construct and makes the run
 * incomplete; it is never treated as "did not match", because a pointer the
 * tool did not understand is not evidence that the field was absent.
 */

import { byCodeUnit } from './text.mjs'

/** The longest pointer this tool will parse, in characters. */
export const POINTER_MAX_LENGTH = 200

/** The deepest pointer this tool will parse, in tokens. */
export const POINTER_MAX_TOKENS = 32

/**
 * The supported grammar, stated so a reader never has to infer it:
 *
 * - `/token/token/...`, RFC 6901, with `~1` for `/` and `~0` for `~`.
 * - A numeric token addresses an array element by index.
 * - The empty pointer (the whole document) is **not** supported as a mapping
 *   source: a canonical field whose value is the entire payload is a mapping
 *   nobody meant to write.
 * - The RFC 6901 `-` token (one past the end of an array) is **not** supported:
 *   it exists for adding elements, and there is nothing there to read.
 * - A relative pointer, a JSONPath expression, a wildcard, a filter and a
 *   dotted path are all outside the subset.
 */
export function parsePointer(pointer) {
  if (typeof pointer !== 'string') return { ok: false, reason: 'a pointer must be a string' }
  if (pointer === '') return { ok: false, reason: 'the empty pointer (the whole document) is not a supported mapping source' }
  if (!pointer.startsWith('/')) {
    return { ok: false, reason: 'only absolute RFC 6901 pointers beginning with "/" are supported (no JSONPath, no dotted path, no relative pointer)' }
  }
  if (pointer.length > POINTER_MAX_LENGTH) return { ok: false, reason: `a pointer may be at most ${POINTER_MAX_LENGTH} characters` }

  const raw = pointer.slice(1).split('/')
  if (raw.length > POINTER_MAX_TOKENS) return { ok: false, reason: `a pointer may have at most ${POINTER_MAX_TOKENS} tokens` }

  const tokens = []
  for (const piece of raw) {
    if (piece === '-') return { ok: false, reason: 'the "-" token (one past the end of an array) is not a supported mapping source' }
    if (piece === '*') return { ok: false, reason: 'wildcard tokens are not supported; name each field explicitly' }
    if (/~(?![01])/.test(piece)) return { ok: false, reason: 'an escape in a pointer token must be "~0" or "~1"' }
    tokens.push(piece.replace(/~1/g, '/').replace(/~0/g, '~'))
  }
  return { ok: true, tokens }
}

/** Escape one object key or array index into a pointer token. */
export function escapeToken(token) {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1')
}

const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/

/**
 * Resolve parsed tokens against a document.
 *
 * `{ found: false }` means the path is genuinely absent. A property is read
 * through its own descriptor, so a payload carrying a `__proto__` or
 * `constructor` key resolves to the value that is really there rather than to
 * something inherited from the prototype chain.
 */
export function resolvePointer(document, tokens) {
  let node = document
  for (const token of tokens) {
    if (Array.isArray(node)) {
      if (!ARRAY_INDEX.test(token)) return { found: false }
      const index = Number(token)
      if (index >= node.length) return { found: false }
      node = node[index]
      continue
    }
    if (node === null || typeof node !== 'object') return { found: false }
    const descriptor = Object.getOwnPropertyDescriptor(node, token)
    if (descriptor === undefined || !('value' in descriptor)) return { found: false }
    node = descriptor.value
  }
  return { found: true, value: node }
}

/** Parse and resolve in one step, for a pointer already known to be supported. */
export function readPointer(document, pointer) {
  const parsed = parsePointer(pointer)
  if (!parsed.ok) return { found: false }
  return resolvePointer(document, parsed.tokens)
}

/**
 * Every leaf in a document, as `{ pointer, value }`, ordered by pointer.
 *
 * A leaf is a scalar or an empty container: an empty object and an empty array
 * are leaves because they are the deepest thing at that path, and dropping them
 * would make "this field was present but empty" indistinguishable from "this
 * field was absent".
 *
 * The walk is iterative over an explicit stack. A recursive walk over a payload
 * built to nest ten thousand deep would exhaust the call stack, which is the
 * failure the depth bound exists to replace with a finding. Both bounds report
 * rather than truncate: `depthExceeded` and an exhausted budget are answers the
 * caller turns into findings, never a shorter list presented as the whole.
 *
 * The result is sorted by code unit. Object key order is the order the keys
 * appeared in the JSON text, so two payloads that differ only in key order
 * would otherwise produce two different reports for the same data.
 */
export function enumerateLeaves(document, { maxDepth, budget }) {
  const leaves = []
  const stack = [{ node: document, depth: 0, pointer: '' }]
  let depthExceeded = false

  while (stack.length > 0) {
    if (!budget.spend()) return { ok: false, reason: 'budget', leaves: [], depthExceeded }
    const { node, depth, pointer } = stack.pop()

    if (node === null || typeof node !== 'object') {
      leaves.push({ pointer, value: node })
      continue
    }
    const keys = Array.isArray(node) ? node.map((_, index) => String(index)) : Object.keys(node)
    if (keys.length === 0) {
      leaves.push({ pointer, value: Array.isArray(node) ? '[]' : '{}', empty: true })
      continue
    }
    if (depth + 1 > maxDepth) {
      depthExceeded = true
      continue
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key)
      if (descriptor === undefined || !('value' in descriptor)) continue
      stack.push({ node: descriptor.value, depth: depth + 1, pointer: `${pointer}/${escapeToken(key)}` })
    }
  }

  // ORDERING SITE 6 -- the order extensions entries and unknown-field evidence
  // are emitted in. Pinned through the CLI in test/finding-order.test.mjs.
  leaves.sort((left, right) => byCodeUnit(left.pointer, right.pointer))
  return { ok: true, leaves, depthExceeded }
}

/**
 * Whether `claimed` covers `leaf`: the same pointer, or an ancestor of it.
 *
 * A mapping that reads `/data` consumes every leaf beneath `/data`, so a
 * mapping which carries a whole sub-object across does not then report each of
 * that object's fields as unknown.
 */
export function covers(claimed, leaf) {
  return leaf === claimed || leaf.startsWith(`${claimed}/`)
}
