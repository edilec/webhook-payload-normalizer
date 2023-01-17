import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { normalizeJob } from '../src/index.mjs'

const run = promisify(execFile)
const CLI = new URL('../bin/webhook-payload-normalizer.mjs', import.meta.url)
const EXAMPLE = JSON.parse(readFileSync(new URL('../examples/clean/job.json', import.meta.url), 'utf8'))
const ACME_PAYLOAD = JSON.parse(readFileSync(new URL('../examples/clean/events/acme-order-created.json', import.meta.url), 'utf8'))
const MAPPING_CANARY = 'token=SYNTHETIC_SECRET_CANARY'
const PROVIDER_CANARY = 'SYNTHETIC_PROVIDER_CANARY'

function cleanInlineJob() {
  return {
    canonicalVersion: EXAMPLE.canonicalVersion,
    unknownFields: EXAMPLE.unknownFields,
    providers: [structuredClone(EXAMPLE.providers[0])],
    mappings: [structuredClone(EXAMPLE.mappings[0])],
    events: [{ ref: 'acme-order', provider: 'acme', payload: structuredClone(ACME_PAYLOAD) }],
  }
}

function withUnusedCatalogIdentities() {
  const job = cleanInlineJob()
  job.providers.push({ name: PROVIDER_CANARY, versionAt: '/api_version', typeAt: '/event' })
  job.mappings.push({ ...structuredClone(job.mappings[0]), sourceType: MAPPING_CANARY })
  return job
}

async function runCliJob(job) {
  const base = await mkdtemp(join(tmpdir(), 'webhook-catalog-diagnostic-'))
  try {
    const input = join(base, 'job.json')
    await writeFile(input, JSON.stringify(job))
    const result = await run(process.execPath, [CLI.pathname, '--job', input]).catch((error) => error)
    return { code: result.code ?? 0, stdout: result.stdout, stderr: result.stderr }
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

test('an unused provider and mapping expose only source pointers while exact event selection stays intact', async () => {
  const control = await normalizeJob(cleanInlineJob())
  const report = await normalizeJob(withUnusedCatalogIdentities())
  assert.equal(control.status, 'pass')
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 1)
  assert.equal(JSON.stringify(report).includes(MAPPING_CANARY), false)
  assert.equal(JSON.stringify(report).includes(PROVIDER_CANARY), false)
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.normalization.schemaVersion, '2')
  assert.deepEqual(report.normalization.providers, ['/providers/0', '/providers/1'])
  assert.deepEqual(report.normalization.mappings, ['/mappings/0', '/mappings/1'])
  assert.deepEqual(report.normalization.events, control.normalization.events)
  assert.equal(report.normalization.events[0].source.provider, 'acme')
  assert.equal(report.normalization.events[0].source.version, '2')
  assert.equal(report.normalization.events[0].source.type, 'order_created')
  assert.ok(report.findings.some((finding) => finding.ruleId === 'mapping-unused'))
})

