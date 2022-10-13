import assert from 'node:assert/strict'
import test from 'node:test'

import { POINTER_MAX_TOKENS, covers, createBudget, enumerateLeaves, escapeToken, parsePointer, readPointer, resolvePointer } from '../src/index.mjs'

test('the supported pointer grammar is accepted', () => {
  assert.deepEqual(parsePointer('/a'), { ok: true, tokens: ['a'] })
  assert.deepEqual(parsePointer('/a/b/c'), { ok: true, tokens: ['a', 'b', 'c'] })
  assert.deepEqual(parsePointer('/lines/0/sku'), { ok: true, tokens: ['lines', '0', 'sku'] })
  assert.deepEqual(parsePointer('/odd~1key'), { ok: true, tokens: ['odd/key'] })
  assert.deepEqual(parsePointer('/odd~0key'), { ok: true, tokens: ['odd~key'] })
  assert.deepEqual(parsePointer('/'), { ok: true, tokens: [''] }, 'an empty key is a real key')
})

test('everything outside the subset is refused with a reason, not silently missed', () => {
  assert.equal(parsePointer('').ok, false)
  assert.equal(parsePointer('a/b').ok, false)
  assert.equal(parsePointer('$.a.b').ok, false)
  assert.equal(parsePointer('/a/-').ok, false)
  assert.equal(parsePointer('/a/*').ok, false)
  assert.equal(parsePointer('/a~2b').ok, false)
  assert.equal(parsePointer(42).ok, false)
  assert.equal(parsePointer(`/${'a'.repeat(220)}`).ok, false)
  assert.equal(parsePointer(`/${'a/'.repeat(POINTER_MAX_TOKENS)}a`).ok, false)

  for (const bad of ['', 'a/b', '$.a.b', '/a/-', '/a/*', '/a~2b']) {
    assert.equal(typeof parsePointer(bad).reason, 'string', `${bad} must carry a reason`)
  }
})

test('escapeToken is the inverse of the escape the grammar accepts', () => {
  assert.equal(escapeToken('odd/key'), 'odd~1key')
  assert.equal(escapeToken('odd~key'), 'odd~0key')
  assert.equal(escapeToken('plain'), 'plain')
})

test('resolvePointer reads own properties only, through the objects that hold them', () => {
  const document = { a: { b: [10, 20] }, 'odd/key': 'x', nothing: null }

  assert.deepEqual(resolvePointer(document, ['a', 'b', '1']), { found: true, value: 20 })
  assert.deepEqual(resolvePointer(document, ['nothing']), { found: true, value: null })
  assert.deepEqual(resolvePointer(document, ['a', 'b', '2']), { found: false })
  assert.deepEqual(resolvePointer(document, ['a', 'b', 'length']), { found: false }, 'an array index must be an index')
  assert.deepEqual(resolvePointer(document, ['toString']), { found: false }, 'an inherited property is not a field')
  assert.deepEqual(resolvePointer(document, ['nothing', 'deeper']), { found: false })
  assert.deepEqual(readPointer(document, '/odd~1key'), { found: true, value: 'x' })
  assert.deepEqual(readPointer(document, '$.a'), { found: false })
})

test('a payload carrying __proto__ resolves to the value that is really there', () => {
  const document = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}')

  assert.deepEqual(resolvePointer(document, ['__proto__', 'polluted']), { found: true, value: true })
  assert.equal(Object.getPrototypeOf(document), Object.prototype)
  assert.equal({}.polluted, undefined)
})

test('enumerateLeaves returns every leaf, ordered by pointer, empty containers included', () => {
  const budget = createBudget(1000)
  const walk = enumerateLeaves({ b: 1, a: { z: 'x', y: [true, null] }, empty: {}, none: [] }, { maxDepth: 8, budget })

  assert.equal(walk.ok, true)
  assert.equal(walk.depthExceeded, false)
  assert.deepEqual(walk.leaves, [
    { pointer: '/a/y/0', value: true },
    { pointer: '/a/y/1', value: null },
    { pointer: '/a/z', value: 'x' },
    { pointer: '/b', value: 1 },
    { pointer: '/empty', value: '{}', empty: true },
    { pointer: '/none', value: '[]', empty: true },
  ])
})

test('the same data written with its keys in another order enumerates identically', () => {
  const first = enumerateLeaves({ a: 1, b: 2, c: 3 }, { maxDepth: 8, budget: createBudget(1000) })
  const second = enumerateLeaves({ c: 3, b: 2, a: 1 }, { maxDepth: 8, budget: createBudget(1000) })

  assert.deepEqual(first.leaves, second.leaves)
})

test('the depth bound reports rather than truncating, and the budget stops the walk', () => {
  const deep = { a: { b: { c: { d: 1 } } } }

  const shallow = enumerateLeaves(deep, { maxDepth: 2, budget: createBudget(1000) })
  assert.equal(shallow.ok, true)
  assert.equal(shallow.depthExceeded, true, 'the caller must be told, not handed a shorter list')

  const starved = enumerateLeaves(deep, { maxDepth: 8, budget: createBudget(2) })
  assert.equal(starved.ok, false)
  assert.equal(starved.reason, 'budget')
})

test('a walk of a deeply nested payload does not exhaust the call stack', () => {
  let node = { end: 1 }
  for (let index = 0; index < 20000; index += 1) node = { nested: node }

  const walk = enumerateLeaves(node, { maxDepth: 30000, budget: createBudget(200000) })
  assert.equal(walk.ok, true)
  assert.equal(walk.leaves.length, 1)
})

test('covers claims a pointer and everything beneath it, and nothing beside it', () => {
  assert.equal(covers('/data', '/data'), true)
  assert.equal(covers('/data', '/data/order_id'), true)
  assert.equal(covers('/data', '/data/customer/name'), true)
  assert.equal(covers('/data', '/database'), false)
  assert.equal(covers('/data/order_id', '/data'), false)
})
