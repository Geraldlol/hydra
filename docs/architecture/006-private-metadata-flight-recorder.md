# ADR 006: Strict private metadata Flight Recorder

- Status: Accepted for staged implementation
- Date: 2026-07-24
- Owners: Hydra maintainers

## Context

Hydra currently writes several useful but tolerant diagnostic streams,
including `.hydra/agent-calls.jsonl`, `events.jsonl`, usage, verification, and
native-action records. They were not designed as replay evidence:

- schemas are permissive or record-specific rather than one causal model;
- malformed rows may be skipped by diagnostic readers;
- argv, paths, stderr previews, provider summaries, assistant text, and tool
  data can contain content;
- lifecycle relationships and completeness are not proven; and
- the current steering chain is a separate diagnostic row rather than a
  binding on completion, usage, and verification.

The next platform needs one bounded room/phase/head/tool/verifier timeline.
Replay and eval conversion also require a clear distinction between observed
metadata and retained input content. A trace must not become authority merely
because it looks complete.

## Decision

### A new recorder, not a reinterpretation of legacy logs

Hydra introduces the internal schema family `hydra.flight.v1`. Existing
diagnostic logs remain for compatibility but are never trusted for replay,
eval, deterministic reproduction, or contract enforcement. Redacted
duel-compatibility rows remain unchanged until their consumers migrate.

The initial recorder has no OpenTelemetry SDK dependency. Its concepts and
attribute names are OpenTelemetry-shaped where they fit, but its exact schema
is Hydra-owned and versioned. OpenTelemetry GenAI conventions moved from the
core semantic-conventions repository into a dedicated repository in 2026;
the agent conventions and content attributes remain development/opt-in
surfaces. Export becomes a later projection pinned to a verified convention
version rather than the storage contract.

### Trace and record model

Each room turn has one trace ID. Records have exact keys:

```text
schemaVersion, recordId, traceId, sequence, occurredAt,
recordType, operationKind, operationId?, parentOperationId?,
missionBindingSha256, previousRecordSha256, recordSha256, payload
```

Record types are `traceStarted`, `operationStarted`, `operationEvent`,
`operationFinished`, `traceLimited`, and `traceFinished`. Operation kinds are
the bounded set `roomTurn`, `phase`, `agentRun`, `toolCall`, `editBatch`,
`approval`, `steeringDelivery`, `verification`, `usage`, `nativeAction`,
`browserAction`, `replay`, and `evalCase`.

Every record uses a strict kind-specific metadata payload. There is no generic
attributes bag or free-form detail field. The v1 default excludes:

- prompt, transcript, source, and response bodies;
- raw command lines, environment values, tool arguments, and tool results;
- raw URLs, page content, screenshots, and file contents;
- stderr/stdout previews; and
- private provider session IDs or unrevealed Jury/duel payloads.

Allowed metadata includes bounded stable IDs, hashes, counts, byte/character
sizes, low-cardinality status/failure codes, model/provider labels, effective
authority classification, timing, token/cost summaries, verification plan and
receipt hashes, workspace state hashes, and the exact Mission Contract and
steering-chain bindings. Provider-native evidence is labeled as observed,
not provider-signed.

Content capture is off by default. A future explicit opt-in stores bounded
encrypted/private content objects separately by hash and retention policy.
Turning it on never changes the metadata ledger schema or retroactively claims
missing content.

### Integrity, storage, and completeness

Authoritative traces live in private workspace-specific extension storage:

```text
<storageUri>/flight/traces/<traceId>.v1.jsonl
<storageUri>/flight/index.v1.jsonl
```

`.hydra/flight-recorder.md` is a disposable redacted timeline mirror. It is
not replay or eval input.

The strict per-trace file is the sole authority for lifecycle and eligibility.
`index.v1.jsonl` is only a bounded, rebuildable discovery cache: a stale,
missing, forged, or failed index append can neither hide a valid trace from a
rebuild nor make an incomplete trace replay-eligible. Crash recovery scans
strictly named trace files beneath the private root and refuses symlink or
path-swap escapes.

Per-trace files avoid replaying one repository-lifetime global ledger. Initial
bounds are 8 MiB, 10,000 records, and 16 KiB per record, pinned by tests.
Appends use cross-process serialization, monotonically increasing sequence
numbers, a previous-record hash chain, and complete replay validation.
Unknown versions, missing final newlines, invalid hashes, orphan parents,
duplicate IDs, double finishes, impossible ordering, or exceeded bounds make
the trace incomplete. Active traces are never retention-pruned.

Ordinary and provider-derived events may consume only the payload budget left
after reserving space and record slots for exactly one `traceLimited` record
and the terminal incomplete-health state. The recorder also bounds the number
of simultaneously open operations. It enters the limited state before the
hard record or byte boundary, rejects all later ordinary events, emits one
parseable `traceLimited`, and never emits a falsely complete `traceFinished`.
No append may make the trace exceed either hard cap.

