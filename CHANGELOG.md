# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- a mapping engine that selects a mapping by an exact `(provider, version, sourceType)` match and
  by nothing else — no nearest-version fallback, no numeric version comparison, no "latest", no
  prefix match — so a payload whose version nobody mapped is refused rather than mapped with rules
  written for something else;
- provenance that survives normalization: every canonical event keeps the provider, the provider's
  own version string, the provider's own event name and the provider's own event id, and a payload
  whose id cannot be read is refused rather than normalized anonymously;
- a canonical event separated into the body two providers must agree on (`version`, `type`, `data`)
  and the `source` block they are expected to differ in, so "the same internal shape" is a thing
  that can be asserted by deep equality rather than approximated;
- equivalence groups the tool checks for itself: name two or more fixtures and it deep-compares
  their canonical bodies, names the first field that differs, and refuses to call a group satisfied
  when one of its members never normalized or when the work budget stopped the comparison part-way
  through it — a group compared in part reads as `null`, never as one that holds;
- a declared policy for every field no mapping claimed — `preserve` carries it under `extensions`,
  `report` names it and drops it, `reject` refuses the payload — with one finding per field, so a
  dropped field is never a silent one;
- a mapping language with a type check and no conversion anywhere: `as` is checked, never coerced,
  so a `"4250"` declared `integer` is a mismatch; `transform` is one of four total operations; and
  `values` enumerates the source strings a field accepts, refusing any value not listed;
- a bounded, declared RFC 6901 pointer subset, with wildcards, JSONPath, relative pointers, the
  whole-document pointer and the `-` token each refused as an unsupported construct that makes the
  run incomplete — never treated as a field that happened to be absent;
- strict UTF-8 decoding with `TextDecoder('utf-8', { fatal: true })` for every byte source, the job
  file included, so whether an input is decodable is the decoder's decision and never an inference
  drawn from the decoded text;
- real-path containment on both sides, so a symlink out of the events root is refused unread while
  a fixture genuinely inside a root reached through a symlink is still normalized — a false refusal
  is a bug too;
- an `--out` destination checked for all three ways a named path is not the file it names — a
  symbolic link at the destination, refused unresolved with `lstat` because `realpath` would
  *resolve* it and resolving is the dangerous act; a parent that leaves the job file's own
  directory, caught by resolving the parent rather than comparing strings; and a hard link to one
  of this run's inputs, caught on device and inode because a hard link has no target and a
  real-path comparison would let the tool overwrite its own input. A refused destination is a
  configuration error: exit 2, empty stdout, nothing written. The bundle is also withheld from any
  run that did not pass;
- explicit bounds on fixtures, mappings, payload bytes, payload nesting depth, unclaimed fields,
  mapped value length, findings and total work, each reported by the name it is configured under
  and each making the run `incomplete` rather than truncating it quietly;
- a deterministic work budget in place of a wall-clock timeout, because a deadline measured against
  the clock would make the verdict a function of machine speed — `incomplete` on a busy laptop and
  `pass` in CI is not a bound, it is a coin toss;
- sanitisation of every untrusted string that reaches output — provider names, event ids, event
  names, object keys, pointers, paths, messages and evidence alike — removing C0, DEL, the whole C1
  range (where `U+0085` NEL and the 8-bit CSI `U+009B` live), the line and paragraph separators,
  and the bidi formatting characters, whose `U+202E` would otherwise reverse everything displayed
  after it; a value that was altered raises `text-sanitised`, so nothing is changed in silence;
- a CLI with `--help`, `--version`, `--json`, `--label`, `--out` and the limit flags, the JSON
  report on stdout and nothing else, diagnostics on stderr, and exit codes 0 / 1 / 2 — with an
  empty stdout for a configuration error and an `incomplete` report for evidence that could not be
  obtained, and with an unknown option or a repeated value-carrying flag refused rather than
  silently overwriting the earlier value;
- `normalizeJob` and `normalizeJobFile` as the public API, the first taking a job object;
- runnable clean and deliberately broken example jobs; the clean one is the acceptance evidence and
  the broken one collects every refusal in one place;
- the rule catalog, job schema, pointer subset, canonical shape, limits, report shape, exit codes
  and the list of things this tool cannot conclude in `docs/normalization-rules.md`.

### Guaranteed

- No socket is opened. This package imports no socket, HTTP, datagram, resolver, TLS or subprocess
  module and invokes no fetch primitive, so there is no code path a payload could steer towards a
  network. `test/no-network.test.mjs` proves it the direct way: it opens a real listener on a real
  loopback port, plants that listener's own URL in the job and in the payload, and asserts the
  listener saw no connection and no request.
