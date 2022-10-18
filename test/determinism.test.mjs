import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { normalizeJob } from '../src/index.mjs'

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
  fields: [
    { from: '/data/order_id', to: 'orderId', as: 'string' },
    { from: '/data/total_cents', to: 'amountMinor', as: 'integer' },
  ],
}

test('two runs over the same bytes produce byte-identical stdout', async () => {
  const first = await run(process.execPath, [CLI, '--job', 'examples/clean/job.json', '--json'], { cwd: projectDirectory })
  const second = await run(process.execPath, [CLI, '--job', 'examples/clean/job.json', '--json'], { cwd: projectDirectory })

  assert.equal(first.stdout, second.stdout)
  assert.equal(first.stdout.length > 500, true, 'otherwise this is comparing two empty strings')
})

test('the broken example is byte-identical too, and it is the failing path', async () => {
  const runBroken = async () => {
    try {
      const { stdout } = await run(process.execPath, [CLI, '--job', 'examples/broken/job.json', '--json'], { cwd: projectDirectory })
      return { code: 0, stdout }
    } catch (error) {
      return { code: error.code, stdout: error.stdout }
    }
  }

  const first = await runBroken()
  const second = await runBroken()

  assert.equal(first.code, 1)
  assert.equal(first.stdout, second.stdout)
})

test('the same data with its keys written in another order produces the same report', async () => {
  const job = (payload) => ({
    canonicalVersion: '1',
    providers: [PROVIDER],
    mappings: [MAPPING],
    events: [{ ref: 'one', provider: 'acme', payload }],
  })

  const forwards = await normalizeJob(job({
    id: 'A1',
    api_version: '2',
    event: 'order_created',
    data: { order_id: 'O1', total_cents: 4250 },
    zulu: 1,
    alpha: 2,
  }))
  const backwards = await normalizeJob(job({
    alpha: 2,
    zulu: 1,
    data: { total_cents: 4250, order_id: 'O1' },
    event: 'order_created',
    api_version: '2',
    id: 'A1',
  }))

  assert.equal(JSON.stringify(forwards), JSON.stringify(backwards))
  assert.deepEqual(forwards.normalization.events[0].extensions.map((entry) => entry.pointer), ['/alpha', '/zulu'])
})

test('the report carries no wall-clock time, no random value and no host path', async () => {
  const { stdout } = await run(process.execPath, [CLI, '--job', 'examples/clean/job.json', '--json'], { cwd: projectDirectory })
  const report = JSON.parse(stdout)

  assert.equal(stdout.includes(projectDirectory), false, 'location.file is relative to the declared input root')
  assert.equal(Object.hasOwn(report, 'generatedAt'), false)
  assert.equal(Object.hasOwn(report.summary, 'durationMs'), false)
  for (const finding of report.findings) {
    assert.equal(finding.location.file.startsWith('/'), false)
  }
})

/**
 * A secondary guard, and only that.
 *
 * Everything above pins determinism on what the tool emits. This last check
 * catches a different and duller failure: a future edit reaching for a
 * non-deterministic primitive. It is a source scan, so it proves nothing on its
 * own -- `Intl.Collator` would slip past a grep for `localeCompare`, which is
 * why the ordering tests drive real fixtures instead.
 */
test('the source reaches for no non-deterministic primitive', async () => {
  const forbidden = ['localeCompare', 'Intl.', 'Date.now', 'new Date', 'Math.random', 'process.hrtime', 'setTimeout', 'setInterval', 'readdir']

  /**
   * Comments are stripped first, because several of these names appear in the
   * prose that explains why they are not used, and a guard that fires on its
   * own documentation is a guard nobody keeps.
   */
  const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

  const files = ['bin/webhook-payload-normalizer.mjs']
  for (const name of await readdir(join(projectDirectory, 'src'))) files.push(`src/${name}`)

  for (const file of files) {
    const source = code(await readFile(join(projectDirectory, file), 'utf8'))
    for (const needle of forbidden) {
      assert.equal(source.includes(needle), false, `${file} reaches for ${needle}`)
    }
  }

  assert.equal(code('const a = 1 /* localeCompare */').includes('localeCompare'), false, 'the stripper must really strip')
  assert.equal(code('const a = localeCompare').includes('localeCompare'), true, 'and must not strip code')
})
