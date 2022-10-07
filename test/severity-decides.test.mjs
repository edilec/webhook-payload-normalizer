import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * Severity, pinned by consequence alone.
 *
 * This file imports nothing from `src/`. It holds no rule table, no severity
 * map, no list of cases and no parameterised expectation: every value below is
 * a literal written out at the assertion that uses it, and every job object is
 * written out in full at the test that uses it. A coordinated edit of the
 * frozen table, the documented catalog and a table of expected values in
 * another test file reaches none of it, because there is nothing here for such
 * an edit to touch -- and an exit code cannot be edited at all.
 *
 * The rules below are the ones where severity is the whole of the verdict.
 * Every other error rule also marks the run incomplete, so it exits 2 whichever
 * way its severity is written; `test/severity-incomplete.test.mjs` pins those
 * the same way, on the counted errors, warnings and info and on the severity
 * word the human summary prints.
 */

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/webhook-payload-normalizer.mjs')
const NEWLINE = String.fromCharCode(10)

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'webhook-payload-normalizer-decides-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

/** Write the job, run the real binary over it, and hand back what it did. */
async function normalize(build, extraArguments = []) {
  return withBase(async (base) => {
    const jobPath = await build(base)
    const argv = [CLI, '--job', jobPath, '--label', 'job.json', ...extraArguments.map((value) => value.replace('<base>', base))]
    try {
      const { stdout, stderr } = await run(process.execPath, argv, { cwd: projectDirectory })
      return { code: 0, report: JSON.parse(stdout), stderr, base }
    } catch (error) {
      return { code: error.code, report: JSON.parse(error.stdout), stderr: error.stderr, base }
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

test('provider-unknown fails the run: exit 1, status fail, 1 error, printed ERROR', async () => {
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
    events: [{ ref: 'e1', provider: 'ghost', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } }],
  }))
  const lines = printed(stderr, 'provider-unknown')

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 1)
  assert.equal(report.summary.rejected, 1)
  assert.equal(report.summary.normalized, 0)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
  assert.equal(lines[0].startsWith('INFO   '), false)
})

