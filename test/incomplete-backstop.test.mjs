import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

test('an equivalence the budget cut short is unresolved, never a group that holds', async () => {
  const events = [
    { ref: 'one', provider: 'acme', payload: PAYLOAD },
    { ref: 'two', provider: 'acme', payload: { ...PAYLOAD, id: 'A2', data: { order_id: 'O2' } } },
  ]
  const claim = { equivalence: [{ id: 'group', refs: ['one', 'two'] }] }

  const whole = await normalizeJob(job(events, claim))
  assert.equal(whole.status, 'fail', 'with the whole budget the group is compared and it does not hold')
  assert.equal(whole.findings.some((finding) => finding.ruleId === 'equivalence-mismatch'), true)
  assert.deepEqual(whole.normalization.equivalence, [{ id: 'group', refs: ['one', 'two'], match: false }])

  /**
   * Every budget short of the whole run stops the work somewhere -- in the
   * fixture loop, between the two comparisons, or before the group is reached
   * at all. None of them may leave a verdict behind: this group genuinely does
   * not hold, so a run that reports it as held is not merely incomplete, it is
   * wrong, and `--out` would write that claim to a file.
   */
  for (let maxSteps = 1; maxSteps < whole.summary.steps; maxSteps += 1) {
    const cut = await normalizeJob(job(events, claim), { limits: { maxSteps } })
    const ruleIds = cut.findings.map((finding) => finding.ruleId)

    assert.equal(cut.status, 'incomplete', `maxSteps ${maxSteps}: a run the budget stopped is incomplete`)
    assert.equal(exitCodeFor(cut), 2, `maxSteps ${maxSteps}: evidence nobody obtained exits 2`)
    assert.equal(ruleIds.includes('limit-steps-exceeded'), true, `maxSteps ${maxSteps}: the budget that stopped the run is named`)
    assert.equal(ruleIds.includes('equivalence-confirmed'), false, `maxSteps ${maxSteps}: a comparison that never ran confirms nothing`)
    for (const verdict of cut.normalization.equivalence) {
      assert.equal(verdict.match, null, `maxSteps ${maxSteps}: an unfinished comparison reads as null, not true and not false`)
      assert.equal(ruleIds.includes('equivalence-unresolved'), true, `maxSteps ${maxSteps}: the unfinished group says so`)
    }
  }
})

test('a bundle is never written carrying an equivalence verdict the budget cut short', async () => {
  await withBase(async (base) => {
    const events = [
      { ref: 'one', provider: 'acme', payload: PAYLOAD },
      { ref: 'two', provider: 'acme', payload: { ...PAYLOAD, id: 'A2', data: { order_id: 'O2' } } },
    ]
    const claim = { equivalence: [{ id: 'group', refs: ['one', 'two'] }] }
    const whole = await normalizeJob(job(events, claim))

    for (let maxSteps = 1; maxSteps < whole.summary.steps; maxSteps += 1) {
      const outPath = join(base, `bundle-${maxSteps}.json`)
      const cut = await normalizeJob(job(events, claim), { limits: { maxSteps }, outPath })

      assert.equal(cut.status, 'incomplete', `maxSteps ${maxSteps}`)
      assert.equal(
        cut.findings.some((finding) => finding.ruleId === 'output-withheld'),
        true,
        `maxSteps ${maxSteps}: a partial run withholds its bundle and says so`,
      )
      await assert.rejects(readFile(outPath), { code: 'ENOENT' }, `maxSteps ${maxSteps}: nothing was written`)
    }
  })
})

test('an unclaimed field too long to carry is incomplete, not merely a failure', async () => {
  /**
   * The sibling of the mapped-field bound one line up in the report, and the
   * one with no test: the `preserve` policy reaches a *different*
   * `limit-value-chars-exceeded` site, for a field no mapping claims. Whether
   * that field belongs under `extensions` is exactly what the bound stopped the
   * run from establishing, so it is evidence nobody obtained and exits 2.
   */
  const report = await normalizeJob(
    job([
      { ref: 'short', provider: 'acme', payload: PAYLOAD },
      { ref: 'long', provider: 'acme', payload: { ...PAYLOAD, id: 'A2', note: 'ORD-5521' } },
    ]),
    { limits: { maxValueChars: 4 } },
  )

  assert.equal(report.summary.checked, 1, 'a fixture did reach a verdict, so "checked nothing" is not what carries this')
  assert.equal(report.summary.skipped, 1)
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
  assert.equal(report.findings.some((finding) => finding.ruleId === 'limit-value-chars-exceeded'), true)
})