test('the CLI report, human summary and v2 output bundle omit unused catalog canaries', async () => {
  const base = await mkdtemp(join(tmpdir(), 'webhook-catalog-privacy-'))
  try {
    const input = join(base, 'job.json')
    const output = join(base, 'bundle.json')
    await writeFile(input, JSON.stringify(withUnusedCatalogIdentities()))
    const { stdout, stderr } = await run(process.execPath, [CLI.pathname, '--job', input, '--out', output])
    const report = JSON.parse(stdout)
    const bundle = JSON.parse(await readFile(output, 'utf8'))
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.checked, 1)
    for (const stream of [stdout, stderr, JSON.stringify(bundle)]) {
      assert.equal(stream.includes(MAPPING_CANARY), false)
      assert.equal(stream.includes(PROVIDER_CANARY), false)
    }
    assert.equal(report.schemaVersion, '1')
    assert.equal(bundle.schemaVersion, '2')
    assert.deepEqual(bundle, report.normalization)
    assert.deepEqual(bundle.providers, ['/providers/0', '/providers/1'])
    assert.deepEqual(bundle.mappings, ['/mappings/0', '/mappings/1'])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('an invalid job still identifies the nested normalization shape without catalog values', async () => {
  const report = await normalizeJob({})
  assert.equal(report.status, 'incomplete')
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.normalization.schemaVersion, '2')
  assert.deepEqual(report.normalization.providers, [])
  assert.deepEqual(report.normalization.mappings, [])
  assert.deepEqual(report.normalization.events, [])
})

test('duplicate provider diagnostics identify both source rows without exposing their name', async () => {
  const distinct = withUnusedCatalogIdentities()
  const good = await normalizeJob(distinct)
  assert.equal(good.status, 'pass')
  assert.equal(good.summary.checked, 1)

  const duplicate = structuredClone(distinct)
  duplicate.providers.push(structuredClone(duplicate.providers[1]))
  const report = await normalizeJob(duplicate)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.ok(report.findings.some((row) => row.ruleId === 'no-events-checked'))
  const finding = report.findings.find((row) => row.ruleId === 'job-invalid'
    && row.location.pointer === '/providers/2/name')
  assert.ok(finding)
  assert.match(finding.message, /\/providers\/1\/name/u)
  assert.equal(JSON.stringify(report).includes(PROVIDER_CANARY), false)

  const cli = await runCliJob(duplicate)
  assert.equal(cli.code, 2)
  assert.equal(JSON.parse(cli.stdout).status, 'incomplete')
  assert.equal(cli.stdout.includes(PROVIDER_CANARY), false)
  assert.equal(cli.stderr.includes(PROVIDER_CANARY), false)
})

test('duplicate mapping diagnostics identify both source rows without exposing identity values', async () => {
  const distinct = withUnusedCatalogIdentities()
  const good = await normalizeJob(distinct)
  assert.equal(good.status, 'pass')
  assert.equal(good.summary.checked, 1)

  const duplicate = structuredClone(distinct)
  duplicate.mappings.push(structuredClone(duplicate.mappings[1]))
  const report = await normalizeJob(duplicate)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.ok(report.findings.some((row) => row.ruleId === 'no-events-checked'))
  const finding = report.findings.find((row) => row.ruleId === 'mapping-duplicate'
    && row.location.pointer === '/mappings/2')
  assert.ok(finding)
  assert.match(finding.message, /\/mappings\/1/u)
  assert.equal(JSON.stringify(report).includes(MAPPING_CANARY), false)
  assert.equal(JSON.stringify(report).includes(PROVIDER_CANARY), false)

  const cli = await runCliJob(duplicate)
  assert.equal(cli.code, 2)
  assert.equal(JSON.parse(cli.stdout).status, 'incomplete')
  for (const stream of [cli.stdout, cli.stderr]) {
    assert.equal(stream.includes(MAPPING_CANARY), false)
    assert.equal(stream.includes(PROVIDER_CANARY), false)
  }
})

test('unknown job keys identify their container and member ordinal without echoing key text', async () => {
  const control = await normalizeJob(withUnusedCatalogIdentities())
  assert.equal(control.status, 'pass')

  const job = withUnusedCatalogIdentities()
  job.providers[0][MAPPING_CANARY] = true
  const report = await normalizeJob(job)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  const finding = report.findings.find((row) => row.ruleId === 'job-unknown-key')
  assert.ok(finding)
  assert.equal(finding.location.pointer, '/providers/0')
  assert.match(finding.message, /member ordinal 4/u)
  assert.equal(JSON.stringify(report).includes(MAPPING_CANARY), false)

  const cli = await runCliJob(job)
  assert.equal(cli.code, 2)
  assert.equal(JSON.parse(cli.stdout).status, 'incomplete')
  assert.equal(cli.stdout.includes(MAPPING_CANARY), false)
  assert.equal(cli.stderr.includes(MAPPING_CANARY), false)
})

test('duplicate canonical field diagnostics identify both declarations without field text', async () => {
  const control = await normalizeJob(withUnusedCatalogIdentities())
  assert.equal(control.status, 'pass')

  const job = withUnusedCatalogIdentities()
  const field = { ...job.mappings[0].fields[0], to: PROVIDER_CANARY }
  job.mappings[0].fields = [field, { ...field, from: '/id' }]
  const report = await normalizeJob(job)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  const finding = report.findings.find((row) => row.ruleId === 'job-invalid'
    && row.location.pointer === '/mappings/0/fields/1/to')
  assert.ok(finding)
  assert.match(finding.message, /\/mappings\/0\/fields\/0\/to/u)
  assert.equal(JSON.stringify(report).includes(PROVIDER_CANARY), false)

  const cli = await runCliJob(job)
  assert.equal(cli.code, 2)
  assert.equal(cli.stdout.includes(PROVIDER_CANARY), false)
  assert.equal(cli.stderr.includes(PROVIDER_CANARY), false)
})

test('undeclared mapping provider diagnostics keep the source pointer without its name', async () => {
  const control = await normalizeJob(cleanInlineJob())
  assert.equal(control.status, 'pass')

  const job = cleanInlineJob()
  job.mappings[0].provider = PROVIDER_CANARY
  const report = await normalizeJob(job)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  const finding = report.findings.find((row) => row.ruleId === 'job-invalid'
    && row.location.pointer === '/mappings/0/provider')
  assert.ok(finding)
  assert.match(finding.message, /provider not declared/u)
  assert.equal(JSON.stringify(report).includes(PROVIDER_CANARY), false)

  const cli = await runCliJob(job)
  assert.equal(cli.code, 2)
  assert.equal(cli.stdout.includes(PROVIDER_CANARY), false)
  assert.equal(cli.stderr.includes(PROVIDER_CANARY), false)
})

test('unsupported provider version pointer reports its source without echoing its value', async () => {
  const good = await normalizeJob(cleanInlineJob())
  assert.equal(good.status, 'pass')
  assert.equal(good.summary.checked, 1)

  const job = cleanInlineJob()
  job.providers[0].versionAt = MAPPING_CANARY
  const report = await normalizeJob(job)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  const finding = report.findings.find((row) => row.ruleId === 'mapping-unsupported-construct'
    && row.location.pointer === '/providers/0/versionAt')
  assert.ok(finding)
  assert.match(finding.message, /pointer this tool supports/u)
  assert.equal(JSON.stringify(report).includes(MAPPING_CANARY), false)

  const cli = await runCliJob(job)
  assert.equal(cli.code, 2)
  assert.equal(JSON.parse(cli.stdout).status, 'incomplete')
  assert.equal(cli.stdout.includes(MAPPING_CANARY), false)
  assert.equal(cli.stderr.includes('mapping-unsupported-construct'), true)
  assert.equal(cli.stderr.includes(MAPPING_CANARY), false)

  const cleanCli = await runCliJob(cleanInlineJob())
  assert.equal(cleanCli.code, 0)
  assert.equal(JSON.parse(cleanCli.stdout).status, 'pass')
})

test('unsupported field type reports its source without echoing its value', async () => {
  const good = await normalizeJob(cleanInlineJob())
  assert.equal(good.status, 'pass')
  assert.equal(good.summary.checked, 1)

  const job = cleanInlineJob()
  job.mappings[0].fields[0].as = MAPPING_CANARY
  const report = await normalizeJob(job)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  const finding = report.findings.find((row) => row.ruleId === 'mapping-unsupported-construct'
    && row.location.pointer === '/mappings/0/fields/0/as')
  assert.ok(finding)
  assert.match(finding.message, /must be one of/u)
  assert.equal(JSON.stringify(report).includes(MAPPING_CANARY), false)

  const cli = await runCliJob(job)
  assert.equal(cli.code, 2)
  assert.equal(JSON.parse(cli.stdout).status, 'incomplete')
  assert.equal(cli.stdout.includes(MAPPING_CANARY), false)
  assert.equal(cli.stderr.includes('mapping-unsupported-construct'), true)
  assert.equal(cli.stderr.includes(MAPPING_CANARY), false)

  const cleanCli = await runCliJob(cleanInlineJob())
  assert.equal(cleanCli.code, 0)
  assert.equal(JSON.parse(cleanCli.stdout).status, 'pass')
})

test('unsupported field transform reports its source without echoing its value', async () => {
  const good = await normalizeJob(cleanInlineJob())
  assert.equal(good.status, 'pass')
  assert.equal(good.summary.checked, 1)

  const job = cleanInlineJob()
  job.mappings[0].fields[0].transform = MAPPING_CANARY
  const report = await normalizeJob(job)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  const finding = report.findings.find((row) => row.ruleId === 'mapping-unsupported-construct'
    && row.location.pointer === '/mappings/0/fields/0/transform')
  assert.ok(finding)
  assert.match(finding.message, /must be one of/u)
  assert.equal(JSON.stringify(report).includes(MAPPING_CANARY), false)

  const cli = await runCliJob(job)
  assert.equal(cli.code, 2)
  assert.equal(JSON.parse(cli.stdout).status, 'incomplete')
  assert.equal(cli.stdout.includes(MAPPING_CANARY), false)
  assert.equal(cli.stderr.includes('mapping-unsupported-construct'), true)
  assert.equal(cli.stderr.includes(MAPPING_CANARY), false)

  const cleanCli = await runCliJob(cleanInlineJob())
  assert.equal(cleanCli.code, 0)
  assert.equal(JSON.parse(cleanCli.stdout).status, 'pass')
})

test('duplicate fixture ref diagnostics identify both declarations without ref text', async () => {
  const distinct = cleanInlineJob()
  distinct.events.push({ ...structuredClone(distinct.events[0]), ref: 'e2' })
  const control = await normalizeJob(distinct)
  assert.equal(control.status, 'pass')
  assert.equal(control.summary.checked, 2)

  const job = structuredClone(distinct)
  job.events[0].ref = PROVIDER_CANARY
  job.events[1].ref = PROVIDER_CANARY
  const report = await normalizeJob(job)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  const finding = report.findings.find((row) => row.ruleId === 'job-invalid'
    && row.location.pointer === '/events/1/ref')
  assert.ok(finding)
  assert.match(finding.message, /\/events\/0\/ref/u)
  assert.equal(JSON.stringify(report).includes(PROVIDER_CANARY), false)

  const cli = await runCliJob(job)
  assert.equal(cli.code, 2)
  assert.equal(cli.stdout.includes(PROVIDER_CANARY), false)
  assert.equal(cli.stderr.includes(PROVIDER_CANARY), false)
})

test('duplicate equivalence group diagnostics identify both declarations without group id', async () => {
  const distinct = cleanInlineJob()
  distinct.events.push({ ...structuredClone(distinct.events[0]), ref: 'e2' })
  distinct.equivalence = [
    { id: 'g1', refs: ['acme-order', 'e2'] },
    { id: 'g2', refs: ['acme-order', 'e2'] },
  ]
  const control = await normalizeJob(distinct)
  assert.equal(control.status, 'pass')
  assert.equal(control.summary.checked, 2)

  const job = structuredClone(distinct)
  job.equivalence[0].id = PROVIDER_CANARY
  job.equivalence[1].id = PROVIDER_CANARY
  const report = await normalizeJob(job)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  const finding = report.findings.find((row) => row.ruleId === 'job-invalid'
    && row.location.pointer === '/equivalence/1/id')
  assert.ok(finding)
  assert.match(finding.message, /\/equivalence\/0\/id/u)
  assert.equal(JSON.stringify(report).includes(PROVIDER_CANARY), false)

  const cli = await runCliJob(job)
  assert.equal(cli.code, 2)
  assert.equal(cli.stdout.includes(PROVIDER_CANARY), false)
  assert.equal(cli.stderr.includes(PROVIDER_CANARY), false)
})

test('unknown equivalence refs identify the source array position without ref text', async () => {
  const distinct = cleanInlineJob()
  distinct.events.push({ ...structuredClone(distinct.events[0]), ref: 'e2' })
  distinct.equivalence = [{ id: 'group', refs: ['acme-order', 'e2'] }]
  const control = await normalizeJob(distinct)
  assert.equal(control.status, 'pass')
  assert.equal(control.summary.checked, 2)

  const job = structuredClone(distinct)
  job.equivalence[0].refs[1] = PROVIDER_CANARY
  const report = await normalizeJob(job)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  const finding = report.findings.find((row) => row.ruleId === 'job-invalid'
    && row.location.pointer === '/equivalence/0/refs/1')
  assert.ok(finding, JSON.stringify(report.findings))
  assert.match(finding.message, /not declared by "events"/u)
  assert.equal(JSON.stringify(report).includes(PROVIDER_CANARY), false)

  const cli = await runCliJob(job)
  assert.equal(cli.code, 2)
  assert.equal(cli.stdout.includes(PROVIDER_CANARY), false)
  assert.equal(cli.stderr.includes(PROVIDER_CANARY), false)
})
