import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/webhook-payload-normalizer.mjs')
const DENY_NETWORK = join(projectDirectory, 'test/support/deny-network.mjs')

/**
 * No socket is opened, including by this test.
 *
 * This is a webhook tool, so a payload full of URLs is exactly the input a
 * careless implementation would decide to fetch: a `$ref` to resolve, a schema
 * to download, a delivery to retry. The child process installs guards before
 * loading the CLI; a network attempt throws before any socket can be opened.
 */

test('a job full of inert URLs runs with socket operations disabled', async () => {
  const url = 'http://127.0.0.1:8080/schema.json'
  const base = await mkdtemp(join(tmpdir(), 'webhook-payload-normalizer-network-'))

  try {
    const jobPath = join(base, 'job.json')
    await writeFile(jobPath, JSON.stringify({
      canonicalVersion: '1',
      providers: [{ name: 'acme', versionAt: '/api_version', typeAt: '/event' }],
      mappings: [{
        provider: 'acme',
        version: '2',
        sourceType: 'order_created',
        canonicalType: 'order.created',
        sourceId: '/id',
        fields: [
          { from: '/data/order_id', to: 'orderId', as: 'string' },
          { from: '/data/callback', to: 'callback', as: 'string' },
        ],
      }],
      events: [{
        ref: 'one',
        provider: 'acme',
        payload: {
          id: 'A1',
          api_version: '2',
          event: 'order_created',
          $schema: url,
          data: { order_id: 'O1', callback: url, webhook_url: url },
        },
      }],
    }))

    const { stdout } = await run(process.execPath, ['--import', DENY_NETWORK, CLI, '--job', jobPath, '--json'], { cwd: projectDirectory })
    const report = JSON.parse(stdout)

    assert.equal(report.status, 'pass')
    assert.equal(report.normalization.events[0].canonical.data.callback, url, 'the URL is data, and data is carried across')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('the preload refuses a local data URL fetch before any network operation', async () => {
  await assert.rejects(
    () => run(process.execPath, [
      '--import', DENY_NETWORK,
      '--input-type=module',
      '--eval', "await fetch('data:text/plain,probe')",
    ], { cwd: projectDirectory }),
    /A network operation was attempted during an offline test/,
  )
})

/**
 * A secondary guard. The test above exercises the real CLI; this one catches
 * a future edit that imports the capability in the first place.
 */
test('the package imports no networking primitive at all', async () => {
  const forbidden = ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram', 'node:dns', 'node:child_process', 'node:worker_threads', 'fetch(', 'XMLHttpRequest', 'WebSocket']

  const files = [join(projectDirectory, 'bin/webhook-payload-normalizer.mjs')]
  for (const name of await readdir(join(projectDirectory, 'src'))) files.push(join(projectDirectory, 'src', name))

  for (const file of files) {
    const source = await readFile(file, 'utf8')
    for (const needle of forbidden) {
      assert.equal(source.includes(needle), false, `${file} reaches for ${needle}`)
    }
  }
})

test('the package declares no dependency of any kind', async () => {
  const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))

  assert.equal(Object.hasOwn(manifest, 'dependencies'), false)
  assert.equal(Object.hasOwn(manifest, 'devDependencies'), false)
  assert.equal(Object.hasOwn(manifest, 'peerDependencies'), false)
  assert.equal(Object.hasOwn(manifest, 'optionalDependencies'), false)
})
