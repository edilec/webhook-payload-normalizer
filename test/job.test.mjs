import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, HARD_LIMITS, applyLimits, validateJob } from '../src/index.mjs'

/**
 * The job is configuration, and configuration is validated as strictly as data.
 *
 * The point of most of these cases is the same one: a key nobody defined is
 * refused rather than ignored. `unknownfields` instead of `unknownFields` would
 * otherwise turn a `reject` policy into the default `preserve` with nothing
 * said, which is a real failure turned green by one character.
 */

const VALID = {
  canonicalVersion: '1',
  providers: [{ name: 'acme', versionAt: '/api_version', typeAt: '/event' }],
  mappings: [{
    provider: 'acme',
    version: '2',
    sourceType: 'order_created',
    canonicalType: 'order.created',
    sourceId: '/id',
    fields: [{ from: '/data/order_id', to: 'orderId', as: 'string' }],
  }],
  events: [{ ref: 'e1', provider: 'acme', payload: { id: 'A1' } }],
}

function rules(job, overrides) {
  return validateJob(job, overrides).problems.map((problem) => `${problem.ruleId} ${problem.pointer}`)
}

test('a valid job validates, and carries its defaults', () => {
  const result = validateJob(VALID)

  assert.equal(result.ok, true)
  assert.deepEqual(result.problems, [])
  assert.equal(result.value.unknownFields, 'preserve')
  assert.equal(result.value.eventsRoot, null)
  assert.deepEqual(result.limits, { ...DEFAULT_LIMITS })
})

test('a mapping source event name must remain identifiable after safe rendering', () => {
  assert.deepEqual(rules(VALID), [])
  for (const sourceType of ['order_created\u200e', '\u200e', 'order  created']) {
    assert.deepEqual(
      rules({ ...VALID, mappings: [{ ...VALID.mappings[0], sourceType }] }),
      ['job-invalid /mappings/0/sourceType'],
    )
  }
  const visible = { ...VALID, mappings: [{ ...VALID.mappings[0], sourceType: 'order created' }] }
  assert.deepEqual(rules(visible), [])
})

test('an unknown key is refused at every level of the schema', () => {
  assert.deepEqual(rules({ ...VALID, unknownfields: 'reject' }), ['job-unknown-key /'])
  assert.deepEqual(rules({ ...VALID, providers: [{ ...VALID.providers[0], versionat: '/v' }] }), ['job-unknown-key /providers/0'])
  assert.deepEqual(rules({ ...VALID, mappings: [{ ...VALID.mappings[0], unknownfields: 'reject' }] }), ['job-unknown-key /mappings/0'])
  assert.deepEqual(
    rules({ ...VALID, mappings: [{ ...VALID.mappings[0], fields: [{ from: '/a', to: 'a', as: 'string', Required: false }] }] }),
    ['job-unknown-key /mappings/0/fields/0'],
  )
  assert.deepEqual(rules({ ...VALID, events: [{ ...VALID.events[0], Version: '2' }] }), ['job-unknown-key /events/0'])
  assert.deepEqual(
    rules({ ...VALID, equivalence: [{ id: 'g', refs: ['e1', 'e1'], note: 'x' }] }),
    ['job-unknown-key /equivalence/0'],
  )
  assert.deepEqual(rules({ ...VALID, limits: { maxEvent: 5 } }), ['job-unknown-key /limits'])
})

test('the shape of every declared field is checked', () => {
  assert.deepEqual(rules({ ...VALID, canonicalVersion: 1 }), ['job-invalid /canonicalVersion'])
  assert.deepEqual(rules({ ...VALID, unknownFields: 'ignore' }), ['job-invalid /unknownFields'])
  assert.deepEqual(rules({ ...VALID, eventsRoot: '/absolute' }), ['job-invalid /eventsRoot'])
  assert.deepEqual(rules({ ...VALID, providers: [] }), ['job-invalid /providers', 'job-invalid /mappings/0/provider'])
  assert.deepEqual(rules({ ...VALID, providers: [VALID.providers[0], VALID.providers[0]] }), ['job-invalid /providers/1/name'])
  assert.deepEqual(rules({ ...VALID, mappings: [{ ...VALID.mappings[0], provider: 'ghost' }] }), ['job-invalid /mappings/0/provider'])
  assert.deepEqual(rules({ ...VALID, mappings: [{ ...VALID.mappings[0], version: '' }] }), ['job-invalid /mappings/0/version'])
  assert.deepEqual(rules({ ...VALID, mappings: [{ ...VALID.mappings[0], fields: [] }] }), ['job-invalid /mappings/0/fields'])
  assert.deepEqual(rules({ ...VALID, events: [{ ...VALID.events[0], ref: 'has space' }] }), ['job-invalid /events/0/ref'])
  assert.deepEqual(
    rules({ ...VALID, events: [VALID.events[0], { ...VALID.events[0] }] }),
    ['job-invalid /events/1/ref'],
  )
})

test('a fixture declares exactly one of file and payload, and a file needs a root', () => {
  assert.deepEqual(rules({ ...VALID, events: [{ ref: 'e1', provider: 'acme' }] }), ['job-invalid /events/0'])
  assert.deepEqual(
    rules({ ...VALID, events: [{ ref: 'e1', provider: 'acme', file: 'a.json', payload: {} }] }),
    ['job-invalid /events/0'],
  )
  assert.deepEqual(rules({ ...VALID, events: [{ ref: 'e1', provider: 'acme', file: 'a.json' }] }), ['job-invalid /eventsRoot'])
  assert.deepEqual(
    rules({ ...VALID, eventsRoot: 'events', events: [{ ref: 'e1', provider: 'acme', file: '/etc/passwd' }] }),
    ['job-invalid /events/0/file'],
  )
})

