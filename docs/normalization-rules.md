# Normalization rules, job schema and limits

Reference for `webhook-payload-normalizer`. The authoritative severity table lives in
`src/rules.mjs`; this document records the same catalog for a reader, and the behaviour of every
rule in it is pinned by tests that run the real binary.

## The rule catalog

Severity decides the verdict: any `error` fails the run, a `warning` or `info` does not. Rules that
also mark the run `incomplete` exit 2 whatever their severity says.

### Selection — a payload that was refused

These are verdicts this tool reached. The run completed; the fixture set failed.

| Rule | Severity | Raised when |
| --- | --- | --- |
| `provider-unknown` | `error` | A fixture names a provider the job does not declare. It is refused rather than mapped with somebody else's rules. |
| `mapping-version-unknown` | `error` | No mapping declares that provider at that version. **There is no fallback**: the nearest known version is not used, versions are never compared numerically, and there is no "latest". |
| `mapping-event-unknown` | `error` | The provider and version have mappings, but none claims that source event name. Matching is exact and case-sensitive. If a declared event name has the same bounded excerpt, the message also identifies the first differing raw UTF-16 unit. |
| `event-version-conflict` | `error` | The job declares a version for the fixture and the payload says another. Two answers is not one answer. |

### Mapping — a payload that could not be mapped

| Rule | Severity | Raised when |
| --- | --- | --- |
| `source-id-missing` | `error` | The `sourceId` pointer resolves to nothing, or to something that is not an identifier. Provenance would not survive, so the payload is not normalized. |
| `field-required-missing` | `error` | A required field's `from` pointer resolves to nothing. |
| `field-type-mismatch` | `error` | The value at `from` is not of the declared type. **Nothing is converted anywhere in this tool**, so a `"4250"` declared `integer` is a mismatch and not a number. |
| `field-value-unmapped` | `error` | The field enumerates the source values it accepts under `values`, and the payload carries one that is not among them. |
| `field-optional-missing` | `info` | An optional field's `from` pointer resolves to nothing, so the canonical event omits it. |

### Unclaimed fields — handled by declared policy, never in silence

One finding per unclaimed field. The field's pointer is the finding's `evidence`.

| Rule | Severity | Raised when |
| --- | --- | --- |
| `unknown-fields-rejected` | `error` | The mapping's policy is `reject`, so the payload is refused. |
| `unknown-fields-reported` | `warning` | The mapping's policy is `report`: the field is named here and is not in the canonical event. |
| `unknown-fields-preserved` | `info` | The mapping's policy is `preserve`: the field is carried across under `extensions`. |

### Equivalence

| Rule | Severity | Raised when |
| --- | --- | --- |
| `equivalence-mismatch` | `error` | Two fixtures a group claims are equivalent produced different canonical bodies. The `evidence` names the first field that differs. |
| `equivalence-unresolved` | `error` | Whether the group holds was not established: it names a fixture that produced no canonical event, or the `maxSteps` budget ran out before the group's comparisons were finished. A group compared only in part is reported here, never as `equivalence-confirmed` and never as `equivalence-mismatch`. Also sets `incomplete`, and the group's `match` in the bundle is `null`. |
| `equivalence-confirmed` | `info` | Every fixture in the group produced the same canonical body. |

### Text

| Rule | Severity | Raised when |
| --- | --- | --- |
| `text-sanitised` | `warning` | A string reaching output carried a control, DEL, C1, line-separator or bidi formatting character. Each was replaced with a space, and this finding is the record that it happened. |

### Output

`--out` writes the normalized bundle. It is written only when the run would otherwise pass.

The destination itself is checked before anything is opened, and a destination that cannot be
written to safely is a **configuration error**: the run exits `2` with an empty stdout and no
report, because a run whose destination was never usable has nothing to report about one. Three
independent refusals, none of which catches the other two:

| Refused | Why the obvious guard misses it |
| --- | --- |
| The destination is a **symbolic link** | `realpath` on the destination *resolves* the link, and resolving is the dangerous act. It is refused on sight with `lstat`, before anything is opened — including a link whose target does not exist yet, which would otherwise create a file outside the job's directory. |
| The destination resolves **outside the job's directory** | A lexical prefix check passes for `job-dir/link/bundle.json` where `link` leaves the tree, so the parent is resolved with `realpath` and then compared. |
| The destination is **one of this run's inputs** | A hard link has no target and shares no path with the input, so `realpath` and string comparison both call it a different file. Only **device and inode** see that it is the same file. |

