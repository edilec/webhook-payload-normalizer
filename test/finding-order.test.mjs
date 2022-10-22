import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { DEFAULT_LIMITS, RULE_SEVERITY, SUPPORTED_TRANSFORMS, SUPPORTED_TYPES, UNKNOWN_FIELD_POLICIES, sortFindings } from '../src/index.mjs'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/webhook-payload-normalizer.mjs')

/**
 * Ordering, pinned at every site that decides it.
 *
 * Scanning the source for a comparator name proves nothing: `Intl.Collator`
 * collates like `localeCompare` and spells like neither, and either of them can
 * be substituted at one call site at a time while the grep stays green. Pinning
 * `byCodeUnit` itself proves nothing either, for the same reason -- eleven
 * call sites, each swappable on its own.
 *
 * So each test below drives values whose collation order and code-unit order
 * genuinely disagree through the real binary, at one site, and pins the exact
 * sequence that comes out. The values are chosen for their disagreements: `Z`
 * sorts before `a` by code unit (0x5A before 0x61) and after it by English
 * collation, and `a-b` sorts before `a_b` by code unit (0x2D before 0x5F) and
 * after it by collation, because collation treats the punctuation as
 * ignorable.
 *
 * The last test names the one site where no such value exists, and proves the
 * claim by enumerating every ordered pair of the real values rather than
 * asserting it.
 */

const DISAGREE = ['Z', 'a', 'a-b', 'a_b']

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'webhook-payload-normalizer-order-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function normalize(build) {
  return withBase(async (base) => {
    const jobPath = await build(base)
    try {
      const { stdout, stderr } = await run(process.execPath, [CLI, '--job', jobPath, '--label', 'job.json'], { cwd: projectDirectory })
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

test('an English collator really does order these strings the other way', () => {
  const collator = new Intl.Collator('en')

  assert.equal([...DISAGREE].sort((left, right) => collator.compare(left, right)).join(' '), 'a a_b a-b Z')
  assert.equal([...DISAGREE].sort().join(' '), 'Z a a-b a_b', 'otherwise every test below would prove nothing')
})

/**
 * Site 1 -- `location.file`.
 *
 * Four fixtures that cannot be parsed, each producing one finding labelled with
 * its own path. They are declared in the job in the reverse of their code-unit
 * order, so the pointers count down while the files count up: if the file key
 * stopped deciding, the sequence would change.
 */
test('findings order by file in code units, through the real binary', async () => {
  const { report } = await normalize(async (base) => {
    await mkdir(join(base, 'events'))
    for (const name of DISAGREE) await writeFile(join(base, 'events', `${name}.json`), '{ "id": ')
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
        { ref: 'r0', provider: 'acme', file: 'a_b.json' },
        { ref: 'r1', provider: 'acme', file: 'a.json' },
        { ref: 'r2', provider: 'acme', file: 'a-b.json' },
        { ref: 'r3', provider: 'acme', file: 'Z.json' },
      ],
    })(base)
  })

  assert.deepEqual(report.findings.map((finding) => `${finding.location.file}${finding.location.pointer}`), [
    'events/Z.json/events/3',
    'events/a-b.json/events/2',
    'events/a.json/events/1',
    'events/a_b.json/events/0',
    'job.json/events',
    'job.json/mappings/0',
  ])
})

/**
 * Site 2 -- `location.pointer`, which carries arbitrary user text: an unknown
 * job key becomes the pointer of the finding that refuses it.
 */
test('findings order by pointer in code units, through the real binary', async () => {
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
    events: [{ ref: 'ok', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } }],
    'a_b': 1,
    'a-b': 1,
    a: 1,
    Z: 1,
  }))

  assert.equal(code, 2)
  assert.deepEqual(report.findings.map((finding) => finding.location.pointer), [
    '/Z',
    '/a',
    '/a-b',
    '/a_b',
    '/events',
  ])
})

/**
 * Site 4 -- `message`. Four refusals that share a file, a pointer and a rule
 * id, and differ only in the fixture ref each one quotes.
 */
test('findings order by message in code units, through the real binary', async () => {
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
    events: [{ ref: 'ok', provider: 'acme', payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' } } }],
    equivalence: [{ id: 'group', refs: ['a_b', 'a', 'a-b', 'Z'] }],
  }))
  const refused = report.findings.filter((finding) => finding.location.pointer === '/equivalence/0/refs')

  assert.equal(code, 2)
  assert.equal(refused.length, 4)
  assert.equal(
    refused[0].message,
    'Equivalence group names fixture ref "Z", which "events" does not declare.',
  )
  assert.deepEqual(refused.map((finding) => finding.message.split('"')[1]), ['Z', 'a', 'a-b', 'a_b'])

  // And the human summary prints them in that same order, line by line.
  const printed = stderr.split(String.fromCharCode(10)).filter((line) => line.includes('Equivalence group names fixture ref'))
  assert.deepEqual(printed.map((line) => line.split('"')[1]), ['Z', 'a', 'a-b', 'a_b'])
})

