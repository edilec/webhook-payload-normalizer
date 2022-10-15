import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MAX_JOB_BYTES, normalizeJob, normalizeJobFile } from '../src/index.mjs'

/**
 * Every documented bound, from both sides.
 *
 * A limit tested only from above is half a test: it says the tool complains
 * when the input is too large and says nothing about whether the bound is where
 * the documentation claims. Each case below therefore runs the input that sits
 * exactly on the bound and expects silence, then adds one and expects a
 * finding -- and the finding names the limit, because a bound that was hit is
 * never a smaller answer quietly given.
 */

const PROVIDER = { name: 'acme', versionAt: '/api_version', typeAt: '/event' }

function mapping(sourceType = 'order_created') {
  return {
    provider: 'acme',
    version: '2',
    sourceType,
    canonicalType: 'order.created',
    sourceId: '/id',
    fields: [{ from: '/data/order_id', to: 'orderId', as: 'string' }],
  }
}

function payload(extra = {}) {
  return { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' }, ...extra }
}

function job(events, mappings = [mapping()]) {
  return { canonicalVersion: '1', providers: [PROVIDER], mappings, events }
}

function raised(report, ruleId) {
  return report.findings.filter((finding) => finding.ruleId === ruleId).length
}

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'webhook-payload-normalizer-limits-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

test('maxEvents: the bound passes, one more is reported and not silently dropped', async () => {
  const two = [
    { ref: 'one', provider: 'acme', payload: payload() },
    { ref: 'two', provider: 'acme', payload: { ...payload(), id: 'A2' } },
  ]

  const atBound = await normalizeJob(job(two), { limits: { maxEvents: 2 } })
  assert.equal(atBound.status, 'pass')
  assert.equal(raised(atBound, 'limit-events-exceeded'), 0)
  assert.equal(atBound.summary.normalized, 2)

  const overBound = await normalizeJob(job(two), { limits: { maxEvents: 1 } })
  assert.equal(overBound.status, 'incomplete')
  assert.equal(raised(overBound, 'limit-events-exceeded'), 1)
  assert.equal(overBound.summary.normalized, 1)
})

test('maxMappings: the bound passes, one more refuses the job', async () => {
  const two = [mapping('order_created'), mapping('order_cancelled')]

  const atBound = await normalizeJob(job([{ ref: 'one', provider: 'acme', payload: payload() }], two), { limits: { maxMappings: 2 } })
  assert.equal(atBound.status, 'pass')
  assert.equal(raised(atBound, 'limit-mappings-exceeded'), 0)

  const overBound = await normalizeJob(job([{ ref: 'one', provider: 'acme', payload: payload() }], two), { limits: { maxMappings: 1 } })
  assert.equal(overBound.status, 'incomplete')
  assert.equal(raised(overBound, 'limit-mappings-exceeded'), 1)
})

test('maxPayloadDepth: the bound passes, one level deeper is reported', async () => {
  const deep = { ref: 'deep', provider: 'acme', payload: payload({ data: { order_id: 'O1', customer: { name: 'Northwind Trading' } } }) }

  const atBound = await normalizeJob(job([deep]), { limits: { maxPayloadDepth: 3 } })
  assert.equal(atBound.status, 'pass')
  assert.equal(raised(atBound, 'limit-payload-depth-exceeded'), 0)

  const overBound = await normalizeJob(job([deep]), { limits: { maxPayloadDepth: 2 } })
  assert.equal(overBound.status, 'incomplete')
  assert.equal(raised(overBound, 'limit-payload-depth-exceeded'), 1)
  assert.equal(overBound.summary.normalized, 0, 'a payload examined only part of the way down is not normalized')
})

test('maxUnknownFields: the bound passes, one more is reported', async () => {
  const extras = { ref: 'extras', provider: 'acme', payload: payload({ one: 1, two: 2 }) }

  const atBound = await normalizeJob(job([extras]), { limits: { maxUnknownFields: 2 } })
  assert.equal(atBound.status, 'pass')
  assert.equal(raised(atBound, 'limit-unknown-fields-exceeded'), 0)
  assert.equal(atBound.normalization.events[0].extensions.length, 2)

  const overBound = await normalizeJob(job([extras]), { limits: { maxUnknownFields: 1 } })
  assert.equal(overBound.status, 'incomplete')
  assert.equal(raised(overBound, 'limit-unknown-fields-exceeded'), 1)
})

test('maxValueChars: the bound passes, one character more is reported and not truncated', async () => {
  const eight = { ref: 'eight', provider: 'acme', payload: payload({ data: { order_id: 'ORD-5521' } }) }

  const atBound = await normalizeJob(job([eight]), { limits: { maxValueChars: 8 } })
  assert.equal(atBound.status, 'pass')
  assert.equal(atBound.normalization.events[0].canonical.data.orderId, 'ORD-5521')

  const overBound = await normalizeJob(job([eight]), { limits: { maxValueChars: 7 } })
  assert.equal(overBound.status, 'incomplete')
  assert.equal(raised(overBound, 'limit-value-chars-exceeded'), 1)
  assert.equal(overBound.summary.normalized, 0, 'the value is never shortened to fit')
})

test('maxFindings: the bound passes, one more truncates explicitly', async () => {
  const extras = [{ ref: 'extras', provider: 'acme', payload: payload({ one: 1, two: 2 }) }]

  const atBound = await normalizeJob(job(extras), { limits: { maxFindings: 2 } })
  assert.equal(atBound.status, 'pass')
  assert.equal(atBound.findings.length, 2)

  const overBound = await normalizeJob(job(extras), { limits: { maxFindings: 1 } })
  assert.equal(overBound.status, 'incomplete')
  assert.equal(overBound.findings.length, 1)
  assert.equal(overBound.findings[0].ruleId, 'limit-findings-exceeded')
})

test('maxSteps: a budget that covers the work passes, a smaller one stops and says so', async () => {
  const events = [{ ref: 'one', provider: 'acme', payload: payload() }]

  const generous = await normalizeJob(job(events), { limits: { maxSteps: 1000 } })
  assert.equal(generous.status, 'pass')
  assert.equal(raised(generous, 'limit-steps-exceeded'), 0)

  const exact = await normalizeJob(job(events), { limits: { maxSteps: generous.summary.steps } })
  assert.equal(exact.status, 'pass', 'the bound itself is enough')
  assert.equal(raised(exact, 'limit-steps-exceeded'), 0)

  const starved = await normalizeJob(job(events), { limits: { maxSteps: generous.summary.steps - 1 } })
  assert.equal(starved.status, 'incomplete')
  assert.equal(raised(starved, 'limit-steps-exceeded'), 1)
})

test('maxPayloadBytes: the bound passes, one byte more is not read at all', async () => {
  await withBase(async (base) => {
    await mkdir(join(base, 'events'))
    const body = JSON.stringify(payload())
    await writeFile(join(base, 'events', 'fixture.json'), body)
    const jobPath = join(base, 'job.json')
    await writeFile(jobPath, JSON.stringify({
      canonicalVersion: '1',
      eventsRoot: 'events',
      providers: [PROVIDER],
      mappings: [mapping()],
      events: [{ ref: 'one', provider: 'acme', file: 'fixture.json' }],
    }))

    const atBound = await normalizeJobFile(jobPath, { limits: { maxPayloadBytes: Buffer.byteLength(body) } })
    assert.equal(atBound.status, 'pass')
    assert.equal(raised(atBound, 'limit-payload-bytes-exceeded'), 0)

    const overBound = await normalizeJobFile(jobPath, { limits: { maxPayloadBytes: Buffer.byteLength(body) - 1 } })
    assert.equal(overBound.status, 'incomplete')
    assert.equal(raised(overBound, 'limit-payload-bytes-exceeded'), 1)
    assert.equal(overBound.summary.checked, 0)
  })
})

test('the job file bound: exactly at it the job is parsed, one byte over it is not', async () => {
  await withBase(async (base) => {
    const body = {
      canonicalVersion: '1',
      providers: [PROVIDER],
      mappings: [mapping()],
      events: [{ ref: 'one', provider: 'acme', payload: payload() }],
    }
    const compact = JSON.stringify(body)
    const padding = MAX_JOB_BYTES - Buffer.byteLength(compact)

    const atBound = join(base, 'at-bound.json')
    await writeFile(atBound, `${compact.slice(0, -1)}${' '.repeat(padding)}}`)
    assert.equal((await normalizeJobFile(atBound)).status, 'pass')

    const overBound = join(base, 'over-bound.json')
    await writeFile(overBound, `${compact.slice(0, -1)}${' '.repeat(padding + 1)}}`)
    const report = await normalizeJobFile(overBound)
    assert.equal(report.status, 'incomplete')
    assert.equal(raised(report, 'limit-job-bytes-exceeded'), 1)
  })
})

test('a bound that was hit never reports a smaller answer as the whole answer', async () => {
  const report = await normalizeJob(
    job([
      { ref: 'one', provider: 'acme', payload: payload() },
      { ref: 'two', provider: 'acme', payload: { ...payload(), id: 'A2' } },
      { ref: 'three', provider: 'acme', payload: { ...payload(), id: 'A3' } },
    ]),
    { limits: { maxEvents: 2 } },
  )

  assert.equal(report.status, 'incomplete')
  assert.notEqual(report.status, 'pass')
  assert.equal(report.summary.normalized, 2)
  assert.equal(report.findings.some((finding) => finding.message.includes('maxEvents')), true, 'the finding names the limit')
})
