# webhook-payload-normalizer

Map versioned provider webhook fixtures into one canonical event shape — and refuse the ones that
would have to be guessed at.

Two providers spell the same business event differently. One calls it `order_created` with
`total_cents` under `data`; the other calls it `order.created` with `amount_minor` under `order`.
This tool maps both onto one canonical body, keeps each provider's own id and version alongside it,
and says explicitly what it did with every field no mapping claimed.

The rule it is built around is the one it *does not* have: **there is no fallback**. A payload
whose version has no mapping is refused. Not mapped with the nearest known version's rules, not
compared numerically, not handled by "latest". Applying the v2 rules to a v3 payload is how wrong
data enters a system, and a tool that guesses once will guess again.

- **Repository:** [edilec/webhook-payload-normalizer](https://github.com/edilec/webhook-payload-normalizer)
- **Area:** API & Integration
- **License:** MIT
- No dependencies, no network, Node 22+.

## Install

```sh
npm install webhook-payload-normalizer
```

## Use

```sh
webhook-payload-normalizer --job examples/clean/job.json
```

The JSON report goes to stdout and nothing else goes there, so it pipes straight into a parser. The
human summary and diagnostics go to stderr — a non-empty stderr is normal.

```sh
webhook-payload-normalizer --job job.json --json > report.json
webhook-payload-normalizer --job job.json --out bundle.json
```

`--out` writes the normalized events as a bundle, and only when the run passes. The destination is
checked before anything is opened, and a destination that would write somewhere else is refused as
a configuration error — exit `2`, empty stdout, nothing written. It is refused when it is a
symbolic link (`realpath` would *resolve* the link, and resolving is the dangerous act, so `lstat`
refuses it on sight), when it resolves outside the job file's own directory (the parent is resolved,
because a lexical prefix check passes for a symlinked parent), and when it is one of the run's own
inputs (compared by device and inode, because a hard link has no target and a path comparison would
happily overwrite it).

`--help` lists every option. Exit codes: `0` passed, `1` completed and failed, `2` invalid
configuration (stdout empty) or evidence that could not be obtained (an `incomplete` report).

Version 0.2.0 keeps the report envelope at `schemaVersion: "1"` but gives its
`normalization` object (and the optional standalone bundle) `schemaVersion: "2"`.
In v2, `providers` and `mappings` contain `/providers/N` and
`/mappings/N` source pointers in job declaration order, rather than raw provider
names and composite mapping keys. Consumers of the old catalog values should
follow those pointers into the original job. Exact matching still uses the raw
declarations internally. Normalized `events` are unchanged: their selected
provider/version/type/id provenance, canonical data, and preserved extensions
are intentional output and may contain payload data. Do not treat the bundle
as a general-purpose redacted export.

### As a library

```js
import { normalizeJob, normalizeJobFile } from 'webhook-payload-normalizer'

const report = await normalizeJobFile('job.json')
const [acme, beta] = report.normalization.events

// The internal shape both providers agreed on:
acme.canonical           // { version, type, data }
// Where each of them came from:
acme.source              // { provider, version, type, id }
```

## What a job looks like

```json
{
  "canonicalVersion": "1",
  "unknownFields": "preserve",
  "eventsRoot": "events",
  "providers": [
    { "name": "acme", "versionAt": "/api_version", "typeAt": "/event" },
    { "name": "beta", "versionAt": "/meta/schema", "typeAt": "/type" }
  ],
  "mappings": [
    {
      "provider": "acme",
      "version": "2",
      "sourceType": "order_created",
      "canonicalType": "order.created",
      "sourceId": "/id",
      "fields": [
        { "from": "/data/total_cents", "to": "amountMinor", "as": "integer" },
        { "from": "/data/currency", "to": "currency", "as": "string", "transform": "uppercase" },
        { "from": "/data/state", "to": "status", "as": "string", "values": { "PAID": "paid" } }
      ]
    }
  ],
  "events": [
    { "ref": "acme-order", "provider": "acme", "file": "acme-order-created.json" }
  ],
  "equivalence": [
    { "id": "order-created", "refs": ["acme-order", "beta-order"] }
  ]
}
```