A job normalized as an object through `normalizeJob` with no `baseDir` declared no directory, so
only the first and third refusals apply to it.

| Rule | Severity | Raised when |
| --- | --- | --- |
| `output-unwritable` | `error` | The destination passed every check above and the write still failed — a directory this process may not write into, a full disk. |
| `output-withheld` | `warning` | The run did not pass, so no bundle was written. A partial bundle is the kind of file a pipeline consumes without noticing what is missing. |

### Evidence that could not be obtained

Each of these also sets `incomplete`, so the run exits 2.

| Rule | Severity | Raised when |
| --- | --- | --- |
| `job-unreadable` | `error` | The job file could not be opened, or is not a regular file. |
| `job-not-utf8` | `error` | The job file is not valid UTF-8. |
| `job-not-json` | `error` | The job file is not valid JSON. The message carries the parser's position, line and column, never the snippet the parser quotes back. |
| `job-invalid` | `error` | The job does not match the schema below. A mapping `sourceType` that changes when rendered safely (for example an invisible mark or folded whitespace) is invalid before any payload comparison. |
| `job-unknown-key` | `error` | The job declares a key the schema does not define. A typo is refused, never ignored. |
| `mapping-duplicate` | `error` | Two mappings claim one `(provider, version, sourceType)`. Which applies is not something this tool will guess. |
| `mapping-unsupported-construct` | `error` | A pointer, type or transform outside the supported subset. Reported as unsupported, never treated as an absent field. |
| `event-version-unresolved` | `error` | The provider's `versionAt` resolves to nothing, or to something that is not a non-empty string renderable unchanged. This includes invisible marks and folded whitespace; the run is incomplete rather than claiming a visibly identical mapping is absent. |
| `event-type-unresolved` | `error` | The provider's `typeAt` resolves to nothing, or to something that is not a non-empty string renderable unchanged. The run is incomplete rather than asserting absence against a lossy display. |
| `event-file-unreadable` | `error` | A fixture file, or the events root, could not be read. |
| `event-file-not-utf8` | `error` | A fixture file is not valid UTF-8. |
| `event-file-not-json` | `error` | A fixture file is not valid JSON. The message carries the parser's position, line and column, never the snippet the parser quotes back: V8 reports `Unexpected token 'A', "..." is not valid JSON`, which reproduces a short capture in full. |
| `no-events-checked` | `error` | No fixture reached a verdict, so the run checked nothing. |

`event-file-outside-root` is the one file rule that is *not* incomplete: it is a refusal this tool
reached, and the file's contents never enter the report.

| Rule | Severity | Raised when |
| --- | --- | --- |
| `event-file-outside-root` | `error` | The fixture file resolves outside the real events root. Refused unread. |

### Bounds

Each of these also sets `incomplete`. A bound that was hit is never a smaller answer.

| Rule | Severity | Raised when |
| --- | --- | --- |
| `limit-job-bytes-exceeded` | `error` | The job file is larger than 1 MiB. It is not parsed. |
| `limit-events-exceeded` | `error` | The job declares more fixtures than `maxEvents`; the rest are not examined. |
| `limit-mappings-exceeded` | `error` | The job declares more mappings than `maxMappings`; none are applied. |
| `limit-payload-bytes-exceeded` | `error` | A fixture file is larger than `maxPayloadBytes`. It is not read. |
| `limit-payload-depth-exceeded` | `error` | A payload nests deeper than `maxPayloadDepth`, so whether the fields below that depth are unclaimed was not established. |
| `limit-unknown-fields-exceeded` | `error` | A payload has more unclaimed fields than `maxUnknownFields`. |
| `limit-value-chars-exceeded` | `error` | A mapped value is longer than `maxValueChars`. It is not truncated. |
| `limit-steps-exceeded` | `error` | The run reached the `maxSteps` work budget and stopped, in the fixture loop or in the equivalence loop. The budget is re-read after both, so a sweep the budget cut short cannot leave a verdict behind. |
| `limit-findings-exceeded` | `error` | The run produced more findings than `maxFindings`; the report is partial and says so. |

