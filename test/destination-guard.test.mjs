import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * The output destination, driven through the real binary.
 *
 * This file exists because knowing about a hole does not close it. Measured
 * across this catalog: ten tools accepted a destination that overwrote a file
 * they were never asked to touch and four of them exited 0 saying the write
 * succeeded. This tool was one of them -- a symbolic link at `--out` carried
 * the bundle onto a file outside the job's directory and the run exited 0 with
 * an empty stderr.
 *
 * Three holes, and each needs its own case because no one of them catches the
 * others:
 *
 * 1. A symlink at the destination. `realpath` on it *resolves* the link, which
 *    is the dangerous act; only `lstat` refuses it unresolved.
 * 2. A symlinked parent. A lexical prefix check passes for `base/link/out`
 *    where `link` leaves the tree, so the parent is resolved and compared.
 * 3. A hard link to an input. No target to resolve and no shared path, so
 *    `realpath` and string comparison both call it a different file. Only
 *    device plus inode sees that it is the same file.
 *
 * And the allowed cases are not optional: a guard that refuses everything
 * passes every data-loss case above while making the tool useless. Half of
 * this file is destinations that must still be written.
 */

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/webhook-payload-normalizer.mjs')

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
const JOB = {
  canonicalVersion: '1',
  providers: [PROVIDER],
  mappings: [MAPPING],
  events: [{ ref: 'one', provider: 'acme', payload: PAYLOAD }],
}

const PRECIOUS = 'a file this run was never asked to touch'

async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

/**
 * A job directory and an unrelated directory beside it.
 *
 * `outside` is where the victim lives: a file in another tree entirely, which
 * no argument to this tool ever names.
 */
async function withScene(body) {
  const scene = await realpath(await mkdtemp(join(tmpdir(), 'webhook-payload-normalizer-dest-')))
  try {
    const base = join(scene, 'job-dir')
    const outside = join(scene, 'outside')
    await mkdir(base)
    await mkdir(outside)
    const jobPath = join(base, 'job.json')
    await writeFile(jobPath, JSON.stringify(JOB, null, 2))
    return await body({ scene, base, outside, jobPath })
  } finally {
    await rm(scene, { recursive: true, force: true })
  }
}

/** Every refusal is a configuration error: exit 2, empty stdout, no report. */
function assertRefused(result, pattern) {
  assert.equal(result.code, 2, `expected exit 2, got ${result.code}`)
  assert.equal(result.stdout, '', 'a refused destination is a configuration error, so stdout carries no report')
  assert.match(result.stderr, pattern)
}

test('HOLE 1: a symlink at the destination is refused, and the file it points at survives', async () => {
  await withScene(async ({ base, outside, jobPath }) => {
    const victim = join(outside, 'victim.txt')
    await writeFile(victim, PRECIOUS)
    await symlink(victim, join(base, 'bundle.json'))

    const result = await cli(['--job', jobPath, '--out', join(base, 'bundle.json')])

    assertRefused(result, /--out is a symbolic link/)
    assert.equal(await readFile(victim, 'utf8'), PRECIOUS, 'the file outside the job directory must be untouched')
  })
})

test('HOLE 1: a symlink whose target does not exist yet creates nothing outside the root', async () => {
  await withScene(async ({ base, outside, jobPath }) => {
    const absent = join(outside, 'not-yet.txt')
    await symlink(absent, join(base, 'bundle.json'))

    const result = await cli(['--job', jobPath, '--out', join(base, 'bundle.json')])

    assertRefused(result, /--out is a symbolic link/)
    await assert.rejects(() => stat(absent), /ENOENT/, 'a dangling link must not become a new file outside the root')
  })
})