/**
 * Site 5 -- `evidence`, the last key, and the one a report usually cannot
 * exercise because no two findings tie on everything before it.
 *
 * They tie here by construction: the message for a refused unclaimed field says
 * only what the policy is, and the field's pointer is the evidence. Four
 * unclaimed fields therefore produce four findings identical in file, pointer,
 * rule id and message, so evidence is the only key left to decide.
 */
test('findings order by evidence in code units, through the real binary', async () => {
  const { code, report } = await normalize(writeJob({
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
    events: [{
      ref: 'ok',
      provider: 'acme',
      payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' }, 'a_b': 1, 'a-b': 1, a: 1, Z: 1 },
    }],
  }))
  const refused = report.findings.filter((finding) => finding.ruleId === 'unknown-fields-rejected')

  assert.equal(code, 1)
  assert.equal(refused.length, 4)
  assert.equal(new Set(refused.map((finding) => finding.message)).size, 1, 'the four findings must tie on message')
  assert.equal(new Set(refused.map((finding) => finding.location.pointer)).size, 1, 'and on pointer')
  assert.deepEqual(refused.map((finding) => finding.evidence), ['/Z', '/a', '/a-b', '/a_b'])
})

/**
 * Site 6 -- the leaf walk, which decides the order of the `extensions` entries
 * a preserved payload carries into the canonical bundle.
 *
 * The keys are written into the fixture in the reverse of their code-unit
 * order, so JSON key order cannot be what produced the answer.
 */
test('preserved extensions order by pointer in code units, through the real binary', async () => {
  const { code, report } = await normalize(writeJob({
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
    events: [{
      ref: 'ok',
      provider: 'acme',
      payload: { id: 'A1', api_version: '2', event: 'order_created', data: { order_id: 'O1' }, 'a_b': 1, 'a-b': 1, a: 1, Z: 1 },
    }],
  }))

  assert.equal(code, 0)
  assert.deepEqual(report.normalization.events[0].extensions.map((entry) => entry.pointer), ['/Z', '/a', '/a-b', '/a_b'])
})

/**
 * Site 7 -- the key order of the canonical `data` object, which is the key
 * order of the emitted JSON and therefore part of the byte-identical output
 * this tool promises.
 *
 * The fields are declared in the mapping in the reverse of their code-unit
 * order, so declaration order cannot be what produced the answer.
 */
test('canonical data keys order in code units, through the real binary', async () => {
  const { code, report } = await normalize(writeJob({
    canonicalVersion: '1',
    providers: [{ name: 'acme', versionAt: '/api_version', typeAt: '/event' }],
    mappings: [{
      provider: 'acme',
      version: '2',
      sourceType: 'order_created',
      canonicalType: 'order.created',
      sourceId: '/id',
      fields: [
        { from: '/four', to: 'a_b', as: 'string' },
        { from: '/three', to: 'a', as: 'string' },
        { from: '/two', to: 'a-b', as: 'string' },
        { from: '/one', to: 'Z', as: 'string' },
      ],
    }],
    events: [{
      ref: 'ok',
      provider: 'acme',
      payload: { id: 'A1', api_version: '2', event: 'order_created', one: '1', two: '2', three: '3', four: '4' },
    }],
  }))

  assert.equal(code, 0)
  assert.deepEqual(Object.keys(report.normalization.events[0].canonical.data), ['Z', 'a', 'a-b', 'a_b'])
})

/**
 * Sites 8 and 9 -- the provider list and the mapping list in the report, both
 * declared in the reverse of their code-unit order.
 */
