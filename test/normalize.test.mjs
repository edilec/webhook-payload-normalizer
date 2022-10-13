import assert from 'node:assert/strict'
import test from 'node:test'

import { compareCanonical, normalizeJob } from '../src/index.mjs'

/**
 * The public API, and the two claims this tool exists to make good on:
 *
 * 1. Two providers spelling one event differently normalize to the *same*
 *    canonical body, asserted by deep equality, while each keeps its own id and
 *    its own version so provenance survives.
 * 2. A version nobody wrote a mapping for is refused. Not coerced, not rounded
 *    to the nearest known version, not quietly handled by "latest".
 */

const ACME = { name: 'acme', versionAt: '/api_version', typeAt: '/event' }
const BETA = { name: 'beta', versionAt: '/meta/schema', typeAt: '/type' }

function acmeMapping(version) {
  return {
    provider: 'acme',
    version,
    sourceType: 'order_created',
    canonicalType: 'order.created',
    sourceId: '/id',
    fields: [
      { from: '/created_at', to: 'occurredAt', as: 'string' },
      { from: '/data/order_id', to: 'orderId', as: 'string' },
      { from: '/data/total_cents', to: 'amountMinor', as: 'integer' },
      { from: '/data/currency', to: 'currency', as: 'string', transform: 'uppercase' },
      { from: '/data/state', to: 'status', as: 'string', values: { PAID: 'paid', PENDING: 'pending' } },
    ],
  }
}

const BETA_MAPPING = {
  provider: 'beta',
  version: '2024-05-01',
  sourceType: 'order.created',
  canonicalType: 'order.created',
  sourceId: '/event_id',
  fields: [
    { from: '/occurred_at', to: 'occurredAt', as: 'string' },
    { from: '/order/reference', to: 'orderId', as: 'string' },
    { from: '/order/amount_minor', to: 'amountMinor', as: 'integer' },
    { from: '/order/currency', to: 'currency', as: 'string', transform: 'uppercase' },
    { from: '/order/payment_status', to: 'status', as: 'string', values: { paid: 'paid', unpaid: 'pending' } },
  ],
}

const ACME_PAYLOAD = {
  id: 'evt_ACME_1001',
  api_version: '2',
  event: 'order_created',
  created_at: '2026-01-02T03:04:05Z',
  data: { order_id: 'ORD-5521', total_cents: 4250, currency: 'usd', state: 'PAID' },
}

const BETA_PAYLOAD = {
  event_id: '01HQBETA88',
  meta: { schema: '2024-05-01' },
  type: 'order.created',
  occurred_at: '2026-01-02T03:04:05Z',
  order: { reference: 'ORD-5521', amount_minor: 4250, currency: 'USD', payment_status: 'paid' },
}

function twoProviderJob(extra = {}) {
  return {
    canonicalVersion: '1',
    providers: [ACME, BETA],
    mappings: [acmeMapping('2'), BETA_MAPPING],
    events: [
      { ref: 'acme-order', provider: 'acme', payload: ACME_PAYLOAD },
      { ref: 'beta-order', provider: 'beta', payload: BETA_PAYLOAD },
    ],
    ...extra,
  }
}

test('two provider variants of one event produce the same canonical body', async () => {
  const report = await normalizeJob(twoProviderJob())
  const [acme, beta] = report.normalization.events

  assert.equal(report.status, 'pass')
  assert.equal(report.summary.normalized, 2)
  assert.deepEqual(acme.canonical, beta.canonical)
  assert.deepEqual(acme.canonical, {
    version: '1',
    type: 'order.created',
    data: {
      amountMinor: 4250,
      currency: 'USD',
      occurredAt: '2026-01-02T03:04:05Z',
      orderId: 'ORD-5521',
      status: 'paid',
    },
  })
})

test('each normalized event keeps its own source id and source version', async () => {
  const report = await normalizeJob(twoProviderJob())
  const [acme, beta] = report.normalization.events

  assert.deepEqual(acme.source, { provider: 'acme', version: '2', type: 'order_created', id: 'evt_ACME_1001' })
  assert.deepEqual(beta.source, { provider: 'beta', version: '2024-05-01', type: 'order.created', id: '01HQBETA88' })
  assert.notDeepEqual(acme.source, beta.source, 'provenance is what is allowed to differ')
})