| Rule | Severity | Raised when |
| --- | --- | --- |
| `mapping-unused` | `info` | No fixture in the job selected a declared mapping, so nothing here exercises it. |

## The job schema

```json
{
  "canonicalVersion": "1",
  "unknownFields": "preserve",
  "eventsRoot": "events",
  "providers": [
    { "name": "acme", "versionAt": "/api_version", "typeAt": "/event" }
  ],
  "mappings": [
    {
      "provider": "acme",
      "version": "2",
      "sourceType": "order_created",
      "canonicalType": "order.created",
      "sourceId": "/id",
      "unknownFields": "preserve",
      "fields": [
        { "from": "/data/total_cents", "to": "amountMinor", "as": "integer" },
        { "from": "/data/currency", "to": "currency", "as": "string", "transform": "uppercase" },
        { "from": "/data/note", "to": "note", "as": "string", "required": false },
        { "from": "/data/state", "to": "status", "as": "string", "values": { "PAID": "paid" } }
      ]
    }
  ],
  "events": [
    { "ref": "acme-order", "provider": "acme", "version": "2", "file": "acme-order.json" },
    { "ref": "inline", "provider": "acme", "payload": { "id": "evt_1" } }
  ],
  "equivalence": [
    { "id": "order-created", "refs": ["acme-order", "inline"] }
  ],
  "limits": { "maxEvents": 500 }
}
```

| Key | Required | Meaning |
| --- | --- | --- |
| `canonicalVersion` | yes | The version stamped on every canonical event this job produces. |
| `unknownFields` | no | Default policy: `preserve`, `report` or `reject`. Defaults to `preserve`. |
| `eventsRoot` | only with `file` fixtures | Directory, relative to the job file, holding fixture files. |
| `providers` | yes | Where each provider puts its version and its event name. At most 64. |
| `mappings` | yes | One mapping per `(provider, version, sourceType)`. |
| `events` | yes | The fixtures. Each declares exactly one of `file` or `payload`. |
| `equivalence` | no | Groups of two to sixteen refs claimed to normalize to one canonical body. |
| `limits` | no | Bounds, below. |