test('the provider and mapping lists order in code units, through the real binary', async () => {
  const { code, report } = await normalize(writeJob({
    canonicalVersion: '1',
    providers: [
      { name: 'a_b', versionAt: '/api_version', typeAt: '/event' },
      { name: 'a', versionAt: '/api_version', typeAt: '/event' },
      { name: 'a-b', versionAt: '/api_version', typeAt: '/event' },
      { name: 'Z', versionAt: '/api_version', typeAt: '/event' },
    ],
    mappings: [
      { provider: 'a_b', version: '1', sourceType: 'e', canonicalType: 'c', sourceId: '/id', fields: [{ from: '/v', to: 'value', as: 'string' }] },
      { provider: 'a', version: '1', sourceType: 'e', canonicalType: 'c', sourceId: '/id', fields: [{ from: '/v', to: 'value', as: 'string' }] },
      { provider: 'a-b', version: '1', sourceType: 'e', canonicalType: 'c', sourceId: '/id', fields: [{ from: '/v', to: 'value', as: 'string' }] },
      { provider: 'Z', version: '1', sourceType: 'e', canonicalType: 'c', sourceId: '/id', fields: [{ from: '/v', to: 'value', as: 'string' }] },
    ],
    events: [{ ref: 'ok', provider: 'Z', payload: { id: 'A1', api_version: '1', event: 'e', v: 'x' } }],
  }))

  assert.equal(code, 0)
  assert.deepEqual(report.normalization.providers, ['Z', 'a', 'a-b', 'a_b'])
  assert.deepEqual(report.normalization.mappings, ['Z@1@e', 'a-b@1@e', 'a@1@e', 'a_b@1@e'])
})

/**
 * Site 10 -- which difference an equivalence mismatch names first when more
 * than one canonical field differs.
 */
test('an equivalence mismatch names the first differing field in code units', async () => {
  const { code, report } = await normalize(writeJob({
    canonicalVersion: '1',
    providers: [
      { name: 'left', versionAt: '/api_version', typeAt: '/event' },
      { name: 'right', versionAt: '/api_version', typeAt: '/event' },
    ],
    mappings: [
      {
        provider: 'left',
        version: '1',
        sourceType: 'e',
        canonicalType: 'c',
        sourceId: '/id',
        fields: [
          { from: '/one', to: 'Z', as: 'string' },
          { from: '/two', to: 'a', as: 'string' },
        ],
      },
      {
        provider: 'right',
        version: '1',
        sourceType: 'e',
        canonicalType: 'c',
        sourceId: '/id',
        fields: [
          { from: '/one', to: 'Z', as: 'string' },
          { from: '/two', to: 'a', as: 'string' },
        ],
      },
    ],
    events: [
      { ref: 'l', provider: 'left', payload: { id: 'A1', api_version: '1', event: 'e', one: '1', two: '2' } },
      { ref: 'r', provider: 'right', payload: { id: 'B1', api_version: '1', event: 'e', one: 'x', two: 'y' } },
    ],
    equivalence: [{ id: 'group', refs: ['l', 'r'] }],
  }))
  const mismatch = report.findings.filter((finding) => finding.ruleId === 'equivalence-mismatch')

  assert.equal(code, 1)
  assert.equal(mismatch.length, 1)
  assert.equal(mismatch[0].evidence, 'data/Z')
})

/**
 * Site 11 -- the list of known versions a refusal offers as a suggestion.
 *
 * A version string may hold a dot, a dash or an underscore, so this list is as
 * capable of collating differently as any other, and it reaches the reader of
 * the report as advice about what to do next.
 */
test('the known versions named in a refusal order in code units', async () => {
  const { code, report } = await normalize(writeJob({
    canonicalVersion: '1',
    providers: [{ name: 'acme', versionAt: '/api_version', typeAt: '/event' }],
    mappings: [
      { provider: 'acme', version: 'a_b', sourceType: 'e', canonicalType: 'c', sourceId: '/id', fields: [{ from: '/v', to: 'value', as: 'string' }] },
      { provider: 'acme', version: 'a', sourceType: 'e', canonicalType: 'c', sourceId: '/id', fields: [{ from: '/v', to: 'value', as: 'string' }] },
      { provider: 'acme', version: 'a-b', sourceType: 'e', canonicalType: 'c', sourceId: '/id', fields: [{ from: '/v', to: 'value', as: 'string' }] },
      { provider: 'acme', version: 'Z', sourceType: 'e', canonicalType: 'c', sourceId: '/id', fields: [{ from: '/v', to: 'value', as: 'string' }] },
    ],
    events: [{ ref: 'ok', provider: 'acme', payload: { id: 'A1', api_version: 'zz', event: 'e', v: 'x' } }],
  }))
  const refusal = report.findings.filter((finding) => finding.ruleId === 'mapping-version-unknown')

  assert.equal(code, 1)
  assert.equal(refusal.length, 1)
  assert.equal(refusal[0].suggestion, 'Write a mapping for this version. Versions with a mapping: Z, a, a-b, a_b.')
})

