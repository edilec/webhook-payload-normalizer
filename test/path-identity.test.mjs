import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { isSameFile, normalizeJobFile } from '../src/index.mjs'

/**
 * Two different questions about paths, and two different answers.
 *
 * **Confinement** asks whether a fixture is inside the declared root. A
 * symbolic link planted in the root resolves out of the tree without ever
 * spelling `../`, so the answer is decided on real paths -- on *both* sides, so
 * that a root legitimately reached through a symlink is not falsely refused.
 *
 * **Identity** asks whether two names are the same file. Real paths cannot
 * answer that one: a hard link has no target, so both names resolve to
 * themselves and a real-path comparison cheerfully says they differ. Device
 * plus inode is the answer, and it is the comparison this tool refuses an
 * output destination on.
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

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'webhook-payload-normalizer-paths-'))
  try {
    return await body(await realpath(base))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

function jobBody(extra = {}) {
  return {
    canonicalVersion: '1',
    providers: [PROVIDER],
    mappings: [MAPPING],
    events: [{ ref: 'one', provider: 'acme', payload: PAYLOAD }],
    ...extra,
  }
}

test('a hard link is a second name for one file, and only device plus inode sees it', async () => {
  await withBase(async (base) => {
    const first = join(base, 'first.json')
    const second = join(base, 'second.json')
    await writeFile(first, '{}')
    await link(first, second)

    assert.notEqual(await realpath(first), await realpath(second), 'this is exactly why realpath is the wrong test')
    assert.equal(isSameFile(await stat(first), await stat(second)), true)

    const other = join(base, 'other.json')
    await writeFile(other, '{}')
    assert.equal(isSameFile(await stat(first), await stat(other)), false)
  })
})

test('the output destination is refused when it is an input reached by another name', async () => {
  await withBase(async (base) => {
    const jobPath = join(base, 'job.json')
    const original = JSON.stringify(jobBody())
    await writeFile(jobPath, original)
    const alias = join(base, 'alias.json')
    await link(jobPath, alias)

    await assert.rejects(
      () => normalizeJobFile(jobPath, { outPath: alias }),
      (error) => error.name === 'DestinationError' && /device \d+ and inode \d+/.test(error.message),
    )
    assert.equal(await readFile(jobPath, 'utf8'), original, 'the input must be exactly as it was')
    assert.equal(await readFile(alias, 'utf8'), original)
  })
})

test('the output destination is refused when a symlink points at an input', async () => {
  await withBase(async (base) => {
    await mkdir(join(base, 'events'))
    const fixture = join(base, 'events', 'one.json')
    await writeFile(fixture, JSON.stringify(PAYLOAD))
    const jobPath = join(base, 'job.json')
    await writeFile(jobPath, JSON.stringify(jobBody({
      eventsRoot: 'events',
      events: [{ ref: 'one', provider: 'acme', file: 'one.json' }],
    })))
    const pointer = join(base, 'pointer.json')
    await symlink(fixture, pointer)

    await assert.rejects(
      () => normalizeJobFile(jobPath, { outPath: pointer }),
      (error) => error.name === 'DestinationError' && /symbolic link/.test(error.message),
    )
    assert.equal(await readFile(fixture, 'utf8'), JSON.stringify(PAYLOAD))
  })
})

test('a destination that is not an input is written, and the bundle round-trips', async () => {
  await withBase(async (base) => {
    const jobPath = join(base, 'job.json')
    await writeFile(jobPath, JSON.stringify(jobBody()))
    const outPath = join(base, 'bundle.json')

    const report = await normalizeJobFile(jobPath, { outPath })
    const bundle = JSON.parse(await readFile(outPath, 'utf8'))

    assert.equal(report.status, 'pass')
    assert.deepEqual(bundle, report.normalization)
    assert.equal(bundle.events[0].source.id, 'A1')
  })
})

test('a fixture inside a root reached through a symlink is normalized, not refused', async () => {
  await withBase(async (base) => {
    await mkdir(join(base, 'real-events'))
    await writeFile(join(base, 'real-events', 'one.json'), JSON.stringify(PAYLOAD))
    await symlink(join(base, 'real-events'), join(base, 'events'))
    const jobPath = join(base, 'job.json')
    await writeFile(jobPath, JSON.stringify(jobBody({
      eventsRoot: 'events',
      events: [{ ref: 'one', provider: 'acme', file: 'one.json' }],
    })))

    const report = await normalizeJobFile(jobPath)

    assert.equal(report.status, 'pass', 'a false refusal is a bug too')
    assert.equal(report.summary.normalized, 1)
  })
})

test('a symlink inside the root that points out of it is refused unread', async () => {
  await withBase(async (base) => {
    await mkdir(join(base, 'events'))
    await mkdir(join(base, 'outside'))
    await writeFile(join(base, 'outside', 'secret.json'), JSON.stringify({ marker: 'OUTSIDE_CONTENT_MARKER' }))
    await symlink(join(base, 'outside', 'secret.json'), join(base, 'events', 'escape.json'))
    const jobPath = join(base, 'job.json')
    await writeFile(jobPath, JSON.stringify(jobBody({
      eventsRoot: 'events',
      events: [{ ref: 'one', provider: 'acme', file: 'escape.json' }],
    })))

    const report = await normalizeJobFile(jobPath)

    assert.equal(report.status, 'fail')
    assert.equal(report.findings.filter((finding) => finding.ruleId === 'event-file-outside-root').length, 1)
    assert.equal(JSON.stringify(report).includes('OUTSIDE_CONTENT_MARKER'), false, 'refused unread means unread')
  })
})

test('a traversal spelled out is refused the same way, by where it really lands', async () => {
  await withBase(async (base) => {
    await mkdir(join(base, 'events'))
    await writeFile(join(base, 'secret.json'), JSON.stringify({ marker: 'OUTSIDE_CONTENT_MARKER' }))
    const jobPath = join(base, 'job.json')
    await writeFile(jobPath, JSON.stringify(jobBody({
      eventsRoot: 'events',
      events: [{ ref: 'one', provider: 'acme', file: '../secret.json' }],
    })))

    const report = await normalizeJobFile(jobPath)

    assert.equal(report.status, 'fail')
    assert.equal(report.findings.filter((finding) => finding.ruleId === 'event-file-outside-root').length, 1)
    assert.equal(JSON.stringify(report).includes('OUTSIDE_CONTENT_MARKER'), false)
  })
})

test('the bundle is withheld from a run that did not pass', async () => {
  await withBase(async (base) => {
    const jobPath = join(base, 'job.json')
    await writeFile(jobPath, JSON.stringify(jobBody({
      events: [{ ref: 'one', provider: 'acme', payload: { ...PAYLOAD, data: {} } }],
    })))
    const outPath = join(base, 'bundle.json')

    const report = await normalizeJobFile(jobPath, { outPath })

    assert.equal(report.status, 'fail')
    assert.equal(report.findings.filter((finding) => finding.ruleId === 'output-withheld').length, 1)
    await assert.rejects(() => readFile(outPath, 'utf8'), /ENOENT/)
  })
})