test('the tool confirms the equivalence itself, and says so', async () => {
  const report = await normalizeJob(twoProviderJob({ equivalence: [{ id: 'order-created', refs: ['acme-order', 'beta-order'] }] }))

  assert.equal(report.status, 'pass')
  assert.deepEqual(report.normalization.equivalence, [{ id: 'order-created', refs: ['acme-order', 'beta-order'], match: true }])
  assert.equal(report.findings.filter((finding) => finding.ruleId === 'equivalence-confirmed').length, 1)
})

/**
 * The critical rule, from four directions. Each of these would be a silent
 * mis-map in a tool that reached for the nearest mapping it had.
 */

test('an unknown version is refused, not mapped with the rules of a known one', async () => {
  const report = await normalizeJob({
    canonicalVersion: '1',
    providers: [ACME],
    mappings: [acmeMapping('1'), acmeMapping('2')],
    events: [{ ref: 'future', provider: 'acme', payload: { ...ACME_PAYLOAD, api_version: '3' } }],
  })

  assert.equal(report.status, 'fail')
  assert.equal(report.summary.normalized, 0)
  assert.deepEqual(report.normalization.events, [], 'nothing may be emitted for a version nobody mapped')
  assert.deepEqual(report.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.ruleId), ['mapping-version-unknown'])
})

test('a version is compared literally: "2.0" is not "2"', async () => {
  const report = await normalizeJob({
    canonicalVersion: '1',
    providers: [ACME],
    mappings: [acmeMapping('2')],
    events: [{ ref: 'dotted', provider: 'acme', payload: { ...ACME_PAYLOAD, api_version: '2.0' } }],
  })

  assert.equal(report.summary.normalized, 0)
  assert.deepEqual(report.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.ruleId), ['mapping-version-unknown'])
})

test('a version that arrives as a number is unresolved, not read as its digits', async () => {
  const report = await normalizeJob({
    canonicalVersion: '1',
    providers: [ACME],
    mappings: [acmeMapping('2')],
    events: [{ ref: 'numeric', provider: 'acme', payload: { ...ACME_PAYLOAD, api_version: 2 } }],
  })

  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.normalized, 0)
  assert.equal(report.findings.some((finding) => finding.ruleId === 'event-version-unresolved'), true)
})

test('a source event name is matched exactly: order.created is not order_created', async () => {
  const report = await normalizeJob({
    canonicalVersion: '1',
    providers: [ACME],
    mappings: [acmeMapping('2')],
    events: [{ ref: 'dotted', provider: 'acme', payload: { ...ACME_PAYLOAD, event: 'order.created' } }],
  })

  assert.equal(report.summary.normalized, 0)
  assert.deepEqual(report.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.ruleId), ['mapping-event-unknown'])
})

test('the declared version and the payload version must agree, and neither wins', async () => {
  const report = await normalizeJob({
    canonicalVersion: '1',
    providers: [ACME],
    mappings: [acmeMapping('1'), acmeMapping('2')],
    events: [{ ref: 'claimed', provider: 'acme', version: '1', payload: ACME_PAYLOAD }],
  })

  assert.equal(report.summary.normalized, 0)
  assert.deepEqual(report.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.ruleId), ['event-version-conflict'])
})

/** No conversion, anywhere. */

test('a declared integer that arrives as a string is a mismatch, never a conversion', async () => {
  const report = await normalizeJob({
    canonicalVersion: '1',
    providers: [ACME],
    mappings: [acmeMapping('2')],
    events: [{ ref: 'stringy', provider: 'acme', payload: { ...ACME_PAYLOAD, data: { ...ACME_PAYLOAD.data, total_cents: '4250' } } }],
  })

  assert.equal(report.summary.normalized, 0)
  assert.deepEqual(report.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.ruleId), ['field-type-mismatch'])
})

test('a declared integer that arrives as a fractional number is a mismatch', async () => {
  const report = await normalizeJob({
    canonicalVersion: '1',
    providers: [ACME],
    mappings: [acmeMapping('2')],
    events: [{ ref: 'fraction', provider: 'acme', payload: { ...ACME_PAYLOAD, data: { ...ACME_PAYLOAD.data, total_cents: 42.5 } } }],
  })

  assert.equal(report.summary.normalized, 0)
  assert.deepEqual(report.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.ruleId), ['field-type-mismatch'])
})