/**
 * Site 3 -- the rule id, and the reason no fixture can pin it.
 *
 * Every rule id in this tool is spelled over `[a-z0-9-]`, and over that
 * alphabet an English collator agrees with code units on every ordered pair. So
 * substituting one comparison for the other at that site changes no output
 * anywhere, and no fixture could show that it had. That is an equivalent
 * mutant, not a gap -- and it is proved here by enumeration rather than
 * asserted.
 *
 * The same enumeration covers the other closed alphabets this tool emits, and
 * it is also the alarm: add a rule id, a policy name, a type name, a transform
 * name or a limit name whose collation disagrees, and the site stops being
 * unpinnable and this test says so.
 */
test('the closed alphabets that reach output collate exactly as their code units do', () => {
  const collator = new Intl.Collator('en')
  const sign = (value) => (value < 0 ? -1 : value > 0 ? 1 : 0)

  const disagreements = (values) => {
    const found = []
    let pairs = 0
    for (const left of values) {
      for (const right of values) {
        if (left === right) continue
        pairs += 1
        const codeUnit = left < right ? -1 : 1
        if (codeUnit !== sign(collator.compare(left, right))) found.push(`${left} vs ${right}`)
      }
    }
    return { pairs, found }
  }

  const ruleIds = disagreements(Object.keys(RULE_SEVERITY))
  assert.equal(ruleIds.pairs, 1806)
  assert.deepEqual(ruleIds.found, [])

  const policies = disagreements([...UNKNOWN_FIELD_POLICIES])
  assert.equal(policies.pairs, 6)
  assert.deepEqual(policies.found, [])

  const types = disagreements([...SUPPORTED_TYPES])
  assert.equal(types.pairs, 12)
  assert.deepEqual(types.found, [])

  const transforms = disagreements([...SUPPORTED_TRANSFORMS])
  assert.equal(transforms.pairs, 12)
  assert.deepEqual(transforms.found, [])

  const limits = disagreements(Object.keys(DEFAULT_LIMITS))
  assert.equal(limits.pairs, 56)
  assert.deepEqual(limits.found, [])

  // The method finds disagreements where there are some: Z against each of the
  // three lower-case values, both ways, and a-b against a_b, both ways.
  assert.equal(disagreements(DISAGREE).pairs, 12)
  assert.equal(disagreements(DISAGREE).found.length, 8)
})

/**
 * The exported sorter, pinned on the same values.
 *
 * Callers that merge reports from several runs use `sortFindings` directly, and
 * this is the order it owes them. It is a second look at sites 1 to 5 from the
 * public API rather than through a fixture.
 */
test('the exported sorter orders by file, then pointer, then rule id, then message, then evidence', () => {
  const finding = (file, pointer, ruleId, message, evidence) => ({
    ruleId,
    severity: 'error',
    message,
    location: { file, pointer },
    ...(evidence === undefined ? {} : { evidence }),
  })

  const byFile = sortFindings([
    finding('a_b.json', '/', 'job-invalid', 'x'),
    finding('a-b.json', '/', 'job-invalid', 'x'),
    finding('a.json', '/', 'job-invalid', 'x'),
    finding('Z.json', '/', 'job-invalid', 'x'),
  ])
  assert.deepEqual(byFile.map((item) => item.location.file), ['Z.json', 'a-b.json', 'a.json', 'a_b.json'])

  const byPointer = sortFindings([
    finding('job.json', '/a_b', 'job-invalid', 'x'),
    finding('job.json', '/Z', 'job-invalid', 'x'),
    finding('job.json', '/a-b', 'job-invalid', 'x'),
  ])
  assert.deepEqual(byPointer.map((item) => item.location.pointer), ['/Z', '/a-b', '/a_b'])

  const byRuleId = sortFindings([
    finding('job.json', '/', 'job-unknown-key', 'x'),
    finding('job.json', '/', 'job-invalid', 'x'),
  ])
  assert.deepEqual(byRuleId.map((item) => item.ruleId), ['job-invalid', 'job-unknown-key'])

  const byMessage = sortFindings([
    finding('job.json', '/', 'job-invalid', 'a_b'),
    finding('job.json', '/', 'job-invalid', 'Z'),
    finding('job.json', '/', 'job-invalid', 'a-b'),
  ])
  assert.deepEqual(byMessage.map((item) => item.message), ['Z', 'a-b', 'a_b'])

  const byEvidence = sortFindings([
    finding('job.json', '/', 'job-invalid', 'x', 'a_b'),
    finding('job.json', '/', 'job-invalid', 'x', 'Z'),
    finding('job.json', '/', 'job-invalid', 'x', 'a-b'),
    finding('job.json', '/', 'job-invalid', 'x'),
  ])
  assert.deepEqual(byEvidence.map((item) => item.evidence ?? ''), ['', 'Z', 'a-b', 'a_b'])
})
