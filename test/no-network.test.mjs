import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/webhook-payload-normalizer.mjs')

/**
 * No socket is opened, and the proof is a real listener watching.
 *
 * This is a webhook tool, so a payload full of URLs is exactly the input a
 * careless implementation would decide to fetch: a `$ref` to resolve, a schema
 * to download, a delivery to retry. It does none of that. The test below starts
 * a real HTTP server on a real loopback port, puts that server's own URL into
 * the job and into every payload the run touches, and asserts the server saw
 * nothing at all.
 */

test('a job full of loopback URLs opens no connection', async () => {
  const server = createServer((request, response) => {
    response.end('should never be reached')
  })
  const connections = []
  server.on('connection', (socket) => connections.push(socket.remoteAddress ?? 'unknown'))
  const requests = []
  server.on('request', (request) => requests.push(request.url))

  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  const url = `http://127.0.0.1:${port}/schema.json`
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

    const { stdout } = await run(process.execPath, [CLI, '--job', jobPath, '--json'], { cwd: projectDirectory })
    const report = JSON.parse(stdout)

    assert.equal(report.status, 'pass')
    assert.equal(report.normalization.events[0].canonical.data.callback, url, 'the URL is data, and data is carried across')
    assert.deepEqual(connections, [], 'the listener must have seen no connection')
    assert.deepEqual(requests, [], 'and no request')
  } finally {
    await rm(base, { recursive: true, force: true })
    await new Promise((done) => server.close(done))
  }
})

/**
 * A secondary guard. The test above is the one that proves it; this one catches
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
