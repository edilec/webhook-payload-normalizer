import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDirectory = dirname(fileURLToPath(import.meta.url))

test('the test suite contains no socket bind or connect calls', async () => {
  for (const name of await readdir(testDirectory)) {
    if (!name.endsWith('.test.mjs') || name === 'offline-test-policy.test.mjs') continue
    const source = await readFile(join(testDirectory, name), 'utf8')
    assert.equal(/\bcreateServer\s*\(|\.listen\s*\(|\.connect\s*\(/.test(source), false, `${name} contains a socket call`)
  }
})
