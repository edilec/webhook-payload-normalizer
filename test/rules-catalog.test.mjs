import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { RULE_SEVERITY, SEVERITY_DECIDES, SEVERITY_VALUES, createFinding } from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * A secondary guard, and only that.
 *
 * What actually pins severity is `test/severity-decides.test.mjs` and
 * `test/severity-incomplete.test.mjs`: they import nothing from here, hold no
 * table, and state every exit code and count as a literal. A table, a document
 * and a map of expected values can be edited together; an exit code cannot.
 *
 * This file catches a different and much duller failure -- the catalog quietly
 * going out of date -- so that a reader of the documentation is told the truth
 * about what a rule will do to their build.
 */

test('the documented catalog and the table agree, in both directions', async () => {
  const catalog = await readFile(join(projectDirectory, 'docs/normalization-rules.md'), 'utf8')
  const documented = new Map()

  for (const row of catalog.matchAll(/^\| `([a-z0-9-]+)` \| `(error|warning|info)` \|/gm)) {
    assert.equal(documented.has(row[1]), false, `${row[1]} is documented twice`)
    documented.set(row[1], row[2])
  }

  assert.deepEqual([...documented.keys()].sort(), Object.keys(RULE_SEVERITY).sort())
  for (const [ruleId, severity] of documented) {
    assert.equal(RULE_SEVERITY[ruleId], severity, `docs/normalization-rules.md says ${ruleId} is ${severity}`)
  }
})

test('every rule id is a stable kebab identifier and every severity is one of three', () => {
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.match(ruleId, /^[a-z0-9]+(-[a-z0-9]+)*$/)
    assert.equal(SEVERITY_VALUES.includes(severity), true)
  }
  assert.equal(Object.isFrozen(RULE_SEVERITY), true)
})

test('a finding for a rule nobody added to the table throws rather than defaulting', () => {
  assert.throws(
    () => createFinding({ file: 'job.json', pointer: '/', ruleId: 'invented-rule', message: 'x' }),
    /is not in RULE_SEVERITY/,
  )
})

test('SEVERITY_DECIDES names error rules, and only ones the incomplete flag does not backstop', () => {
  for (const ruleId of SEVERITY_DECIDES) {
    assert.equal(RULE_SEVERITY[ruleId], 'error', `${ruleId} must be an error rule`)
  }
  assert.equal(new Set(SEVERITY_DECIDES).size, SEVERITY_DECIDES.length)
  assert.equal(Object.isFrozen(SEVERITY_DECIDES), true)
})

test('every rule in the table is reachable from a test that runs the real binary', async () => {
  const decides = await readFile(join(projectDirectory, 'test/severity-decides.test.mjs'), 'utf8')
  const incomplete = await readFile(join(projectDirectory, 'test/severity-incomplete.test.mjs'), 'utf8')

  for (const ruleId of Object.keys(RULE_SEVERITY)) {
    const covered = decides.includes(`printed(stderr, '${ruleId}')`) || incomplete.includes(`printed(stderr, '${ruleId}')`)
    assert.equal(covered, true, `${ruleId} has no behavioural severity test`)
  }
})