test('mapping-version-unknown fails the run: exit 1, status fail, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(writeJob({
    canonicalVersion: '1',
    providers: [{ name: 'acme', versionAt: '/api_version', typeAt: '/event' }],
    mappings: [
      {
        provider: 'acme',
        version: '1',
        sourceType: 'order_created',
        canonicalType: 'order.created',
        sourceId: '/id',
        fields: [{ from: '/data/order_id', to: 'orderId', as: 'string' }],
      },
      {
        provider: 'acme',
        version: '2',
        sourceType: 'order_created',
        canonicalType: 'order.created',
        sourceId: '/id',
        fields: [{ from: '/data/order_id', to: 'orderId', as: 'string' }],
      },
    ],
    events: [{ ref: 'e1', provider: 'acme', payload: { id: 'A1', api_version: '3', event: 'order_created', data: { order_id: 'O1' } } }],
  }))
  const lines = printed(stderr, 'mapping-version-unknown')

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 2)
  assert.equal(report.summary.rejected, 1)
  assert.equal(report.summary.normalized, 0)
  assert.equal(report.normalization.events.length, 0)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('mapping-event-unknown fails the run: exit 1, status fail, 1 error, printed ERROR', async () => {
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
    events: [{ ref: 'e1', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_updated', data: { order_id: 'O1' } } }],
  }))
  const lines = printed(stderr, 'mapping-event-unknown')

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 1)
  assert.equal(report.summary.rejected, 1)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('event-version-conflict fails the run: exit 1, status fail, 1 error, printed ERROR', async () => {
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
    events: [{ ref: 'e1', provider: 'acme', version: '1', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } }],
  }))
  const lines = printed(stderr, 'event-version-conflict')

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 1)
  assert.equal(report.summary.rejected, 1)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('field-required-missing fails the run: exit 1, status fail, 1 error, printed ERROR', async () => {
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
    events: [{ ref: 'e1', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: {} } }],
  }))
  const lines = printed(stderr, 'field-required-missing')

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 1)
  assert.equal(report.summary.rejected, 1)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('field-type-mismatch fails the run: exit 1, status fail, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(writeJob({
    canonicalVersion: '1',
    providers: [{ name: 'acme', versionAt: '/api_version', typeAt: '/event' }],
    mappings: [{
      provider: 'acme',
      version: '2',
      sourceType: 'order_created',
      canonicalType: 'order.created',
      sourceId: '/id',
      fields: [{ from: '/data/total', to: 'amountMinor', as: 'integer' }],
    }],
    events: [{ ref: 'e1', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { total: '4250' } } }],
  }))
  const lines = printed(stderr, 'field-type-mismatch')

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.rejected, 1)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('field-value-unmapped fails the run: exit 1, status fail, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(writeJob({
    canonicalVersion: '1',
    providers: [{ name: 'acme', versionAt: '/api_version', typeAt: '/event' }],
    mappings: [{
      provider: 'acme',
      version: '2',
      sourceType: 'order_created',
      canonicalType: 'order.created',
      sourceId: '/id',
      fields: [{ from: '/data/state', to: 'status', as: 'string', values: { PAID: 'paid' } }],
    }],
    events: [{ ref: 'e1', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { state: 'REFUNDED' } } }],
  }))
  const lines = printed(stderr, 'field-value-unmapped')

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.rejected, 1)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('source-id-missing fails the run: exit 1, status fail, 1 error, printed ERROR', async () => {
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
    events: [{ ref: 'e1', provider: 'acme', payload: { api_version: '2', event: 'order_created', data: { order_id: 'O1' } } }],
  }))
  const lines = printed(stderr, 'source-id-missing')

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.rejected, 1)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('unknown-fields-rejected fails the run: exit 1, status fail, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(writeJob({
    canonicalVersion: '1',
    unknownFields: 'reject',
    providers: [{ name: 'acme', versionAt: '/api_version', typeAt: '/event' }],
    mappings: [{
      provider: 'acme',
      version: '2',
      sourceType: 'order_created',
      canonicalType: 'order.created',
      sourceId: '/id',
      fields: [{ from: '/data/order_id', to: 'orderId', as: 'string' }],
    }],
    events: [{ ref: 'e1', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1', extra: 'x' } } }],
  }))
  const lines = printed(stderr, 'unknown-fields-rejected')

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.rejected, 1)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('event-file-outside-root fails the run: exit 1, status fail, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(async (base) => {
    await mkdir(join(base, 'events'))
    await mkdir(join(base, 'outside'))
    await writeFile(join(base, 'outside', 'secret.json'), JSON.stringify({ marker: 'OUTSIDE_CONTENT_MARKER' }))
    await symlink(join(base, 'outside', 'secret.json'), join(base, 'events', 'escape.json'))
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
      events: [{ ref: 'e1', provider: 'acme', file: 'escape.json' }],
    })(base)
  })
  const lines = printed(stderr, 'event-file-outside-root')

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 1)
  assert.equal(report.summary.rejected, 1)
  assert.equal(stderr.includes('OUTSIDE_CONTENT_MARKER'), false)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('equivalence-mismatch fails the run: exit 1, status fail, 1 error, printed ERROR', async () => {
  const { code, report, stderr } = await normalize(writeJob({
    canonicalVersion: '1',
    providers: [
      { name: 'acme', versionAt: '/api_version', typeAt: '/event' },
      { name: 'beta', versionAt: '/schema', typeAt: '/type' },
    ],
    mappings: [
      {
        provider: 'acme',
        version: '2',
        sourceType: 'order_created',
        canonicalType: 'order.created',
        sourceId: '/id',
        fields: [{ from: '/data/total', to: 'amountMinor', as: 'integer' }],
      },
      {
        provider: 'beta',
        version: '9',
        sourceType: 'order.created',
        canonicalType: 'order.created',
        sourceId: '/event_id',
        fields: [{ from: '/amount', to: 'amountMinor', as: 'integer' }],
      },
    ],
    events: [
      { ref: 'left', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { total: 4250 } } },
      { ref: 'right', provider: 'beta', payload: { event_id: 'B1', schema: '9', type: 'order.created', amount: 9900 } },
    ],
    equivalence: [{ id: 'order-created', refs: ['left', 'right'] }],
  }))
  const lines = printed(stderr, 'equivalence-mismatch')

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.normalized, 2)
  assert.equal(report.normalization.equivalence[0].match, false)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('output-is-input fails the run, writes nothing: exit 1, status fail, 1 error, printed ERROR', async () => {
  const { code, report, stderr, after, original } = await withBase(async (base) => {
    const jobPath = join(base, 'job.json')
    const body = {
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
      events: [{ ref: 'e1', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } }],
    }
    const original = JSON.stringify(body, null, 2)
    await writeFile(jobPath, original)
    const hardLink = join(base, 'another-name.json')
    await link(jobPath, hardLink)

    try {
      const { stdout, stderr: out } = await run(process.execPath, [CLI, '--job', jobPath, '--label', 'job.json', '--out', hardLink], { cwd: projectDirectory })
      return { code: 0, report: JSON.parse(stdout), stderr: out, after: await readFile(jobPath, 'utf8'), original }
    } catch (error) {
      return { code: error.code, report: JSON.parse(error.stdout), stderr: error.stderr, after: await readFile(jobPath, 'utf8'), original }
    }
  })
  const lines = printed(stderr, 'output-is-input')

  assert.equal(after, original, 'the input reached through its other name must be exactly as it was')
  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

test('output-unwritable fails the run: exit 1, status fail, 1 error, printed ERROR', async () => {
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
      events: [{ ref: 'e1', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } }],
    }),
    ['--out', '<base>/no-such-directory/bundle.json'],
  )
  const lines = printed(stderr, 'output-unwritable')

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('ERROR  '), true)
  assert.equal(lines[0].startsWith('WARNING'), false)
})

