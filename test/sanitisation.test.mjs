import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { normalizeJob } from '../src/index.mjs'

/**
 * Sanitisation, checked on what the process actually writes.
 *
 * The characters below are not decoration. `U+000A` forges a line in the human
 * report. `U+0085` NEL is a line break to a great many readers and `U+009B` is
 * the 8-bit CSI, so it opens a terminal control sequence with no ESC in sight.
 * `U+2028` and `U+2029` are not escaped by `JSON.stringify`, so they travel
 * through the JSON report intact. `U+202E` reverses everything displayed after
 * it, which is how an event id is made to read as something else.
 *
 * Most of these arrive through an **identifier** here -- a provider event id,
 * an event name, an object key, a fixture path -- rather than through an
 * evidence excerpt, because an id is what this tool prints most and an
 * excerpt-only guard is the one this catalog has already seen fail.
 */

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/webhook-payload-normalizer.mjs')
const CHAR = (code) => String.fromCharCode(code)
const NEWLINE = CHAR(10)

const FORBIDDEN = [
  ['NUL', 0x0000],
  ['BEL', 0x0007],
  ['LF', 0x000a],
  ['ESC', 0x001b],
  ['US', 0x001f],
  ['DEL', 0x007f],
  ['PAD', 0x0080],
  ['NEL', 0x0085],
  ['CSI', 0x009b],
  ['APC', 0x009f],
  ['LINE SEPARATOR', 0x2028],
  ['PARAGRAPH SEPARATOR', 0x2029],
  ['LRM', 0x200e],
  ['RLM', 0x200f],
  ['LRE', 0x202a],
  ['RLO', 0x202e],
  ['LRI', 0x2066],
  ['PDI', 0x2069],
]

const PROVIDER = { name: 'acme', versionAt: '/api_version', typeAt: '/event' }
const MAPPING = {
  provider: 'acme',
  version: '2',
  sourceType: 'order_created',
  canonicalType: 'order.created',
  sourceId: '/id',
  fields: [{ from: '/data/order_id', to: 'orderId', as: 'string' }],
}

function scan(text, skip = []) {
  const found = []
  for (const [name, code] of FORBIDDEN) {
    if (skip.includes(name)) continue
    if (text.includes(CHAR(code))) found.push(name)
  }
  return found
}

/**
 * Scan every string the report holds -- keys as well as values.
 *
 * Serializing the report first and scanning that would be a weaker test than
 * it looks: `JSON.stringify` escapes the whole C0 range, so a raw newline in an
 * event id would come back as the two characters `\n` and a scan for `U+000A`
 * would find nothing. This walks the values themselves.
 */
function scanReport(value, found = new Set()) {
  if (typeof value === 'string') {
    for (const name of scan(value)) found.add(name)
  } else if (Array.isArray(value)) {
    for (const item of value) scanReport(item, found)
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      for (const name of scan(key)) found.add(name)
      scanReport(item, found)
    }
  }
  return [...found].sort()
}

test('every forbidden character arriving through an identifier is gone from the report', async () => {
  for (const [name, code] of FORBIDDEN) {
    const report = await normalizeJob({
      canonicalVersion: '1',
      providers: [PROVIDER],
      mappings: [MAPPING],
      events: [{
        ref: 'e1',
        provider: 'acme',
        payload: {
          id: `id${CHAR(code)}forged`,
          api_version: '2',
          event: 'order_created',
          data: { order_id: 'O1' },
        },
      }],
    })
    assert.deepEqual(scanReport(report), [], `${name} survived through the source event id`)
    assert.equal(report.normalization.events[0].source.id, 'id forged')
    assert.equal(report.findings.some((finding) => finding.ruleId === 'text-sanitised'), true, `${name} must be reported, not silently removed`)
  }
})

test('a forbidden character in an unclaimed field key is gone from the extensions pointer', async () => {
  for (const [name, code] of FORBIDDEN) {
    const report = await normalizeJob({
      canonicalVersion: '1',
      providers: [PROVIDER],
      mappings: [MAPPING],
      events: [{
        ref: 'e1',
        provider: 'acme',
        payload: {
          id: 'A1',
          api_version: '2',
          event: 'order_created',
          data: { order_id: 'O1' },
          [`key${CHAR(code)}forged`]: 'value',
        },
      }],
    })

    assert.deepEqual(scanReport(report), [], `${name} survived through an object key`)
  }
})