Validated trace state is explicit: `active`, `complete`, `limited`,
`incomplete`, or `invalid`. Parseability alone is never completeness. After
any dropped, failed, or ambiguous append the controller latches degradation,
stops ordinary telemetry, emits at most one sanitized health notice, and
best-effort terminalizes as incomplete without retrying submitted work. If
the terminal append fails, the missing finish remains incomplete. Controller
methods return nonthrowing receipts so recorder failure cannot cancel or
duplicate an agent/verifier operation.

Sequence starts at one and is assigned contiguously by the store while holding
the per-trace cross-process lock. The first record names one fixed genesis
previous-hash sentinel. Each record hash uses a pinned domain separator and
canonical record-without-hash bytes, covering the previous hash and strict
payload; every line must equal canonical serialization plus one final newline.
Callers and providers never choose trace paths, sequence, record hash, parent,
Mission binding, or authority binding. The replay validator enforces unique
operation IDs, existing earlier parents, no cycles, events/finish only for
open operations, exactly one finish, root-before-trace finish, no required
open children at complete finish, no records after finish, and one trace and
Mission binding throughout. Sequence, not wall-clock time, establishes
causality.

Live traces carry a fresh private owner lease. Stale-owner traces become
incomplete without fabricating a successful finish. Cross-process retention
bounds total trace files and bytes, preserves live-owner traces, and gives
stale incomplete traces a bounded retention path so repeated crashes cannot
grow storage without limit.

Recorder failure does not cancel the user's underlying agent or verifier
operation. Hydra reports the recorder as incomplete, emits a bounded
best-effort health notice, and disables Replay/Create Eval for that trace.
It never silently presents a partial trace as complete.

### Instrumentation boundaries

- The orchestration entry point starts a root trace before the initiating
  `applyEvent` (`userSent`, builder assignment, review request, hand-back, or
  Stop) and passes that already-started trace into `runTurn`. Reservation
  failure and synchronous exceptions remain in the same trace and terminalize
  it incomplete. Standalone control transitions use an explicit causally
  linked control trace; no accepted transition silently falls back to only the
  legacy event log.
- `applyEvent` records a phase transition only after the canonical
  `transition()` reducer accepts it.
- Prompt-envelope construction records prompt/context/component hashes before
  body compaction, never their bodies.
- Agent planning records the exact trace ID, contract hash, authority
  classification, model, transport, guard/consent outcome, and invocation
  shape. A separate private keyed commitment is required before sensitive
  effective environment values can be bound; the existing steering hash over
  environment key names is not effective-authority proof.
- One-shot, Terminal Bridge, HTTP, Codex App Server, and Claude session paths
  record exactly one start and terminal outcome. Structured provider streams
  normalize fixed metadata for tool/edit lifecycle; plain output explicitly
  records that detailed telemetry was unavailable.
- Steering projects metadata only after the authoritative steering event
  append succeeds. Completion, usage, verification, claims, and convergence
  bind the terminal steering-chain hash and its indeterminate flag.
- Verification uses one verification ID and exactly one terminal record for
  pass, failure, cancellation, timeout, or unconfirmed termination.
- Browser, native action, and approval controllers receive narrow recorder
  sinks; they never pass content-bearing payloads.

Provider floods produce `traceLimited` plus explicit completeness limits rather
than unbounded cardinality or a false complete view.

Provider telemetry is a one-way normalizer, never a control-record parser.
Host code supplies lifecycle, trace, operation, Mission, and authority
identity. Provider data may add only allowlisted, bounded, explicitly
provider-observed enums, counts, and remapped/hash identifiers. Free-form
labels/errors are dropped, active provider items and cardinality are capped,
and provider completion cannot create or close host operations.

The workspace-readable mirror omits content-derived prompt, context, command,
and verification hashes as well as bodies; raw hashes of low-entropy text can
act as dictionary oracles. It contains only safe lifecycle summaries and
private opaque IDs needed for human orientation.

### Safe replay and eval conversion

A replay is always a new trace, new run, and new consent/cost decision in an
isolated disposable worktree at an explicitly selected base. It does not reuse
provider sessions, grant authority, merge, commit, push, publish, or prove
deterministic reproduction.

Exact replay is available only when separately retained opt-in content exists
and every source hash matches. Otherwise the user supplies replacement input
and Hydra labels the run a derived regression. Incomplete, corrupt, limited,
or content-missing traces cannot drive exact replay.

Creating an eval case is an explicit user action into a separate private
append-only created/corrected/voided event stream. Expected outcomes come from
an exact deterministic mapping or human adjudication, never an LLM judge,
peer vote, or an unrelated passing test.

## Consequences

### Positive

- Hydra gains a causal, bounded, strict timeline without making content
  collection the default.
- Mission, steering, usage, verification, and later Jury/Arena evidence share
  explicit provenance.
- Corruption and telemetry gaps are visible and cannot masquerade as replay
  proof.
- A future OpenTelemetry exporter does not control Hydra's on-disk migration.

### Negative

- The recorder duplicates selected metadata from existing diagnostic stores
  until those consumers migrate.