/**
 * The other direction, which is the half a severity table usually forgets.
 *
 * A field the mapping claimed but the payload does not carry, a mapping nobody
 * exercised, an equivalence that holds, an unclaimed field carried across or
 * reported, and a string that had a control character taken out of it are all
 * worth saying. Promoting any one of them to `error` turns a healthy run into a
 * broken build, and the exit code below is what catches that.
 */

test('unknown-fields-preserved does not fail the run: exit 0, status pass, 0 errors, printed INFO', async () => {
  const { code, report, stderr } = await normalize(writeJob({
    canonicalVersion: '1',
    unknownFields: 'preserve',
    providers: [{ name: 'acme', versionAt: '/api_version', typeAt: '/event' }],
    mappings: [{
      provider: 'acme',
      version: '2',
      sourceType: 'order_created',
      canonicalType: 'order.created',
      sourceId: '/id',
      fields: [{ from: '/data/order_id', to: 'orderId', as: 'string' }],
    }],
    events: [{ ref: 'e1', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1', extra: 'x' } } }],
  }))
  const lines = printed(stderr, 'unknown-fields-preserved')

  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 1)
  assert.equal(report.summary.normalized, 1)
  assert.equal(report.normalization.events[0].extensions[0].pointer, '/data/extra')
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('INFO   '), true)
  assert.equal(lines[0].startsWith('ERROR  '), false)
})

test('unknown-fields-reported does not fail the run: exit 0, status pass, 0 errors, printed WARNING', async () => {
  const { code, report, stderr } = await normalize(writeJob({
    canonicalVersion: '1',
    unknownFields: 'report',
    providers: [{ name: 'acme', versionAt: '/api_version', typeAt: '/event' }],
    mappings: [{
      provider: 'acme',
      version: '2',
      sourceType: 'order_created',
      canonicalType: 'order.created',
      sourceId: '/id',
      fields: [{ from: '/data/order_id', to: 'orderId', as: 'string' }],
    }],
    events: [{ ref: 'e1', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1', extra: 'x' } } }],
  }))
  const lines = printed(stderr, 'unknown-fields-reported')

  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.normalized, 1)
  assert.equal(report.normalization.events[0].extensions, undefined)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('WARNING'), true)
  assert.equal(lines[0].startsWith('ERROR  '), false)
})

