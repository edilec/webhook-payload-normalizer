import assert from 'node:assert/strict'
import test from 'node:test'

import { TEXT_LIMIT, byCodeUnit, createBudget, decodeUtf8, joinRelative, sanitize, sanitizeValue } from '../src/index.mjs'

const CHAR = (code) => String.fromCharCode(code)

test('byCodeUnit orders by code unit, which is not how a locale orders', () => {
  assert.equal(byCodeUnit('Z', 'a') < 0, true)
  assert.equal(byCodeUnit('a-b', 'a_b') < 0, true)
  assert.equal(byCodeUnit('README', 'assets') < 0, true)
  assert.equal(byCodeUnit('a', 'a'), 0)
  assert.equal(byCodeUnit('b', 'a') > 0, true)
})

test('sanitize removes every class of dangerous character from report prose', () => {
  assert.equal(sanitize(`a${CHAR(0)}b`), 'a b')
  assert.equal(sanitize(`a${CHAR(10)}b`), 'a b')
  assert.equal(sanitize(`a${CHAR(27)}[31mb`), 'a [31mb')
  assert.equal(sanitize(`a${CHAR(31)}b`), 'a b')
  assert.equal(sanitize(`a${CHAR(127)}b`), 'a b')
  assert.equal(sanitize(`a${CHAR(133)}b`), 'a b', 'U+0085 NEL is a line break to many readers')
  assert.equal(sanitize(`a${CHAR(155)}b`), 'a b', 'U+009B is the 8-bit CSI')
  assert.equal(sanitize(`a${CHAR(0x2028)}b`), 'a b')
  assert.equal(sanitize(`a${CHAR(0x2029)}b`), 'a b')
  assert.equal(sanitize(`a${CHAR(0x200e)}b`), 'a b')
  assert.equal(sanitize(`a${CHAR(0x200f)}b`), 'a b')
  assert.equal(sanitize(`a${CHAR(0x202e)}b`), 'a b', 'U+202E reverses everything displayed after it')
  assert.equal(sanitize(`a${CHAR(0x2066)}b`), 'a b')
  assert.equal(sanitize(`a${CHAR(0x2069)}b`), 'a b')
})

test('sanitize bounds its output and marks where it cut', () => {
  const long = 'x'.repeat(TEXT_LIMIT + 40)

  assert.equal(sanitize(long).length, TEXT_LIMIT + 3)
  assert.equal(sanitize(long).endsWith('...'), true)
  assert.equal(sanitize('x'.repeat(TEXT_LIMIT)).length, TEXT_LIMIT)
  assert.equal(sanitize('short', 3), 'sho...')
})

test('sanitizeValue changes only the dangerous characters, and says when it did', () => {
  assert.deepEqual(sanitizeValue('  spaced  out  '), { text: '  spaced  out  ', changed: false })
  assert.deepEqual(sanitizeValue(`a${CHAR(133)}b`), { text: 'a b', changed: true })
  assert.deepEqual(sanitizeValue('plain'), { text: 'plain', changed: false })
  assert.equal(sanitizeValue('x'.repeat(1000)).text.length, 1000, 'length is a separate, explicit bound')
})

test('decodeUtf8 is the decoder\'s decision, never an inference from the text', () => {
  assert.deepEqual(decodeUtf8(Buffer.from('{"a":1}', 'utf8')), { ok: true, text: '{"a":1}' })
  assert.equal(decodeUtf8(Buffer.from([0xff, 0xfe])).ok, false)
  assert.equal(decodeUtf8(Buffer.from([0xc3, 0x28])).ok, false)

  // A payload that legitimately contains U+FFFD is still valid UTF-8, and a
  // tool that inferred "not UTF-8" from the decoded text would say otherwise.
  const withReplacement = decodeUtf8(Buffer.from(`{"a":"${CHAR(0xfffd)}"}`, 'utf8'))
  assert.equal(withReplacement.ok, true)
  assert.equal(withReplacement.text.includes(CHAR(0xfffd)), true)
})

test('joinRelative builds a label and nothing more', () => {
  assert.equal(joinRelative('events', 'a.json'), 'events/a.json')
  assert.equal(joinRelative('./events/', './a.json'), 'events/a.json')
  assert.equal(joinRelative('', 'a.json'), 'a.json')
  assert.equal(joinRelative('.', 'a.json'), 'a.json')
})

test('the work budget counts work and reports exhaustion rather than throwing', () => {
  const budget = createBudget(3)

  assert.equal(budget.spend(), true)
  assert.equal(budget.spend(), true)
  assert.equal(budget.spend(), true)
  assert.equal(budget.exhausted, false)
  assert.equal(budget.spend(), false)
  assert.equal(budget.exhausted, true)
  assert.equal(budget.spent, 4)
  assert.throws(() => createBudget(0), /positive integer/)
})
