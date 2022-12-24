#!/usr/bin/env node

import process from 'node:process'

import { HARD_LIMITS, exitCodeFor, formatReport, normalizeJobFile, serializeReport } from '../src/index.mjs'

const VERSION = '0.2.0'

const HELP = `webhook-payload-normalizer

Map versioned provider event fixtures into one canonical event shape, and
report every payload that would not map.

A mapping is selected by an exact (provider, version, source event) match.
There is no nearest-version fallback, no numeric version comparison and no
"latest": a payload whose version has no mapping is refused, because applying
the v2 rules to a v3 payload is how wrong data enters a system.

Every canonical event carries the provider, the provider's own version string
and the provider's own event id, so provenance survives normalization. A field
no mapping claims is handled by a declared policy -- preserved under
"extensions", reported, or refused -- and never dropped in silence.

Nothing is read but the job and its fixtures. No socket is opened.

Usage:
  webhook-payload-normalizer --job FILE [--json] [--label NAME] [--out FILE] [limits]

Options:
  --job FILE                 Normalization job to run (JSON, max 1 MiB) (required)
  --out FILE                 Write the normalized bundle here, inside the job
                             file's own directory. Written only when the run
                             passes. The destination is refused, as a
                             configuration error, when it is a symbolic link
                             (resolving the link is the dangerous act, so it is
                             refused on sight), when it resolves outside that
                             directory through a symlinked parent or a ".."
                             segment, or when it is one of this run's inputs,
                             compared by device and inode so that a hard link
                             to an input is still that input
  --label NAME               Value recorded as location.file for job-level
                             findings (defaults to the --job value as written)
  --json                     Suppress the human summary on stderr
  --max-events N             Maximum fixtures examined (default 500)
  --max-findings N           Maximum findings in the report (default 500)
  --max-mappings N           Maximum mappings a job may declare (default 200)
  --max-payload-bytes N      Maximum bytes per fixture file (default 65536)
  --max-payload-depth N      Maximum nesting depth per payload (default 16)
  --max-steps N              Work budget for the run (default 200000)
  --max-unknown-fields N     Maximum unclaimed fields per payload (default 128)
  --max-value-chars N        Maximum characters in one mapped value (default 512)
  -h, --help                 Show this help
  -v, --version              Show the version

Every option that carries a value may be given only once: a repeated flag is a
configuration error, not a silent last-wins. An unknown option is refused, so a
one-character typo cannot quietly turn a real failure into a green run.

Fixtures are read, never written. There is no auto-fix. A refused --out is a
configuration error: exit 2, empty stdout, nothing written.

Output:
  stdout  the JSON report only, so it can be piped straight into a parser
  stderr  the human summary and diagnostics

Exit codes:
  0  every fixture reached a verdict and the policy was satisfied
  1  the run completed and the policy failed (a refused payload, an unknown
     version, a broken equivalence claim)
  2  invalid usage or configuration (stdout is empty), or evidence that could
     not be obtained (an "incomplete" report on stdout, never a "pass")
`

const LIMIT_FLAGS = new Map([
  ['--max-events', 'maxEvents'],
  ['--max-findings', 'maxFindings'],
  ['--max-mappings', 'maxMappings'],
  ['--max-payload-bytes', 'maxPayloadBytes'],
  ['--max-payload-depth', 'maxPayloadDepth'],
  ['--max-steps', 'maxSteps'],
  ['--max-unknown-fields', 'maxUnknownFields'],
  ['--max-value-chars', 'maxValueChars'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  if (argv.includes('-v') || argv.includes('--version')) return { version: true }

  const options = { job: null, label: null, out: null, json: false, limits: {} }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--job a --job b` normalizes a job nobody named and `--max-events 5
   * --max-events 1` enforces a limit nobody asked for. That is the same defect
   * as an ignored typo, which this tool already refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') options.json = true
    else if (argument === '--job') {
      once('--job')
      options.job = takeValue('--job')
    } else if (argument === '--out') {
      once('--out')
      options.out = takeValue('--out')
    } else if (argument === '--label') {
      once('--label')
      options.label = takeValue('--label')
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const name = LIMIT_FLAGS.get(argument)
      const raw = takeValue(argument)
      if (!/^[0-9]+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      if (Number(raw) > HARD_LIMITS[name]) throw new Error(`${argument} must be no greater than ${HARD_LIMITS[name]}`)
      options.limits[name] = Number(raw)
    } else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.job === null) throw new Error('--job is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    // Configuration never had a subject, so stdout stays empty.
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  let report
  try {
    report = await normalizeJobFile(options.job, {
      ...(options.label === null ? {} : { label: options.label }),
      ...(options.out === null ? {} : { outPath: options.out }),
      limits: options.limits,
    })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  process.stdout.write(`${serializeReport(report)}\n`)
  if (!options.json) process.stderr.write(formatReport(report))

  if (report.status === 'incomplete') {
    const { checked, events, skipped } = report.summary
    process.stderr.write(
      `incomplete: ${checked} of ${events} declared fixture(s) reached a verdict and ${skipped} were not examined. ` +
      `The findings say what was not established; this is not a pass.\n`,
    )
  }
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