test('HOLE 2: a symlinked parent directory is refused, and the file beyond it survives', async () => {
  await withScene(async ({ base, outside, jobPath }) => {
    const victim = join(outside, 'victim.txt')
    await writeFile(victim, PRECIOUS)
    // `base/bridge` is lexically inside the job directory and really is not.
    await symlink(outside, join(base, 'bridge'))

    const result = await cli(['--job', jobPath, '--out', join(base, 'bridge', 'victim.txt')])

    assertRefused(result, /outside the job's directory/)
    assert.equal(await readFile(victim, 'utf8'), PRECIOUS)
  })
})

test('HOLE 3: a hard link to an input is refused on device and inode, not on path', async () => {
  await withScene(async ({ base, jobPath }) => {
    const original = await readFile(jobPath, 'utf8')
    const alias = join(base, 'another-name.json')
    await link(jobPath, alias)

    assert.notEqual(await realpath(jobPath), await realpath(alias), 'this is exactly why realpath is the wrong test')

    const result = await cli(['--job', jobPath, '--out', alias])

    assertRefused(result, /device \d+ and inode \d+/)
    assert.equal(await readFile(jobPath, 'utf8'), original, 'the input reached by another name must be exactly as it was')
  })
})

test('a lexical ".." escape is refused, and the file beyond it survives', async () => {
  await withScene(async ({ base, outside, jobPath }) => {
    const victim = join(outside, 'victim.txt')
    await writeFile(victim, PRECIOUS)

    const result = await cli(['--job', jobPath, '--out', join(base, '..', 'outside', 'victim.txt')])

    assertRefused(result, /outside the job's directory/)
    assert.equal(await readFile(victim, 'utf8'), PRECIOUS)
  })
})

test('a destination that is a directory is refused rather than opened', async () => {
  await withScene(async ({ base, jobPath }) => {
    await mkdir(join(base, 'bundle.json'))

    const result = await cli(['--job', jobPath, '--out', join(base, 'bundle.json')])

    assertRefused(result, /exists and is not a regular file/)
    assert.equal((await stat(join(base, 'bundle.json'))).isDirectory(), true)
  })
})

/**
 * The allowed cases. A guard that refuses everything passes every case above.
 */

test('ALLOWED: a new file in the job directory is written', async () => {
  await withScene(async ({ base, jobPath }) => {
    const out = join(base, 'bundle.json')

    const result = await cli(['--job', jobPath, '--out', out, '--json'])

    assert.equal(result.code, 0)
    assert.equal(JSON.parse(await readFile(out, 'utf8')).events[0].canonical.data.orderId, 'O1')
  })
})

test('ALLOWED: a nested destination inside the job directory is written', async () => {
  await withScene(async ({ base, jobPath }) => {
    await mkdir(join(base, 'build'))
    const out = join(base, 'build', 'bundle.json')

    const result = await cli(['--job', jobPath, '--out', out, '--json'])

    assert.equal(result.code, 0)
    assert.equal(JSON.parse(await readFile(out, 'utf8')).canonicalVersion, '1')
  })
})

test('ALLOWED: an existing regular file that is not an input is replaced', async () => {
  await withScene(async ({ base, jobPath }) => {
    const out = join(base, 'bundle.json')
    await writeFile(out, 'stale')

    const result = await cli(['--job', jobPath, '--out', out, '--json'])

    assert.equal(result.code, 0)
    assert.equal(JSON.parse(await readFile(out, 'utf8')).events.length, 1)
  })
})

test('ALLOWED: a job directory reached through a symlink is not falsely refused', async () => {
  await withScene(async ({ scene, base, jobPath }) => {
    // The root itself is reached through a link. Comparing a real parent
    // against an unresolved root would refuse this, and a false refusal is a
    // defect too.
    const linked = join(scene, 'linked-job-dir')
    await symlink(base, linked)
    const out = join(linked, 'bundle.json')

    const result = await cli(['--job', join(linked, 'job.json'), '--out', out, '--json'])

    assert.equal(result.code, 0, result.stderr)
    assert.equal(JSON.parse(await readFile(out, 'utf8')).events[0].source.id, 'A1')
    assert.equal(jobPath.endsWith('job.json'), true)
  })
})