`examples/clean/` is a complete runnable version of this with two providers and an equivalence
claim the tool checks for itself; it exits 0. `examples/broken/` collects the refusals — an unknown
provider version, a missing required field, an unclaimed field under a `reject` policy, and an
equivalence claim that does not hold; it exits 1.

The full schema, the rule catalog and the limits are in
[`docs/normalization-rules.md`](./docs/normalization-rules.md).

## What it guarantees

- **A mapping is never guessed.** Selection is an exact `(provider, version, sourceType)` match.
  An unknown version, an unknown source event name, or a declared version that disagrees with the
  payload is a refusal that fails the run. If a payload version or source event name changes when
  rendered safely (for example, an invisible mark or folded whitespace), the comparison is
  incomplete instead: it cannot truthfully claim that a visibly identical mapping is absent.
  A declared mapping source event name with the same ambiguity is an invalid job, reported
  before comparing any payloads. When two long event names share a truncated excerpt,
  the refusal identifies their first differing raw UTF-16 unit.
- **Nothing is converted.** `as` is a type check. A `"4250"` declared `integer` is a mismatch, not
  a number. A value outside a field's declared `values` map is refused, not carried across.
- **Provenance survives.** Every canonical event keeps the provider, the provider's own version
  string and the provider's own event id. A payload whose id cannot be read is refused rather than
  normalized anonymously.
- **Invisible payload characters are explicit.** Default-ignorable characters in version or event
  names make selection incomplete; in mapped string data they become spaces with a `text-sanitised`
  finding. This can change emoji presentation, so the altered value is never passed off as exact.
- **A field nobody mapped is handled by declared policy** — `preserve`, `report` or `reject` — with
  one finding per field. Silence is not one of the policies.
- **Unknown is never a pass.** An unreadable input, a bound that was hit, an equivalence group the
  run did not finish comparing -- a member that never normalized, or a step budget that ran out
  part-way through the group -- and a run that reached a verdict on nothing each make the report
  `incomplete` and exit 2. A `pass` with `checked: 0` is not reachable, and a group compared in
  part reads as `null`, never as one that holds.
- **Two runs over the same bytes produce byte-identical stdout.** No wall clock, no locale, no
  random source, no directory listing, and no filesystem or JSON key order reaches the output.
- **No socket is opened.** The package imports no networking primitive; a test runs the real CLI
  with socket operations disabled before it loads, passing inert URL data through the job and payload.

## Limits and non-goals

What this tool **cannot** conclude:

- **That a mapping is correct.** It checks that a mapping applies cleanly and that two providers
  agree. Whether `amountMinor` should have come from `total_cents` is a question about your
  business, and nothing here can answer it.
- **That a canonical schema is right.** There is no schema registry and no validation of the
  canonical body against one. `canonicalVersion` is a string this tool stamps, not a contract it
  checks. There is no JSON Schema or OpenAPI support: this tool implements its own small, declared
  mapping language rather than half of a validator it would then have to disclaim.
- **That a provider's version scheme means anything.** Versions are opaque strings compared
  literally. `"3"` is not later than `"2"` here, and `"2.0"` is not `"2"`.
- **That the fixtures resemble live traffic.** A fixture set is what somebody captured. Whether it
  covers a provider's real event space is not visible from here.
- **That an unclaimed field is unimportant.** Every one of them is reported under the policy you
  chose. Which of them your system needed is your call.
- **That a payload is safe.** Strings that reach output are sanitised so a report cannot be forged
  through them. Nothing is validated, escaped or authenticated for a downstream consumer.
- **Anything about delivery.** Signatures, retries, ordering and delivery semantics are other
  tools' subjects. Nothing here opens a connection.

Bounded by design: the supported pointer subset is RFC 6901 without wildcards, JSONPath, relative
pointers or the `-` token, and anything outside it is reported as unsupported and makes the run
incomplete — never treated as a field that happened to be absent.

## Development

```sh
npm run check      # lint, test, run the example, and check the package contents
npm test
npm run test:coverage
```

No dependencies, and none are wanted.

## License

MIT. See [LICENSE](./LICENSE).