test('field-optional-missing does not fail the run: exit 0, status pass, 0 errors, printed INFO', async () => {
  const { code, report, stderr } = await normalize(writeJob({
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
        { from: '/data/note', to: 'note', as: 'string', required: false },
      ],
    }],
    events: [{ ref: 'e1', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } }],
  }))
  const lines = printed(stderr, 'field-optional-missing')

  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 1)
  assert.equal(report.summary.normalized, 1)
  assert.equal(Object.hasOwn(report.normalization.events[0].canonical.data, 'note'), false)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('INFO   '), true)
  assert.equal(lines[0].startsWith('ERROR  '), false)
})

test('mapping-unused does not fail the run: exit 0, status pass, 0 errors, printed INFO', async () => {
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
        sourceType: 'order_cancelled',
        canonicalType: 'order.cancelled',
        sourceId: '/id',
        fields: [{ from: '/data/order_id', to: 'orderId', as: 'string' }],
      },
    ],
    events: [{ ref: 'e1', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } }],
  }))
  const lines = printed(stderr, 'mapping-unused')

  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 1)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('INFO   '), true)
  assert.equal(lines[0].startsWith('ERROR  '), false)
})

test('equivalence-confirmed does not fail the run: exit 0, status pass, 0 errors, printed INFO', async () => {
  const { code, report, stderr } = await normalize(writeJob({
    canonicalVersion: '1',
    providers: [
      { name: 'acme', versionAt: '/api_version', typeAt: '/event' },
      { name: 'beta', versionAt: '/schema', typeAt: '/type' },
    ],
    mappings: [
      {
        provider: 'acme',
        version: '2',
        sourceType: 'order_created',
        canonicalType: 'order.created',
        sourceId: '/id',
        fields: [{ from: '/data/total', to: 'amountMinor', as: 'integer' }],
      },
      {
        provider: 'beta',
        version: '9',
        sourceType: 'order.created',
        canonicalType: 'order.created',
        sourceId: '/event_id',
        fields: [{ from: '/amount', to: 'amountMinor', as: 'integer' }],
      },
    ],
    events: [
      { ref: 'left', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { total: 4250 } } },
      { ref: 'right', provider: 'beta', payload: { event_id: 'B1', schema: '9', type: 'order.created', amount: 4250 } },
    ],
    equivalence: [{ id: 'order-created', refs: ['left', 'right'] }],
  }))
  const lines = printed(stderr, 'equivalence-confirmed')

  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 1)
  assert.equal(report.normalization.equivalence[0].match, true)
  assert.deepEqual(report.normalization.events[0].canonical, report.normalization.events[1].canonical)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('INFO   '), true)
  assert.equal(lines[0].startsWith('ERROR  '), false)
})

test('text-sanitised does not fail the run: exit 0, status pass, 0 errors, printed WARNING', async () => {
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
    events: [{
      ref: 'e1',
      provider: 'acme',
      payload: {
        id: `A1${String.fromCharCode(133)}fake`,
        api_version: '2',
        event: 'order_created',
        data: { order_id: 'O1' },
      },
    }],
  }))
  const lines = printed(stderr, 'text-sanitised')

  assert.equal(code, 0)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.summary.info, 0)
  assert.equal(report.normalization.events[0].source.id, 'A1 fake')
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('WARNING'), true)
  assert.equal(lines[0].startsWith('ERROR  '), false)
})

test('output-withheld is a warning on a run that already failed: exit 1, 1 error, 1 warning', async () => {
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
      events: [{ ref: 'e1', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: {} } }],
    }),
    ['--out', '<base>/bundle.json'],
  )
  const lines = printed(stderr, 'output-withheld')

  assert.equal(code, 1)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.errors, 1)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.summary.info, 1)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].startsWith('WARNING'), true)
  assert.equal(lines[0].startsWith('ERROR  '), false)
})

test('the clean job these cases are cut from raises nothing at all', async () => {
  const { code, report } = await normalize(writeJob({
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
    events: [{ ref: 'e1', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } }],
  }))

  assert.deepEqual(report.findings, [], 'otherwise every case above is measuring the wrong thing')
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
  assert.equal(report.summary.checked, 1)
  assert.equal(report.summary.normalized, 1)
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
})