test('an enumerated value the mapping does not list is refused, not carried across', async () => {
  const report = await normalizeJob({
    canonicalVersion: '1',
    providers: [ACME],
    mappings: [acmeMapping('2')],
    events: [{ ref: 'odd', provider: 'acme', payload: { ...ACME_PAYLOAD, data: { ...ACME_PAYLOAD.data, state: 'REFUNDED' } } }],
  })

  assert.equal(report.summary.normalized, 0)
  assert.deepEqual(report.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.ruleId), ['field-value-unmapped'])
})

test('a payload with no readable source id is refused rather than normalized anonymously', async () => {
  const { id, ...withoutId } = ACME_PAYLOAD
  const report = await normalizeJob({
    canonicalVersion: '1',
    providers: [ACME],
    mappings: [acmeMapping('2')],
    events: [{ ref: 'anonymous', provider: 'acme', payload: withoutId }],
  })

  assert.equal(id, 'evt_ACME_1001')
  assert.equal(report.summary.normalized, 0)
  assert.equal(report.findings.some((finding) => finding.ruleId === 'source-id-missing'), true)
})

test('an integer source id is kept as the integer it is', async () => {
  const report = await normalizeJob({
    canonicalVersion: '1',
    providers: [ACME],
    mappings: [acmeMapping('2')],
    events: [{ ref: 'numeric-id', provider: 'acme', payload: { ...ACME_PAYLOAD, id: 40155 } }],
  })

  assert.equal(report.summary.normalized, 1)
  assert.equal(report.normalization.events[0].source.id, 40155)
})

/** Unclaimed fields, by declared policy. */

test('preserve carries an unclaimed field across under extensions', async () => {
  const report = await normalizeJob({
    canonicalVersion: '1',
    unknownFields: 'preserve',
    providers: [ACME],
    mappings: [acmeMapping('2')],
    events: [{ ref: 'extra', provider: 'acme', payload: { ...ACME_PAYLOAD, data: { ...ACME_PAYLOAD.data, hint: 'warehouse-3' } } }],
  })

  assert.equal(report.status, 'pass')
  assert.deepEqual(report.normalization.events[0].extensions, [{ pointer: '/data/hint', value: 'warehouse-3' }])
  assert.equal(report.findings.filter((finding) => finding.ruleId === 'unknown-fields-preserved').length, 1)
})

test('report names an unclaimed field and leaves it out of the canonical event', async () => {
  const report = await normalizeJob({
    canonicalVersion: '1',
    unknownFields: 'report',
    providers: [ACME],
    mappings: [acmeMapping('2')],
    events: [{ ref: 'extra', provider: 'acme', payload: { ...ACME_PAYLOAD, data: { ...ACME_PAYLOAD.data, hint: 'warehouse-3' } } }],
  })

  assert.equal(report.status, 'pass')
  assert.equal(report.normalization.events[0].extensions, undefined)
  assert.equal(report.findings.filter((finding) => finding.ruleId === 'unknown-fields-reported').length, 1)
  assert.equal(report.findings[0].evidence, '/data/hint')
})

test('reject refuses the payload outright', async () => {
  const report = await normalizeJob({
    canonicalVersion: '1',
    unknownFields: 'reject',
    providers: [ACME],
    mappings: [acmeMapping('2')],
    events: [{ ref: 'extra', provider: 'acme', payload: { ...ACME_PAYLOAD, data: { ...ACME_PAYLOAD.data, hint: 'warehouse-3' } } }],
  })

  assert.equal(report.status, 'fail')
  assert.equal(report.summary.normalized, 0)
  assert.equal(report.findings.filter((finding) => finding.ruleId === 'unknown-fields-rejected').length, 1)
})

test('a per-mapping policy overrides the job default', async () => {
  const report = await normalizeJob({
    canonicalVersion: '1',
    unknownFields: 'reject',
    providers: [ACME],
    mappings: [{ ...acmeMapping('2'), unknownFields: 'preserve' }],
    events: [{ ref: 'extra', provider: 'acme', payload: { ...ACME_PAYLOAD, data: { ...ACME_PAYLOAD.data, hint: 'warehouse-3' } } }],
  })

  assert.equal(report.status, 'pass')
  assert.deepEqual(report.normalization.events[0].extensions, [{ pointer: '/data/hint', value: 'warehouse-3' }])
})