test('a forbidden character in a mapped value is gone, and the change is reported', async () => {
  for (const [name, code] of FORBIDDEN) {
    const report = await normalizeJob({
      canonicalVersion: '1',
      providers: [PROVIDER],
      mappings: [MAPPING],
      events: [{
        ref: 'e1',
        provider: 'acme',
        payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: `O${CHAR(code)}1` } },
      }],
    })

    assert.deepEqual(scanReport(report), [], `${name} survived through a mapped value`)
    assert.equal(report.normalization.events[0].canonical.data.orderId, 'O 1')
    assert.equal(report.findings.some((finding) => finding.ruleId === 'text-sanitised'), true)
  }
})

test('a forbidden character in an event name reaches the report only through evidence, sanitised', async () => {
  for (const [name, code] of FORBIDDEN) {
    const report = await normalizeJob({
      canonicalVersion: '1',
      providers: [PROVIDER],
      mappings: [MAPPING],
      events: [{
        ref: 'e1',
        provider: 'acme',
        payload: { id: 'A1', api_version: '2', event: `order${CHAR(code)}created`, data: { order_id: 'O1' } },
      }],
    })

    assert.deepEqual(scanReport(report), [], `${name} survived through an event name`)
    assert.equal(report.findings.some((finding) => finding.ruleId === 'mapping-event-unknown'), true)
  }
})

test('an identifier carrying a newline cannot forge a line in the human report', async () => {
  const base = await mkdtemp(join(tmpdir(), 'webhook-payload-normalizer-sanitise-'))
  try {
    const jobPath = join(base, 'job.json')
    await writeFile(jobPath, JSON.stringify({
      canonicalVersion: '1',
      providers: [PROVIDER],
      mappings: [MAPPING],
      events: [{
        ref: 'e1',
        provider: 'acme',
        payload: {
          id: `A1${NEWLINE}ERROR   forged.json/ nothing-is-wrong everything is fine`,
          api_version: '2',
          event: 'order_created',
          data: { order_id: 'O1' },
        },
      }],
    }))

    const { stdout, stderr } = await run(process.execPath, [CLI, '--job', jobPath, '--label', 'job.json'], { cwd: projectDirectory })

    // LF is excluded here and only here: the JSON report and the human summary
    // are both line-oriented, so their own newlines are the format. That every
    // *value* is free of it is asserted structurally, on the line count below.
    assert.deepEqual(scan(stdout, ['LF']), [])
    assert.deepEqual(scan(stderr, ['LF']), [])
    assert.deepEqual(scanReport(JSON.parse(stdout)), [])
    const report = JSON.parse(stdout)

    assert.equal(
      report.normalization.events[0].source.id,
      'A1 ERROR   forged.json/ nothing-is-wrong everything is fine',
      'the text is still carried across, on one line, as one value',
    )
    assert.equal(
      stderr.split(NEWLINE).filter((line) => line.startsWith('ERROR')).length,
      0,
      'and it forges no line of its own in the human report',
    )
    assert.equal(stderr.split(NEWLINE).filter((line) => line.startsWith('WARNING')).length, 1)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a fixture path carrying a forbidden character is sanitised in location.file', async () => {
  const base = await mkdtemp(join(tmpdir(), 'webhook-payload-normalizer-sanitise-path-'))
  try {
    await mkdir(join(base, 'events'))
    const jobPath = join(base, 'job.json')
    await writeFile(jobPath, JSON.stringify({
      canonicalVersion: '1',
      eventsRoot: 'events',
      providers: [PROVIDER],
      mappings: [MAPPING],
      events: [{ ref: 'e1', provider: 'acme', file: `absent${CHAR(0x202e)}gnp.json` }],
    }))

    const { stdout, stderr } = await run(process.execPath, [CLI, '--job', jobPath, '--label', 'job.json'], { cwd: projectDirectory })
      .catch((error) => ({ stdout: error.stdout, stderr: error.stderr }))
    const report = JSON.parse(stdout)

    assert.deepEqual(scan(stdout, ['LF']), [])
    assert.deepEqual(scan(stderr, ['LF']), [])
    assert.deepEqual(scanReport(report), [])
    assert.equal(report.findings[0].location.file, 'events/absent gnp.json')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a string that needed no sanitising is left exactly as it was', async () => {
  const report = await normalizeJob({
    canonicalVersion: '1',
    providers: [PROVIDER],
    mappings: [MAPPING],
    events: [{
      ref: 'e1',
      provider: 'acme',
      payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: '  keep   my spacing  ' } },
    }],
  })

  assert.equal(report.normalization.events[0].canonical.data.orderId, '  keep   my spacing  ')
  assert.deepEqual(report.findings, [], 'no sanitisation happened, so there is nothing to report')
})