test('an events root that would not resolve is incomplete, even beside a fixture that passed', async () => {
  await withBase(async (base) => {
    const jobPath = join(base, 'job.json')
    await writeFile(jobPath, JSON.stringify(job(
      [
        { ref: 'inline', provider: 'acme', payload: PAYLOAD },
        { ref: 'filed', provider: 'acme', file: 'good.json' },
      ],
      { eventsRoot: 'absent' },
    )))

    const report = await normalizeJobFile(jobPath)

    assert.equal(report.summary.checked, 1, 'one fixture did reach a verdict, so "checked nothing" is not what carries this')
    assert.equal(report.status, 'incomplete', 'no fixture that names a file was read, and that is evidence nobody obtained')
    assert.equal(exitCodeFor(report), 2)
    assert.equal(report.findings.some((finding) => finding.ruleId === 'event-file-unreadable'), true)
  })
})

test('a fixture that resolved but would not read is incomplete, even beside a fixture that passed', async () => {
  await withBase(async (base) => {
    await mkdir(join(base, 'events'))
    await mkdir(join(base, 'events', 'not-a-file.json'))
    const jobPath = join(base, 'job.json')
    await writeFile(jobPath, JSON.stringify(job(
      [
        { ref: 'inline', provider: 'acme', payload: PAYLOAD },
        { ref: 'filed', provider: 'acme', file: 'not-a-file.json' },
      ],
      { eventsRoot: 'events' },
    )))

    const report = await normalizeJobFile(jobPath)

    assert.equal(report.summary.checked, 1, 'the path resolves and sits inside the root; it is the read that fails')
    assert.equal(report.summary.skipped, 1)
    assert.equal(report.status, 'incomplete')
    assert.equal(exitCodeFor(report), 2)
    assert.equal(report.findings.some((finding) => finding.ruleId === 'event-file-unreadable'), true)
  })
})

test('a budget that stopped the fixture loop is incomplete even when a fixture did pass', async () => {
  const events = [
    { ref: 'one', provider: 'acme', payload: PAYLOAD },
    { ref: 'two', provider: 'acme', payload: { ...PAYLOAD, id: 'A2' } },
  ]

  const whole = await normalizeJob(job(events))
  assert.equal(whole.status, 'pass')
  assert.equal(whole.summary.checked, 2)

  /**
   * `limit-steps-exceeded` is an error, so a run that hit the budget fails
   * whatever the flag says -- and `fail` is the wrong answer. The distinction
   * the flag carries is "this fixture set is wrong" against "this run did not
   * establish what the fixture set is", and only the second is true here. The
   * budget values that stop *after* the first fixture are the ones with no
   * second line of defence: `no-events-checked` does not cover them.
   */
  let stoppedWithAVerdictInHand = false
  for (let maxSteps = 1; maxSteps < whole.summary.steps; maxSteps += 1) {
    const cut = await normalizeJob(job(events), { limits: { maxSteps } })

    assert.equal(cut.status, 'incomplete', `maxSteps ${maxSteps}: the run stopped short of its own subject`)
    assert.equal(exitCodeFor(cut), 2, `maxSteps ${maxSteps}: evidence nobody obtained exits 2, never 1`)
    assert.equal(cut.findings.some((finding) => finding.ruleId === 'limit-steps-exceeded'), true, `maxSteps ${maxSteps}`)
    if (cut.summary.checked > 0) stoppedWithAVerdictInHand = true
  }
  assert.equal(stoppedWithAVerdictInHand, true, 'at least one budget must stop the loop with a fixture already checked')
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