test('a mapping that claims a whole sub-object claims everything under it', async () => {
  const report = await normalizeJob({
    canonicalVersion: '1',
    unknownFields: 'reject',
    providers: [ACME],
    mappings: [{
      provider: 'acme',
      version: '2',
      sourceType: 'order_created',
      canonicalType: 'order.created',
      sourceId: '/id',
      fields: [{ from: '/created_at', to: 'occurredAt', as: 'string' }, { from: '/data/order_id', to: 'orderId', as: 'string' }],
    }],
    events: [{
      ref: 'nested',
      provider: 'acme',
      payload: { id: 'A1', api_version: '2', event: 'order_created', created_at: 'T', data: { order_id: 'O1' } },
    }],
  })

  assert.equal(report.status, 'pass')
  assert.equal(report.summary.normalized, 1)
})

test('an empty object and an empty array are preserved as the leaves they are', async () => {
  const report = await normalizeJob({
    canonicalVersion: '1',
    providers: [ACME],
    mappings: [acmeMapping('2')],
    events: [{ ref: 'empties', provider: 'acme', payload: { ...ACME_PAYLOAD, tags: [], meta: {} } }],
  })

  assert.deepEqual(report.normalization.events[0].extensions, [
    { pointer: '/meta', value: '{}' },
    { pointer: '/tags', value: '[]' },
  ])
})

/** Pointers: the supported subset, exercised. */

test('array indices and escaped tokens resolve, and an unsupported pointer is declared', async () => {
  const report = await normalizeJob({
    canonicalVersion: '1',
    providers: [ACME],
    mappings: [{
      provider: 'acme',
      version: '2',
      sourceType: 'order_created',
      canonicalType: 'order.created',
      sourceId: '/id',
      fields: [
        { from: '/lines/0/sku', to: 'sku', as: 'string' },
        { from: '/odd~1key', to: 'odd', as: 'string' },
      ],
    }],
    events: [{
      ref: 'pointers',
      provider: 'acme',
      payload: { id: 'A1', api_version: '2', event: 'order_created', lines: [{ sku: 'SKU-1' }], 'odd/key': 'value' },
    }],
  })

  assert.equal(report.status, 'pass')
  assert.deepEqual(report.normalization.events[0].canonical.data, { odd: 'value', sku: 'SKU-1' })
})

test('a JSONPath expression is reported as unsupported, never as an absent field', async () => {
  const report = await normalizeJob({
    canonicalVersion: '1',
    providers: [ACME],
    mappings: [{
      provider: 'acme',
      version: '2',
      sourceType: 'order_created',
      canonicalType: 'order.created',
      sourceId: '/id',
      fields: [{ from: '$.data.order_id', to: 'orderId', as: 'string' }],
    }],
    events: [{ ref: 'jsonpath', provider: 'acme', payload: ACME_PAYLOAD }],
  })

  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings.some((finding) => finding.ruleId === 'mapping-unsupported-construct'), true)
  assert.equal(report.findings.some((finding) => finding.ruleId === 'field-required-missing'), false)
})

/** The comparison the equivalence rule is built on. */

test('compareCanonical looks at version, type and data, and names the first difference', () => {
  const left = { version: '1', type: 'order.created', data: { amountMinor: 4250, currency: 'USD' } }

  assert.deepEqual(compareCanonical(left, { ...left }), { equal: true })
  assert.deepEqual(compareCanonical(left, { ...left, version: '2' }), { equal: false, difference: 'version' })
  assert.deepEqual(compareCanonical(left, { ...left, type: 'order.placed' }), { equal: false, difference: 'type' })
  assert.deepEqual(
    compareCanonical(left, { ...left, data: { amountMinor: 9900, currency: 'USD' } }),
    { equal: false, difference: 'data/amountMinor' },
  )
  assert.deepEqual(
    compareCanonical(left, { ...left, data: { amountMinor: 4250 } }),
    { equal: false, difference: 'data/currency' },
    'a field present on one side and absent on the other is a difference',
  )
})

test('the public API refuses an option it does not define', async () => {
  await assert.rejects(() => normalizeJob(twoProviderJob(), { basedir: '/tmp' }), /Unknown option "basedir"/)
  await assert.rejects(() => normalizeJob(twoProviderJob(), { limits: { maxEvent: 1 } }), /Unknown limit "maxEvent"/)
  await assert.rejects(() => normalizeJob(twoProviderJob(), { limits: { maxEvents: 0 } }), /must be an integer between 1 and 5000/)
})