- Unknown evidence is never a pass. Every path that could report silence as health — an unreadable
  job, an unreadable fixture, a bound that was hit, an equivalence nobody could check or that the
  step budget cut short, a run that reached a verdict on nothing — sets `incomplete` and exits 2.
  Every one of the eighteen places the flag is raised was neutralised in turn and the failure
  watched; none survives.
- Two runs over the same bytes produce byte-identical stdout. No wall clock, random source,
  environment variable or locale reaches the output, nothing is discovered by listing a directory,
  and two payloads that differ only in JSON key order produce one report.
- Severity is pinned by consequence rather than by declaration. `test/severity-decides.test.mjs`
  and `test/severity-incomplete.test.mjs` import nothing from `src`, hold no rule table, no
  severity map and no parameterised expectation: each case writes its own job, runs the real
  binary, and states its exit code, status, counted errors, counted warnings, counted info and
  printed severity word as literals at the assertion. Flipping a rule in the frozen table, in the
  documented catalog and in every list of expectations in the tests, all at once, is caught for all
  36 error rules and in both directions for the 7 that are not errors.
- Ordering is pinned by what the tool emits. Eleven call sites order something that reaches output.
  An English collator substituted at each of them in turn is caught at ten, by fixtures whose
  collation order and code-unit order disagree — `Z` against `a`, `a-b` against `a_b`. The
  eleventh orders rule ids over `[a-z0-9-]`, an alphabet on which collation and code units agree on
  all 1722 ordered pairs; that is enumerated in `test/finding-order.test.mjs` and recorded as an
  equivalent mutant rather than counted as coverage.
- Each guarantee above was removed in turn and the failure watched — demoting a severity,
  substituting a collator, dropping the C1 range from the strip set, replacing real-path
  containment with a prefix test, replacing the device-and-inode identity test with a real-path
  comparison, removing an `incomplete` flag, dropping a `sanitize` call, unwiring a CLI flag from
  the engine. Writing those tests found two real defects and fixed both. `--max-events` and
  `--max-mappings` were applied after the job had already been validated with the defaults, so both
  documented limits were accepted on the command line and silently ignored. And the equivalence
  loop checked its step budget only *before* it ran: an inner `break` on an exhausted budget left
  `match` at its initial `true` and fell into the branch that records `equivalence-confirmed`, so a
  group whose fixtures genuinely differ was reported as holding, with `match: true` in the bundle,
  at exit 0 and status `pass` — reachable from the job file alone, through `limits.maxSteps`. The
  budget is now re-read after the loop and every way the loop can stop early is `unresolved`.
- A second mutation pass over the tests closed four gaps the first one missed: a mapping fallback
  on `(provider, sourceType)` that would read a version 1 field list out of a version 2 payload,
  the `rawId !== ''` half of the source-id check (an empty-string id normalized anonymously), four
  `incomplete` assignments whose only other guard was `no-events-checked` masking them, and the
  sanitisation scanner's missing positive control.

### Fixed

- **Data loss.** `--out` accepted a symbolic link at the destination, so the bundle was written
  through the link onto a file in another tree entirely. Reproduced before the fix: a file outside
  the job directory holding `PRECIOUS-WEBHOOK` was replaced by the bundle and the run exited `0`
  with an empty stderr. The destination is now checked before anything is opened — `lstat`
  refuses a symbolic link on sight, including one whose target does not exist yet, so a dangling
  link cannot quietly create a file outside the root either — and the same run now exits `2`
  with an empty stdout and leaves the file untouched. `test/destination-guard.test.mjs` drives the
  real binary through one case per hole plus four destinations that must still be **written**,
  because a guard that refuses everything passes every data-loss case while making the tool
  useless. Each of the three checks was removed in turn and the failures watched.

### Changed

- `--out` must now resolve inside the job file's own directory. A job normalized as an object
  through `normalizeJob` with no `baseDir` declared no directory, so only the symlink and
  device-and-inode refusals apply to it.
- The `output-is-input` rule is gone. A destination that cannot be written to safely is a
  configuration error now rather than a finding: the run exits `2` with an empty stdout instead of
  `1` with a report, because a run whose destination was never usable has nothing to report about
  one. `output-unwritable` remains, for a destination that passed every check and could not be
  written anyway.

### Notes

- The report envelope is the Edilec report contract v1. `normalization` is an additional top-level
  object carrying the canonical result; the five required envelope fields are present and
  unchanged.
- There is deliberately no JSON Schema or OpenAPI support. This tool implements a small mapping
  language it can enforce honestly and declares everything outside it as unsupported, rather than
  delegating to half a validator and disclaiming the rest.

No release has been published.
