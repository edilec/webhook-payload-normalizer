import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { exitCodeFor, normalizeJob, normalizeJobFile } from '../src/index.mjs'

/**
 * "Unknown is never a pass", checked at every path that could say otherwise.
 *
 * Each `incomplete = true` in this tool needs a test that fails when it is
 * removed. Removing one here does not merely change a flag: `status` becomes
 * `fail` instead of `incomplete` and the exit code becomes 1 instead of 2, and
 * both are asserted below and in `test/severity-incomplete.test.mjs` for every
 * rule that sets it. Where a run is *also* carrying an error finding, the flag
 * is still the whole of the difference between "this fixture set is wrong" and
 * "this run did not establish what the fixture set is", which are not the same
 * message and do not share an exit code.
 *
 * The other half is the vacuous pass: `checked: 0` with nothing wrong. It is
 * reachable -- an empty fixture list reaches it -- so it is reported.
 */

const PROVIDER = { name: 'acme', versionAt: '/api_version', typeAt: '/event' }
const MAPPING = {
  provider: 'acme',
  version: '2',
  sourceType: 'order_created',
  canonicalType: 'order.created',
  sourceId: '/id',
  fields: [{ from: '/data/order_id', to: 'orderId', as: 'string' }],
}
const PAYLOAD = { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } }

function job(events, extra = {}) {
  return { canonicalVersion: '1', providers: [PROVIDER], mappings: [MAPPING], events, ...extra }
}

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'webhook-payload-normalizer-backstop-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

test('a run that checked nothing is reported, never passed', async () => {
  const report = await normalizeJob(job([]))

  assert.equal(report.summary.checked, 0)
  assert.notEqual(report.status, 'pass')
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.equal(report.findings.some((finding) => finding.ruleId === 'no-events-checked'), true)
})

test('a fixture that was not examined keeps the run off "pass", every way it happens', async () => {
  const ways = [
    await normalizeJob(job([{ ref: 'one', provider: 'acme', payload: { ...PAYLOAD, api_version: 2 } }])),
    await normalizeJob(job([{ ref: 'one', provider: 'acme', payload: { id: 'A1', api_version: '2', data: {} } }])),
    await normalizeJob(job([{ ref: 'one', provider: 'acme', payload: { ...PAYLOAD, data: { order_id: 'ORD-5521' } } }]), { limits: { maxValueChars: 4 } }),
    await normalizeJob(job([{ ref: 'one', provider: 'acme', payload: { ...PAYLOAD, data: { order_id: 'O1', deep: { deeper: 1 } } } }]), { limits: { maxPayloadDepth: 2 } }),
    await normalizeJob(job([{ ref: 'one', provider: 'acme', payload: PAYLOAD }]), { limits: { maxSteps: 2 } }),
  ]

  for (const report of ways) {
    assert.notEqual(report.status, 'pass')
    assert.equal(report.status, 'incomplete')
    assert.equal(exitCodeFor(report), 2)
    assert.equal(report.summary.normalized, 0)
  }
})

test('an equivalence nobody could check is incomplete, not a satisfied claim', async () => {
  const report = await normalizeJob(job(
    [
      { ref: 'good', provider: 'acme', payload: PAYLOAD },
      { ref: 'bad', provider: 'acme', payload: { ...PAYLOAD, api_version: '9' } },
    ],
    { equivalence: [{ id: 'group', refs: ['good', 'bad'] }] },
  ))

  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.deepEqual(report.normalization.equivalence, [{ id: 'group', refs: ['good', 'bad'], match: null }])
  assert.notEqual(report.normalization.equivalence[0].match, true, 'an unchecked equivalence must never read as a held one')
})

test('a job that could not be read reports which input, and does not pass', async () => {
  await withBase(async (base) => {
    const report = await normalizeJobFile(join(base, 'absent.json'), { label: 'absent.json' })

    assert.equal(report.status, 'incomplete')
    assert.equal(exitCodeFor(report), 2)
    assert.equal(report.findings[0].location.file, 'absent.json')
    assert.equal(report.summary.checked, 0)
  })
})

test('a fixture that could not be read is incomplete, while one refused unread is a verdict', async () => {
  await withBase(async (base) => {
    await mkdir(join(base, 'events'))
    await writeFile(join(base, 'events', 'good.json'), JSON.stringify(PAYLOAD))
    const jobPath = join(base, 'job.json')
    await writeFile(jobPath, JSON.stringify(job(
      [
        { ref: 'good', provider: 'acme', file: 'good.json' },
        { ref: 'gone', provider: 'acme', file: 'absent.json' },
      ],
      { eventsRoot: 'events' },
    )))

    const report = await normalizeJobFile(jobPath)

    assert.equal(report.status, 'incomplete', 'a fixture nobody read is evidence nobody obtained')
    assert.equal(exitCodeFor(report), 2)
    assert.equal(report.summary.checked, 1)
    assert.equal(report.summary.skipped, 1)
  })
})

test('a completed run that simply failed is a fail, and exits 1 rather than 2', async () => {
  const report = await normalizeJob(job([{ ref: 'one', provider: 'acme', payload: { ...PAYLOAD, api_version: '9' } }]))

  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
  assert.equal(report.summary.checked, 1, 'the fixture did reach a verdict; the verdict was no')
  assert.equal(report.summary.skipped, 0)
})

test('the three statuses map to the three exit codes and to nothing else', () => {
  assert.equal(exitCodeFor({ status: 'pass' }), 0)
  assert.equal(exitCodeFor({ status: 'fail' }), 1)
  assert.equal(exitCodeFor({ status: 'incomplete' }), 2)
})
