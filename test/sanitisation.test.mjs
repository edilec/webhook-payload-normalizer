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

test('the scanner finds what it is looking for, everywhere the report could hide it', () => {
  /**
   * The positive control, without which every `deepEqual(scanReport(...), [])`
   * below is unfalsifiable. A `scan` that matched nothing, a `scanReport` that
   * skipped object keys, or a walk that stopped at the first nesting level
   * would each report a clean bill of health for a report full of the very
   * characters this file exists to keep out -- and no assertion here would
   * notice. So the helpers are driven against text that is known bad, one
   * character at a time, and against text that is known good.
   */
  assert.deepEqual(scan('an ordinary identifier'), [])
  for (const [name, code] of FORBIDDEN) {
    assert.deepEqual(scan(`id${CHAR(code)}forged`), [name], `scan must find ${name} when it is there`)
    assert.deepEqual(scan(`id${CHAR(code)}forged`, [name]), [], `scan must honour its skip list for ${name}`)
  }

  const RLO = CHAR(0x202e)
  const NEL = CHAR(0x0085)
  assert.deepEqual(scanReport(`bare${RLO}string`), ['RLO'])
  assert.deepEqual(scanReport([{ deep: [`nested${RLO}value`] }]), ['RLO'], 'the walk reaches through arrays and objects')
  assert.deepEqual(scanReport({ [`key${NEL}forged`]: 'clean' }), ['NEL'], 'an object key is a string the report prints too')
  assert.deepEqual(scanReport({ a: `x${NEL}`, b: [`y${RLO}`] }), ['NEL', 'RLO'], 'every hit is collected, not just the first')
  assert.deepEqual(scanReport({ ok: 'clean', count: 1, nothing: null, list: ['fine'] }), [])
})

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

test('a forbidden character in an event name is incomplete without a false missing-mapping claim', async () => {
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
    assert.equal(report.status, 'incomplete')
    assert.equal(report.findings.some((finding) => finding.ruleId === 'event-type-unresolved'), true)
    assert.equal(report.findings.some((finding) => finding.ruleId === 'mapping-event-unknown'), false)
  }
})

/**
 * The job is untrusted text too.
 *
 * A pointer is written by whoever wrote the job, and this tool quotes it back
 * into the *message* of the finding that refuses it -- not only into the
 * evidence. A guard that sanitised the evidence and trusted the message would
 * pass every test above and still let a control character through here, which
 * is exactly the shape of the excerpt-only guard this catalog has seen fail.
 */
