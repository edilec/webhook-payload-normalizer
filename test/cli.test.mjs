import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/webhook-payload-normalizer.mjs')
const NEWLINE = String.fromCharCode(10)

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

async function cli(args, options = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: projectDirectory, ...options })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

async function withJob(body, use) {
  const base = await mkdtemp(join(tmpdir(), 'webhook-payload-normalizer-cli-'))
  try {
    const jobPath = join(base, 'job.json')
    await writeFile(jobPath, JSON.stringify(body, null, 2))
    return await use(jobPath, base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

function job(events, extra = {}) {
  return { canonicalVersion: '1', providers: [PROVIDER], mappings: [MAPPING], events, ...extra }
}

test('--help prints usage on stdout and exits 0', async () => {
  const { code, stdout, stderr } = await cli(['--help'])

  assert.equal(code, 0)
  assert.equal(stdout.includes('Usage:'), true)
  assert.equal(stdout.includes('--job FILE'), true)
  assert.equal(stdout.includes('Exit codes:'), true)
  assert.equal(stderr, '')
})

test('-h is --help, and -v prints the version', async () => {
  assert.equal((await cli(['-h'])).stdout.includes('Usage:'), true)

  const { code, stdout } = await cli(['-v'])
  assert.equal(code, 0)
  assert.equal(stdout.trim(), '0.1.0')
})

test('the documented version matches the package', async () => {
  const manifest = JSON.parse(await readFile(join(projectDirectory, 'package.json'), 'utf8'))
  const { stdout } = await cli(['--version'])

  assert.equal(stdout.trim(), manifest.version)
})

test('a configuration error leaves stdout empty, because the run never had a subject', async () => {
  for (const args of [[], ['--job'], ['--nope', 'x'], ['--job', 'a.json', '--job', 'b.json'], ['--json']]) {
    const { code, stdout, stderr } = await cli(args)

    assert.equal(code, 2, `${args.join(' ')} must be a configuration error`)
    assert.equal(stdout, '', `${args.join(' ')} must leave stdout empty`)
    assert.equal(stderr.length > 0, true)
  }
})

test('a limit flag is refused above its ceiling and below one', async () => {
  const tooBig = await cli(['--job', 'examples/clean/job.json', '--max-events', '5001'])
  assert.equal(tooBig.code, 2)
  assert.equal(tooBig.stdout, '')
  assert.equal(tooBig.stderr.includes('no greater than 5000'), true)

  const tooSmall = await cli(['--job', 'examples/clean/job.json', '--max-events', '0'])
  assert.equal(tooSmall.code, 2)
  assert.equal(tooSmall.stdout, '')

  const notANumber = await cli(['--job', 'examples/clean/job.json', '--max-events', 'many'])
  assert.equal(notANumber.code, 2)
  assert.equal(notANumber.stdout, '')
})

test('an unreadable input leaves a report on stdout, because the run had a subject', async () => {
  const { code, stdout, stderr } = await cli(['--job', 'examples/no-such-job.json'])
  const report = JSON.parse(stdout)

  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.tool, 'webhook-payload-normalizer')
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.findings[0].ruleId, 'job-unreadable')
  assert.equal(stderr.includes('this is not a pass'), true)
})

test('stdout is the JSON report and nothing else, at every exit code', async () => {
  for (const [args, expected] of [
    [['--job', 'examples/clean/job.json'], 0],
    [['--job', 'examples/broken/job.json'], 1],
    [['--job', 'examples/no-such-job.json'], 2],
  ]) {
    const { code, stdout } = await cli(args)
    const report = JSON.parse(stdout)

    assert.equal(code, expected)
    assert.equal(report.tool, 'webhook-payload-normalizer')
    assert.deepEqual(Object.keys(report), ['schemaVersion', 'tool', 'status', 'summary', 'findings', 'normalization'])
  }
})

test('--json suppresses the human summary and changes nothing on stdout', async () => {
  const plain = await cli(['--job', 'examples/clean/job.json'])
  const quiet = await cli(['--job', 'examples/clean/job.json', '--json'])

  assert.equal(plain.stdout, quiet.stdout)
  assert.equal(quiet.stderr, '')
  assert.equal(plain.stderr.includes('fixture(s) reached a verdict'), true)
})

test('the human summary prints one line per finding, each with its severity', async () => {
  const { stderr } = await cli(['--job', 'examples/broken/job.json'])
  const lines = stderr.trim().split(NEWLINE)

  assert.equal(lines.length, 3 + 5, 'three summary lines and one line per finding')
  assert.equal(lines.filter((line) => line.startsWith('ERROR  ')).length, 4)
  assert.equal(lines.filter((line) => line.startsWith('INFO   ')).length, 1)
})

test('--label decides what job-level findings are called, and never a host path', async () => {
  await withJob(job([]), async (jobPath) => {
    const { stdout } = await cli(['--job', jobPath, '--label', 'jobs/orders.json', '--json'])
    const report = JSON.parse(stdout)

    assert.equal(report.findings[0].location.file, 'jobs/orders.json')
    assert.equal(stdout.includes(jobPath), false)
  })
})

test('--out writes the bundle on a passing run, and writes nothing otherwise', async () => {
  await withJob(job([{ ref: 'one', provider: 'acme', payload: PAYLOAD }]), async (jobPath, base) => {
    const outPath = join(base, 'bundle.json')
    const { code } = await cli(['--job', jobPath, '--out', outPath, '--json'])
    const bundle = JSON.parse(await readFile(outPath, 'utf8'))

    assert.equal(code, 0)
    assert.equal(bundle.canonicalVersion, '1')
    assert.equal(bundle.events[0].canonical.data.orderId, 'O1')
    assert.equal(bundle.events[0].source.version, '2')
  })

  await withJob(job([{ ref: 'one', provider: 'acme', payload: { ...PAYLOAD, data: {} } }]), async (jobPath, base) => {
    const outPath = join(base, 'bundle.json')
    const { code } = await cli(['--job', jobPath, '--out', outPath, '--json'])

    assert.equal(code, 1)
    await assert.rejects(() => stat(outPath), /ENOENT/)
  })
})

test('every limit flag reaches the engine it configures', async () => {
  const busy = {
    canonicalVersion: '1',
    providers: [PROVIDER],
    mappings: [MAPPING, { ...MAPPING, sourceType: 'order_cancelled', canonicalType: 'order.cancelled' }],
    events: [
      { ref: 'one', provider: 'acme', payload: { ...PAYLOAD, extraOne: 1, extraTwo: 2 } },
      { ref: 'two', provider: 'acme', payload: { ...PAYLOAD, id: 'A2', extraOne: 1, extraTwo: 2 } },
    ],
  }

  await withJob(busy, async (jobPath) => {
    const wired = [
      ['--max-events', '1', 'limit-events-exceeded'],
      ['--max-findings', '1', 'limit-findings-exceeded'],
      ['--max-mappings', '1', 'limit-mappings-exceeded'],
      ['--max-payload-depth', '1', 'limit-payload-depth-exceeded'],
      ['--max-steps', '3', 'limit-steps-exceeded'],
      ['--max-unknown-fields', '1', 'limit-unknown-fields-exceeded'],
      ['--max-value-chars', '1', 'limit-value-chars-exceeded'],
    ]

    for (const [flag, value, ruleId] of wired) {
      const { code, stdout } = await cli(['--job', jobPath, flag, value, '--json'])
      const report = JSON.parse(stdout)

      assert.equal(code, 2, `${flag} must change the outcome`)
      assert.equal(report.findings.some((finding) => finding.ruleId === ruleId), true, `${flag} must raise ${ruleId}`)
    }

    const untouched = await cli(['--job', jobPath, '--json'])
    assert.equal(untouched.code, 0, 'and the same job with no flags must pass, or none of the above proves anything')
  })
})

test('--max-payload-bytes reaches the engine too, on a fixture read from a file', async () => {
  const base = await mkdtemp(join(tmpdir(), 'webhook-payload-normalizer-cli-bytes-'))
  try {
    await mkdir(join(base, 'events'))
    await writeFile(join(base, 'events', 'one.json'), JSON.stringify(PAYLOAD))
    const jobPath = join(base, 'job.json')
    await writeFile(jobPath, JSON.stringify(job([{ ref: 'one', provider: 'acme', file: 'one.json' }], { eventsRoot: 'events' })))

    const generous = await cli(['--job', jobPath, '--json'])
    assert.equal(generous.code, 0)

    const { code, stdout } = await cli(['--job', jobPath, '--max-payload-bytes', '10', '--json'])
    assert.equal(code, 2)
    assert.equal(JSON.parse(stdout).findings.some((finding) => finding.ruleId === 'limit-payload-bytes-exceeded'), true)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('the clean example passes and the broken example fails, as the README says', async () => {
  const clean = await cli(['--job', 'examples/clean/job.json', '--json'])
  const broken = await cli(['--job', 'examples/broken/job.json', '--json'])

  assert.equal(clean.code, 0)
  assert.equal(JSON.parse(clean.stdout).status, 'pass')
  assert.equal(JSON.parse(clean.stdout).summary.normalized, 2)
  assert.deepEqual(
    JSON.parse(clean.stdout).normalization.events[0].canonical,
    JSON.parse(clean.stdout).normalization.events[1].canonical,
    'the clean example is the acceptance evidence: two providers, one canonical shape',
  )

  assert.equal(broken.code, 1)
  assert.equal(JSON.parse(broken.stdout).status, 'fail')
  assert.equal(JSON.parse(broken.stdout).summary.errors, 4)
})

test('a default-ignorable payload version is unresolved, not a visible version conflict', async () => {
  const hidden = String.fromCharCode(0x034f)
  await withJob(job([{ ref: 'one', provider: 'acme', version: '2', payload: { ...PAYLOAD, api_version: `2${hidden}` } }]), async (jobPath) => {
    const result = await cli(['--job', jobPath, '--json'])
    const report = JSON.parse(result.stdout)
    assert.equal(result.code, 2)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.normalized, 0)
    assert.equal(report.findings.some((finding) => finding.ruleId === 'event-version-unresolved'), true)
    assert.equal(report.findings.some((finding) => finding.ruleId === 'event-version-conflict'), false)
    assert.equal(result.stdout.includes(hidden), false)
  })
})

test('default-ignorable mapped string data is replaced and reported', async () => {
  for (const [raw, rendered] of [
    [`O${String.fromCharCode(0x034f)}1`, 'O 1'],
    [`\u2764${String.fromCharCode(0xfe0f)}`, '\u2764 '],
  ]) {
    await withJob(job([{ ref: 'one', provider: 'acme', payload: { ...PAYLOAD, data: { order_id: raw } } }]), async (jobPath) => {
      const result = await cli(['--job', jobPath, '--json'])
      const report = JSON.parse(result.stdout)
      assert.equal(result.code, 0)
      assert.equal(report.status, 'pass')
      assert.equal(report.normalization.events[0].canonical.data.orderId, rendered)
      assert.equal(report.findings.some((finding) => finding.ruleId === 'text-sanitised'), true)
      assert.equal(result.stdout.includes(raw), false)
    })
  }
})

test('a 32-character declared version remains legal and 33 characters are refused', async () => {
  for (const [length, expectedCode] of [[32, 0], [33, 2]]) {
    const version = 'v'.repeat(length)
    await withJob(job([{ ref: 'one', provider: 'acme', version, payload: { ...PAYLOAD, api_version: version } }], {
      mappings: [{ ...MAPPING, version }],
    }), async (jobPath) => {
      const result = await cli(['--job', jobPath, '--json'])
      const report = JSON.parse(result.stdout)
      assert.equal(result.code, expectedCode)
      assert.equal(report.status, length === 32 ? 'pass' : 'incomplete')
      assert.equal(report.findings.some((finding) => finding.ruleId === 'job-invalid'), length === 33)
    })
  }
})