test('an unsupported pointer is its own rule, because it is not an absent field', () => {
  assert.deepEqual(rules({ ...VALID, providers: [{ name: 'acme', versionAt: '$.v', typeAt: '/event' }] }), [
    'mapping-unsupported-construct /providers/0/versionAt',
    'job-invalid /mappings/0/provider',
  ])
  assert.deepEqual(
    rules({ ...VALID, mappings: [{ ...VALID.mappings[0], sourceId: 'id' }] }),
    ['mapping-unsupported-construct /mappings/0/sourceId'],
  )
  assert.deepEqual(
    rules({ ...VALID, mappings: [{ ...VALID.mappings[0], fields: [{ from: '/a', to: 'a', as: 'decimal' }] }] }),
    ['mapping-unsupported-construct /mappings/0/fields/0/as'],
  )
  assert.deepEqual(
    rules({ ...VALID, mappings: [{ ...VALID.mappings[0], fields: [{ from: '/a', to: 'a', as: 'string', transform: 'titlecase' }] }] }),
    ['mapping-unsupported-construct /mappings/0/fields/0/transform'],
  )
})

test('two mappings claiming one (provider, version, event) is a refusal, not a race', () => {
  assert.deepEqual(
    rules({ ...VALID, mappings: [VALID.mappings[0], { ...VALID.mappings[0], canonicalType: 'order.placed' }] }),
    ['mapping-duplicate /mappings/1'],
  )
})

test('an equivalence group must name at least two fixtures this job declares', () => {
  assert.deepEqual(rules({ ...VALID, equivalence: [{ id: 'g', refs: ['e1'] }] }), ['job-invalid /equivalence/0/refs'])
  assert.deepEqual(rules({ ...VALID, equivalence: [{ id: 'g', refs: ['e1', 'ghost'] }] }), ['job-invalid /equivalence/0/refs/1'])
  assert.deepEqual(
    rules({ ...VALID, equivalence: [{ id: 'g', refs: ['e1', 'e1'] }, { id: 'g', refs: ['e1', 'e1'] }] }),
    ['job-invalid /equivalence/1/id'],
  )
})

test('values enumerates source strings, so it needs a string source and a real mapping', () => {
  assert.deepEqual(
    rules({ ...VALID, mappings: [{ ...VALID.mappings[0], fields: [{ from: '/a', to: 'a', as: 'integer', values: { '1': 1 } }] }] }),
    ['job-invalid /mappings/0/fields/0/values'],
  )
  assert.deepEqual(
    rules({ ...VALID, mappings: [{ ...VALID.mappings[0], fields: [{ from: '/a', to: 'a', as: 'string', values: {} }] }] }),
    ['job-invalid /mappings/0/fields/0/values'],
  )
  assert.deepEqual(
    rules({ ...VALID, mappings: [{ ...VALID.mappings[0], fields: [{ from: '/a', to: 'a', as: 'string', values: { x: { deep: 1 } } }] }] }),
    ['job-invalid /mappings/0/fields/0/values'],
  )
})

test('a non-finite value-map entry names its member ordinal without echoing its key', () => {
  const job = structuredClone(VALID)
  job.mappings[0].fields[0].values = { 'token=SYNTHETIC_SECRET_CANARY': Number.POSITIVE_INFINITY }
  const result = validateJob(job)
  const problem = result.problems.find((row) => row.pointer === '/mappings/0/fields/0/values')
  assert.ok(problem)
  assert.equal(problem.ruleId, 'job-invalid')
  assert.match(problem.message, /member ordinal 1/u)
  assert.equal(JSON.stringify(result.problems).includes('SYNTHETIC_SECRET_CANARY'), false)
})

test('a limit may be lowered or raised to its ceiling, and no further', () => {
  const problems = []

  assert.equal(applyLimits({ maxEvents: 1 }, problems).maxEvents, 1)
  assert.equal(applyLimits({ maxEvents: HARD_LIMITS.maxEvents }, problems).maxEvents, HARD_LIMITS.maxEvents)
  assert.deepEqual(problems, [])

  assert.equal(applyLimits({ maxEvents: HARD_LIMITS.maxEvents + 1 }, problems).maxEvents, DEFAULT_LIMITS.maxEvents)
  assert.equal(problems.length, 1)
  assert.equal(problems[0].pointer, '/limits/maxEvents')

  applyLimits({ maxEvents: 0 }, problems)
  applyLimits({ maxEvents: 1.5 }, problems)
  applyLimits('nope', problems)
  assert.equal(problems.length, 4)
})

test('a caller override reaches the validator, which is where the bound is applied', () => {
  const job = {
    ...VALID,
    events: [
      { ref: 'one', provider: 'acme', payload: { id: 'A1' } },
      { ref: 'two', provider: 'acme', payload: { id: 'A2' } },
    ],
  }

  assert.equal(validateJob(job).value.events.length, 2)
  assert.equal(validateJob(job, { maxEvents: 1 }).value.events.length, 1)
  assert.deepEqual(rules(job, { maxEvents: 1 }), ['limit-events-exceeded /events'])
  assert.equal(validateJob(job, { maxEvents: 1 }).ok, true, 'a fixture set that was cut short is still examined as far as it went')
})

test('a job that is not an object is refused before anything else is read', () => {
  assert.deepEqual(rules(null), ['job-invalid /'])
  assert.deepEqual(rules([VALID]), ['job-invalid /'])
  assert.deepEqual(rules('{}'), ['job-invalid /'])
})
