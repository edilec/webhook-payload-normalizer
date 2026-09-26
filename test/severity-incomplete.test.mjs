import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * Severity for the rules the `incomplete` flag backstops, pinned the same way.
 *
 * These rules exit 2 whichever way their severity is written, so an exit code
 * alone does not pin them. What does pin them is the counted errors, the
 * counted warnings, the counted info and the severity word the human summary
 * prints -- all four stated as literals at the assertion. Demote one of these
 * rules to `warning` and `summary.errors` falls by one while `summary.warnings`
 * rises by one, and the printed line stops beginning with ERROR.
 *
 * As in `test/severity-decides.test.mjs`, this file imports nothing from
 * `src/`, holds no rule table, no severity map, no case list and no
 * parameterised expectation. Every job is written out in full at the test that
 * uses it.
 */

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/webhook-payload-normalizer.mjs')
const NEWLINE = String.fromCharCode(10)

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'webhook-payload-normalizer-incomplete-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function normalize(build, extraArguments = []) {
  return withBase(async (base) => {
    const jobPath = await build(base)
    const argv = [CLI, '--job', jobPath, '--label', 'job.json', ...extraArguments]
    try {
      const { stdout, stderr } = await run(process.execPath, argv, { cwd: projectDirectory })
      return { code: 0, report: JSON.parse(stdout), stderr }
    } catch (error) {
      return { code: error.code, report: JSON.parse(error.stdout), stderr: error.stderr }
    }
  })
}

function writeJob(body) {
  return async (base) => {
    const path = join(base, 'job.json')
    await writeFile(path, JSON.stringify(body, null, 2))
    return path
  }
}

function printed(stderr, ruleId) {
  return stderr.split(NEWLINE).filter((line) => line.includes(` ${ruleId} `))
}