test('a forbidden character in a job pointer is sanitised in the message, not only the evidence', async () => {
  for (const [name, code] of FORBIDDEN) {
    const viaField = await normalizeJob({
      canonicalVersion: '1',
      providers: [PROVIDER],
      mappings: [{ ...MAPPING, fields: [{ from: `/absent${CHAR(code)}field`, to: 'orderId', as: 'string' }] }],
      events: [{ ref: 'e1', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created' } }],
    })

    const required = viaField.findings.find((finding) => finding.ruleId === 'field-required-missing')
    assert.notEqual(required, undefined)
    assert.deepEqual(scan(required.message), [], `${name} survived into a finding message`)
    assert.deepEqual(scanReport(viaField), [], `${name} survived through a mapping pointer`)

    const viaSourceId = await normalizeJob({
      canonicalVersion: '1',
      providers: [PROVIDER],
      mappings: [{ ...MAPPING, sourceId: `/absent${CHAR(code)}id` }],
      events: [{ ref: 'e1', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } }],
    })

    const anonymous = viaSourceId.findings.find((finding) => finding.ruleId === 'source-id-missing')
    assert.notEqual(anonymous, undefined)
    assert.deepEqual(scan(anonymous.message), [], `${name} survived into a source-id message`)

    const viaVersionAt = await normalizeJob({
      canonicalVersion: '1',
      providers: [{ name: 'acme', versionAt: `/absent${CHAR(code)}version`, typeAt: '/event' }],
      mappings: [MAPPING],
      events: [{ ref: 'e1', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } }],
    })

    const unresolved = viaVersionAt.findings.find((finding) => finding.ruleId === 'event-version-unresolved')
    assert.notEqual(unresolved, undefined)
    assert.deepEqual(scan(unresolved.message), [], `${name} survived into a version message`)
    assert.deepEqual(scanReport(viaVersionAt), [], `${name} survived through a provider pointer`)
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

/**
 * The parse-failure path, which every case above walks past.
 *
 * Everything above rides inside a document the tool parsed and then chose to
 * print. A file that does not parse never reaches that code: it is described
 * by V8's own error message instead, and V8 phrases one of its two parse
 * failures as `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid
 * JSON` -- reproducing a short file in full, into a finding on stdout and into
 * the human summary on stderr.
 *
 * `sanitize` cannot repair it: it strips control characters and cuts from the
 * end, and the quoted snippet is at the front.
 *
 * A webhook fixture is a captured provider payload, which is exactly the kind
 * of document that carries a signing secret, a card number or a customer's
 * name; the job file is configuration, which is the other kind. Both parse
 * sites are covered below.
 *
 * The canaries are published placeholders, never real credentials: the example
 * key id from the AWS documentation, the standard test card number that
 * authorises nothing (with a leading letter, because the bare digits are a
 * valid JSON number), and a host under the RFC 2606 `.invalid` reserved
 * top-level domain. Every prefix from eight characters up is scanned on both
 * streams -- a check of the whole value alone passes for output that leaks all
 * but the last character.
 */
const CANARIES = Object.freeze({
  'AWS example access key id': 'AKIAIOSFODNN7EXAMPLE',
  'standard test card number': 'x4111111111111111',
  'reserved example host': 'api.example.invalid',
  'bearer-looking token': 'Bearer-ZXhhbXBsZS10b2tlbg',
})

const MIN_PREFIX = 8

function assertAbsent(text, canary, label) {
  for (let length = MIN_PREFIX; length <= canary.length; length += 1) {
    const prefix = canary.slice(0, length)
    assert.equal(text.includes(prefix), false, `"${prefix}" (${length} chars) reached ${label}`)
  }
}

/** Run the real binary and return both streams, whatever the exit code. */
async function cli(args) {
  return run(process.execPath, [CLI, ...args], { cwd: projectDirectory })
    .then((value) => value, (error) => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '' }))
}

test('an unparseable job file is not quoted back by its own parse error', async () => {
  const base = await mkdtemp(join(tmpdir(), 'webhook-payload-normalizer-parse-job-'))
  try {
    for (const [name, canary] of Object.entries(CANARIES)) {
      const jobPath = join(base, 'job.json')
      await writeFile(jobPath, canary)
      const { stdout, stderr } = await cli(['--job', jobPath, '--label', 'job.json'])

      assert.equal(
        JSON.parse(stdout).findings.some((finding) => finding.ruleId === 'job-not-json'),
        true,
        'the job file must really have failed to parse',
      )
      assertAbsent(stdout, canary, `stdout for ${name}`)
      assertAbsent(stderr, canary, `stderr for ${name}`)
    }
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('an unparseable fixture file is not quoted back by its own parse error', async () => {
  const base = await mkdtemp(join(tmpdir(), 'webhook-payload-normalizer-parse-fixture-'))
  try {
    await mkdir(join(base, 'events'), { recursive: true })
    const jobPath = join(base, 'job.json')
    await writeFile(jobPath, JSON.stringify({
      canonicalVersion: '1',
      eventsRoot: 'events',
      providers: [PROVIDER],
      mappings: [MAPPING],
      events: [{ ref: 'e1', provider: 'acme', version: '2', file: 'capture.json' }],
    }))

    for (const [name, canary] of Object.entries(CANARIES)) {
      await writeFile(join(base, 'events', 'capture.json'), canary)
      const { stdout, stderr } = await cli(['--job', jobPath, '--label', 'job.json'])

      assert.equal(
        JSON.parse(stdout).findings.some((finding) => finding.ruleId === 'event-file-not-json'),
        true,
        'the fixture must really have failed to parse',
      )
      assertAbsent(stdout, canary, `stdout for ${name}`)
      assertAbsent(stderr, canary, `stderr for ${name}`)
    }
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

/**
 * The other half of the fix: a diagnostic that says nothing is a different
 * defect. A fixture missing one comma reports a position, a line and a column
 * rather than a quotation, and that is what a reader needs to find the spot.
 */
test('a parse failure still says where the document went wrong', async () => {
  const base = await mkdtemp(join(tmpdir(), 'webhook-payload-normalizer-parse-position-'))
  try {
    const jobPath = join(base, 'job.json')
    await writeFile(jobPath, '{\n  "canonicalVersion": "1"\n  "events": []\n}\n')
    const { stdout } = await cli(['--job', jobPath, '--label', 'job.json'])

    const finding = JSON.parse(stdout).findings.find((row) => row.ruleId === 'job-not-json')
    assert.notEqual(finding, undefined)
    assert.match(finding.message, /position \d+/)
    assert.match(finding.message, /line \d+ column \d+/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