- Strict per-trace validation and cross-process sequencing add I/O and recovery
  complexity.
- Metadata-only traces cannot perform exact replay without a separate future
  content opt-in.

## Alternatives considered

- Upgrade `.hydra/agent-calls.jsonl` in place: rejected because existing
  content-bearing, permissive history cannot be reinterpreted safely.
- Store the authoritative recorder in `.hydra`: rejected because replay/eval
  eligibility would then depend on workspace-editable evidence.
- Adopt the current OpenTelemetry GenAI schema directly: rejected because the
  dedicated conventions are still evolving and content fields are sensitive
  opt-in data.
- Treat recorder write failure as agent failure: rejected because diagnostic
  durability must not duplicate or cancel already submitted model work.

## Validation and rollout

Tests cover exact schema/no-extra-key enforcement; record/hash/sequence/parent
validation; torn, oversized, unknown, duplicate, orphan, and double-finish
records; concurrent append and crash recovery; retention; metadata canary
scans; provider normalization and flood limits; every transport terminal path;
steering-chain equality across completion/usage/verification; browser and
native-action content absence; exact record/byte-boundary floods with reserved
terminal capacity; bounded open operations; and replay/eval gates.

Failure-injection covers trace start, ordinary event, terminal finish, index,
and mirror writes while asserting the underlying operation result is
unchanged, health output is sanitized and emitted once, and eligibility stays
false. Two-store append races reopen to a contiguous valid chain. State-machine
permutations cover event-before-start, child-before-parent, duplicate
start/finish, parent finish before a required child, late events, and equal or
out-of-order timestamps. Index rebuild tests cover crashes between trace and
index writes. Crash-storm retention tests cover fresh/stale owner leases,
concurrent cleanup windows, and path-swap refusal. Canary tests scan the
private ledger, cache, mirror, health text, and export for prompt/source/
response bodies, argv/env values, URLs, paths, tool arguments/results, raw
exceptions, provider sessions, and sealed payloads. Initiating transition
coverage includes user send, builder assignment, review request, hand-back,
Stop, reservation failure, and auto-advance causal links exactly once.

Roll out protocol/store/controller first, then agent and steering lifecycles,
then verification/usage/native/browser projections, then the mirror and
extension-host smoke. Replay and eval remain unavailable until isolation,
consent, cost, and retained-content gates land. Rollback disables recording
and hides the mirror while preserving private traces for inspection.

### Current staged implementation

The first runtime stage records one Mission-bound trace for each `runTurn`
execution and direct multi-head native poke, with a phase parent and exactly
one terminal `agentRun` operation per participating head. Completion carries
the terminal steering-chain hash read only after the provider acceptance queue
closes; if that read is unavailable, the chain is explicitly indeterminate.
The start record labels only the planned transport; completion records the
actual HTTP, Terminal Bridge, ordinary one-shot, Codex App Server, Codex
one-shot fallback, or Claude session path selected at runtime. That selected
path is not proof that provider bytes crossed the boundary: the terminal status
and failure code are authoritative for a proven zero-write cancellation or
Mission rejection, and ambiguous App Server/session writes are explicitly
`deliveryUnknown`. Guard, consent, timeout, cancellation, and unconfirmed
termination outcomes retain their known terminal class instead of collapsing
into a generic provider failure.

Prompt construction computes a private domain-separated root over the exact
dynamic context components supplied to the builder, while `promptSha256`
commits the final rendered prompt. The component root is attached
non-enumerably to the in-memory prompt envelope, passed directly to Flight,
and omitted from `.hydra/prompts/index.jsonl` and the disposable Flight mirror.

Recorder lifecycle writes are ordered per trace but queued off the provider
critical path. Startup stale recovery, retention, index rebuild, and mirror
projection are detached, rejection-fenced derived work; an explicit
diagnostic flush waits for them. A blocked recorder lock therefore cannot
delay model submission or keep the room UI in-flight. Fan-out paths abort and
drain every started call before queuing parent completion. Panel disposal
queues an incomplete close for admitted open traces before releasing the
private owner lease. Recorder failure remains nonthrowing with respect to the
underlying agent operation and makes the affected trace ineligible.

This stage deliberately does **not** claim full transition coverage yet.
Existing entry points reserve the canonical phase with `applyEvent` before
`runTurn` begins, so the initiating transition is not yet inside the Flight
trace. Standalone raw-line/native commands, Stop, accepted intermediate phase
transitions, verification, usage, tool/edit normalization, browser/native
actions, Replay, and Create Eval still require their later controller sinks.
Until those integrations land, the recorder is a strict partial timeline, not
a complete regression receipt.

## Source anchors

- OpenTelemetry semantic conventions:
  https://opentelemetry.io/docs/specs/semconv/
- OpenTelemetry event guidance:
  https://opentelemetry.io/docs/specs/semconv/general/events/
- Dedicated OpenTelemetry GenAI conventions:
  https://github.com/open-telemetry/semantic-conventions-genai