test('job-unreadable: exit 2, status incomplete, 2 errors, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(async (base) => join(base, 'absent.json'))
  const lines = printed(stderr, 'job-unreadable')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.checked, 0)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('job-not-utf8: exit 2, status incomplete, 2 errors, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(async (base) => {
    const path = join(base, 'job.json')
    await writeFile(path, Buffer.from([0x7b, 0xff, 0x7d]))
    return path
  })
  const lines = printed(stderr, 'job-not-utf8')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('job-not-json: exit 2, status incomplete, 2 errors, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(async (base) => {
    const path = join(base, 'job.json')
    await writeFile(path, '{ "canonicalVersion": ')
    return path
  })
  const lines = printed(stderr, 'job-not-json')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('limit-job-bytes-exceeded: exit 2, status incomplete, 2 errors, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(async (base) => {
    const path = join(base, 'job.json')
    await writeFile(path, `{ "filler": "${'x'.repeat(1048600)}" }`)
    return path
  })
  const lines = printed(stderr, 'limit-job-bytes-exceeded')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('job-invalid: exit 2, status incomplete, 2 errors, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(writeJob({
    providers: [{ name: 'acme', versionAt: '/api_version', typeAt: '/event' }],
    mappings: [{
      provider: 'acme',
      version: '2',
      sourceType: 'order_created',
      canonicalType: 'order.created',
      sourceId: '/id',
      fields: [{ from: '/data/order_id', to: 'orderId', as: 'string' }],
    }],
    events: [{ ref: 'ok', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } }],
  }))
  const lines = printed(stderr, 'job-invalid')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.checked, 0)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('job-unknown-key: exit 2, status incomplete, 2 errors, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(writeJob({
    canonicalVersion: '1',
    unknownfields: 'reject',
    providers: [{ name: 'acme', versionAt: '/api_version', typeAt: '/event' }],
    mappings: [{
      provider: 'acme',
      version: '2',
      sourceType: 'order_created',
      canonicalType: 'order.created',
      sourceId: '/id',
      fields: [{ from: '/data/order_id', to: 'orderId', as: 'string' }],
    }],
    events: [{ ref: 'ok', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } }],
  }))
  const lines = printed(stderr, 'job-unknown-key')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.checked, 0)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('mapping-duplicate: exit 2, status incomplete, 2 errors, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(writeJob({
    canonicalVersion: '1',
    providers: [{ name: 'acme', versionAt: '/api_version', typeAt: '/event' }],
    mappings: [
      {
        provider: 'acme',
        version: '2',
        sourceType: 'order_created',
        canonicalType: 'order.created',
        sourceId: '/id',
        fields: [{ from: '/data/order_id', to: 'orderId', as: 'string' }],
      },
      {
        provider: 'acme',
        version: '2',
        sourceType: 'order_created',
        canonicalType: 'order.placed',
        sourceId: '/id',
        fields: [{ from: '/data/order_id', to: 'orderId', as: 'string' }],
      },
    ],
    events: [{ ref: 'ok', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } }],
  }))
  const lines = printed(stderr, 'mapping-duplicate')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.checked, 0)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('mapping-unsupported-construct: exit 2, status incomplete, 2 errors, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(writeJob({
    canonicalVersion: '1',
    providers: [{ name: 'acme', versionAt: '/api_version', typeAt: '/event' }],
    mappings: [{
      provider: 'acme',
      version: '2',
      sourceType: 'order_created',
      canonicalType: 'order.created',
      sourceId: '/id',
      fields: [{ from: '$.data.order_id', to: 'orderId', as: 'string' }],
    }],
    events: [{ ref: 'ok', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } }],
  }))
  const lines = printed(stderr, 'mapping-unsupported-construct')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.checked, 0)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('no-events-checked: exit 2, status incomplete, 1 error, 1 info, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(writeJob({
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
    events: [],
  }))
  const lines = printed(stderr, 'no-events-checked')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 1)
  assert.equal(report.summary.checked, 0)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('event-file-unreadable: exit 2, status incomplete, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(async (base) => {
    await mkdir(join(base, 'events'))
    return writeJob({
      canonicalVersion: '1',
      eventsRoot: 'events',
      providers: [{ name: 'acme', versionAt: '/api_version', typeAt: '/event' }],
      mappings: [{
        provider: 'acme',
        version: '2',
        sourceType: 'order_created',
        canonicalType: 'order.created',
        sourceId: '/id',
        fields: [{ from: '/data/order_id', to: 'orderId', as: 'string' }],
      }],
      events: [
        { ref: 'ok', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } },
        { ref: 'gone', provider: 'acme', file: 'absent.json' },
      ],
    })(base)
  })
  const lines = printed(stderr, 'event-file-unreadable')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.checked, 1)
  assert.equal(report.summary.skipped, 1)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('event-file-not-utf8: exit 2, status incomplete, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(async (base) => {
    await mkdir(join(base, 'events'))
    await writeFile(join(base, 'events', 'broken.json'), Buffer.from([0x7b, 0xff, 0x7d]))
    return writeJob({
      canonicalVersion: '1',
      eventsRoot: 'events',
      providers: [{ name: 'acme', versionAt: '/api_version', typeAt: '/event' }],
      mappings: [{
        provider: 'acme',
        version: '2',
        sourceType: 'order_created',
        canonicalType: 'order.created',
        sourceId: '/id',
        fields: [{ from: '/data/order_id', to: 'orderId', as: 'string' }],
      }],
      events: [
        { ref: 'ok', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } },
        { ref: 'broken', provider: 'acme', file: 'broken.json' },
      ],
    })(base)
  })
  const lines = printed(stderr, 'event-file-not-utf8')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.checked, 1)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('event-file-not-json: exit 2, status incomplete, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(async (base) => {
    await mkdir(join(base, 'events'))
    await writeFile(join(base, 'events', 'broken.json'), '{ "id": ')
    return writeJob({
      canonicalVersion: '1',
      eventsRoot: 'events',
      providers: [{ name: 'acme', versionAt: '/api_version', typeAt: '/event' }],
      mappings: [{
        provider: 'acme',
        version: '2',
        sourceType: 'order_created',
        canonicalType: 'order.created',
        sourceId: '/id',
        fields: [{ from: '/data/order_id', to: 'orderId', as: 'string' }],
      }],
      events: [
        { ref: 'ok', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } },
        { ref: 'broken', provider: 'acme', file: 'broken.json' },
      ],
    })(base)
  })
  const lines = printed(stderr, 'event-file-not-json')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.checked, 1)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('event-version-unresolved: exit 2, status incomplete, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(writeJob({
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
    events: [
      { ref: 'ok', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } },
      { ref: 'nameless', provider: 'acme', payload: { id: 'A2', event: 'order_created', data: { order_id: 'O2' } } },
    ],
  }))
  const lines = printed(stderr, 'event-version-unresolved')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.checked, 1)
  assert.equal(report.summary.skipped, 1)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('event-type-unresolved: exit 2, status incomplete, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(writeJob({
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
    events: [
      { ref: 'ok', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } },
      { ref: 'typeless', provider: 'acme', payload: { id: 'A2', api_version: '2', data: { order_id: 'O2' } } },
    ],
  }))
  const lines = printed(stderr, 'event-type-unresolved')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.checked, 1)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('equivalence-unresolved: exit 2, status incomplete, 2 errors, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(writeJob({
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
    events: [
      { ref: 'good', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } },
      { ref: 'bad', provider: 'acme', payload: { id: 'A2', api_version: '3', event: 'order_created', data: { order_id: 'O2' } } },
    ],
    equivalence: [{ id: 'order-created', refs: ['good', 'bad'] }],
  }))
  const lines = printed(stderr, 'equivalence-unresolved')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.normalization.equivalence[0].match, null)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('limit-events-exceeded: exit 2, status incomplete, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(
    writeJob({
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
      events: [
        { ref: 'one', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } },
        { ref: 'two', provider: 'acme', payload: { id: 'A2', api_version: '2', event: 'order_created', data: { order_id: 'O2' } } },
      ],
    }),
    ['--max-events', '1'],
  )
  const lines = printed(stderr, 'limit-events-exceeded')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.normalized, 1)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('limit-mappings-exceeded: exit 2, status incomplete, 2 errors, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(
    writeJob({
      canonicalVersion: '1',
      providers: [{ name: 'acme', versionAt: '/api_version', typeAt: '/event' }],
      mappings: [
        {
          provider: 'acme',
          version: '2',
          sourceType: 'order_created',
          canonicalType: 'order.created',
          sourceId: '/id',
          fields: [{ from: '/data/order_id', to: 'orderId', as: 'string' }],
        },
        {
          provider: 'acme',
          version: '2',
          sourceType: 'order_cancelled',
          canonicalType: 'order.cancelled',
          sourceId: '/id',
          fields: [{ from: '/data/order_id', to: 'orderId', as: 'string' }],
        },
      ],
      events: [{ ref: 'ok', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } }],
    }),
    ['--max-mappings', '1'],
  )
  const lines = printed(stderr, 'limit-mappings-exceeded')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.checked, 0)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('limit-payload-bytes-exceeded: exit 2, status incomplete, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(
    async (base) => {
      await mkdir(join(base, 'events'))
      await writeFile(
        join(base, 'events', 'big.json'),
        JSON.stringify({ id: 'A2', api_version: '2', event: 'order_created', data: { order_id: 'O2' } }),
      )
      return writeJob({
        canonicalVersion: '1',
        eventsRoot: 'events',
        providers: [{ name: 'acme', versionAt: '/api_version', typeAt: '/event' }],
        mappings: [{
          provider: 'acme',
          version: '2',
          sourceType: 'order_created',
          canonicalType: 'order.created',
          sourceId: '/id',
          fields: [{ from: '/data/order_id', to: 'orderId', as: 'string' }],
        }],
        events: [
          { ref: 'ok', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } },
          { ref: 'big', provider: 'acme', file: 'big.json' },
        ],
      })(base)
    },
    ['--max-payload-bytes', '10'],
  )
  const lines = printed(stderr, 'limit-payload-bytes-exceeded')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.checked, 1)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('limit-payload-depth-exceeded: exit 2, status incomplete, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(
    writeJob({
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
      events: [
        { ref: 'ok', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } },
        { ref: 'deep', provider: 'acme', payload: { id: 'A2', api_version: '2', event: 'order_created', data: { order_id: 'O2', customer: { name: 'Northwind Trading' } } } },
      ],
    }),
    ['--max-payload-depth', '2'],
  )
  const lines = printed(stderr, 'limit-payload-depth-exceeded')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.checked, 1)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('limit-unknown-fields-exceeded: exit 2, status incomplete, 1 error, 1 info, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(
    writeJob({
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
      events: [
        { ref: 'ok', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } },
        { ref: 'extra', provider: 'acme', payload: { id: 'A2', api_version: '2', event: 'order_created', data: { order_id: 'O2', one: 1, two: 2 } } },
      ],
    }),
    ['--max-unknown-fields', '1'],
  )
  const lines = printed(stderr, 'limit-unknown-fields-exceeded')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 1)
  assert.equal(report.summary.checked, 1)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('limit-value-chars-exceeded: exit 2, status incomplete, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(
    writeJob({
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
      events: [
        { ref: 'ok', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } },
        { ref: 'long', provider: 'acme', payload: { id: 'A2', api_version: '2', event: 'order_created', data: { order_id: 'ORD-5521' } } },
      ],
    }),
    ['--max-value-chars', '4'],
  )
  const lines = printed(stderr, 'limit-value-chars-exceeded')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.checked, 1)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('limit-steps-exceeded: exit 2, status incomplete, 2 errors, 0 info, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(
    writeJob({
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
      events: [{ ref: 'ok', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } }],
    }),
    ['--max-steps', '1'],
  )
  const lines = printed(stderr, 'limit-steps-exceeded')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 2)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.checked, 0)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('limit-findings-exceeded: exit 2, status incomplete, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(
    writeJob({
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
      events: [{ ref: 'ok', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1', one: 1, two: 2 } } }],
    }),
    ['--max-findings', '1'],
  )
  const lines = printed(stderr, 'limit-findings-exceeded')

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.findings.length, 1)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})