Names (`providers[].name`, `canonicalType`, `equivalence[].id`, `events[].ref`) match
`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Versions match `[A-Za-z0-9][A-Za-z0-9._-]{0,31}` and are
compared **literally**. Canonical field names (`fields[].to`) match `[A-Za-z][A-Za-z0-9_-]{0,63}`.

An unknown key anywhere in this schema is refused with `job-unknown-key`. That is deliberate: a
one-character typo in `unknownFields` would otherwise turn a `reject` policy into the default
`preserve` with nothing said, and a real failure would go green.

### Field declarations

- `as` is one of `boolean`, `integer`, `number`, `string`. It is a **check**, not a conversion.
- `required` defaults to `true`.
- `transform` is one of `none`, `lowercase`, `trim`, `uppercase`, and applies only to `as: "string"`.
- `values` enumerates the source strings the field accepts and what each becomes. It requires
  `as: "string"`, applies after `transform`, and is exhaustive: a value not listed is refused with
  `field-value-unmapped` rather than carried across unmapped. At most 64 entries.

## The supported pointer subset

Pointers (`versionAt`, `typeAt`, `sourceId`, `fields[].from`) are RFC 6901 JSON Pointers, with
these bounds and these exclusions:

- Absolute only: a pointer must begin with `/`. At most 200 characters and 32 tokens.
- `~1` is `/` and `~0` is `~`. Any other `~` escape is refused.
- A numeric token addresses an array element by index.
- **Not supported**, each refused explicitly with `mapping-unsupported-construct`: the empty
  pointer (the whole document), the `-` token (one past the end of an array), wildcards, JSONPath
  expressions, dotted paths and relative pointers.

An unsupported construct is never treated as "this field was absent". A pointer the tool did not
understand is not evidence about the payload.

## The canonical event

```json
{
  "ref": "acme-order",
  "canonical": {
    "version": "1",
    "type": "order.created",
    "data": { "amountMinor": 4250, "currency": "USD", "orderId": "ORD-5521" }
  },
  "source": { "provider": "acme", "version": "2", "type": "order_created", "id": "evt_ACME_1001" },
  "extensions": [{ "pointer": "/data/tracking_hint", "value": "warehouse-3" }]
}
```

- `canonical` is **the internal shape**. It is what an equivalence group compares, and what two
  providers spelling one event differently are expected to agree on exactly.
- `source` is provenance: the provider, the provider's own version string, the provider's own
  event name and the provider's own event id. Two providers are *expected* to differ here — that
  is why it is kept out of the canonical body rather than mixed into it.
- `extensions` is present only under the `preserve` policy. It is an **array** of
  `{ pointer, value }`, sorted by pointer, rather than an object, so that two payload keys which
  sanitise to the same string cannot collide and silently become one.
- `data` keys are sorted by UTF-16 code unit, so the emitted JSON is byte-identical run to run.

## Limits

| Limit | Default | Ceiling | Bounds |
| --- | ---: | ---: | --- |
| `maxEvents` | 500 | 5000 | Fixtures examined. |
| `maxMappings` | 200 | 2000 | Mappings a job may declare. |
| `maxPayloadBytes` | 65536 | 4194304 | Bytes per fixture file, checked before it is read. |
| `maxPayloadDepth` | 16 | 64 | Nesting depth of a payload. |
| `maxUnknownFields` | 128 | 4096 | Unclaimed fields per payload. |
| `maxValueChars` | 512 | 65536 | Characters in one mapped value. |
| `maxSteps` | 200000 | 5000000 | Work budget for the run. |
| `maxFindings` | 500 | 5000 | Findings in one report. |

Fixed bounds, not configurable: the job file is at most 1 MiB, a job declares at most 64
providers, a mapping at most 64 fields, a `values` map at most 64 entries, and an equivalence
group at most 16 refs from at most 64 groups.

### Why there is no wall-clock timeout

`maxSteps` is this tool's time bound, and it counts work rather than milliseconds. A deadline
measured against the clock would make the report a function of machine speed and load: the same
bytes would report `incomplete` on a busy laptop and `pass` in CI, and "unknown is never a pass"
would quietly become "unknown is a pass when the machine is fast enough". A work budget is too
large everywhere or nowhere, and two runs over the same bytes always agree.

## Report and exit codes

The report is the Edilec report contract v1 envelope — `schemaVersion`, `tool`, `status`,
`summary`, `findings` — plus one additional top-level object, `normalization`, carrying the
canonical version, the policy, the provider and mapping lists, the normalized events in declared
order, and the equivalence verdicts.

Findings sort by `(location.file, location.pointer, ruleId, message, evidence)`, every comparison
by UTF-16 code unit.

| Code | stdout | Meaning |
| ---: | --- | --- |
| `0` | the report | Every fixture reached a verdict and the policy was satisfied. |
| `1` | the report | The run completed and the policy failed. |
| `2` | **empty** | Invalid usage or configuration. The run never had a subject. |
| `2` | the report, `status: "incomplete"` | Evidence that could not be obtained. Never a `pass`. |

## What this tool cannot conclude

- **That a mapping is correct.** It checks that a mapping applies cleanly and that two providers
  agree. Whether `amountMinor` should have come from `total_cents` is a question about your
  business, and nothing here can answer it.
- **That a canonical schema is right.** There is no canonical schema registry, no validation of
  the canonical body against one, and no opinion about what fields an `order.created` should have.
  `canonicalVersion` is a string this tool stamps, not a contract it checks.
- **That a provider's version scheme means anything.** Versions are opaque strings compared
  literally. `"3"` is not later than `"2"` here, and `"2.0"` is not `"2"`.
- **That the fixtures resemble live traffic.** A fixture set is what someone captured. Coverage of
  a provider's real event space is not something this tool can see.
- **That an unclaimed field is unimportant.** It reports every one of them under a policy you
  chose. Which of them your system needed is not visible from here.
- **That a payload is safe.** It sanitises the strings it emits so a report cannot be forged
  through them. It does not validate, escape or authenticate anything for a downstream consumer.
- **Anything about delivery.** No socket is opened. Signatures, retries, ordering and delivery
  semantics are other tools' subjects.
