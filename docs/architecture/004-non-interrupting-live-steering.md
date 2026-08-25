# ADR 004: Non-interrupting, capability-negotiated steering of active heads

- Status: Accepted; implemented for supported capability-negotiated transports and authenticated relays
- Date: 2026-07-24
- Owners: Hydra maintainers

## Context

Hydra currently accepts a composer message while a room turn is running, but it
does not deliver that message to the active head. `sendUserMessage` appends it
to an in-memory queue and starts a new Hydra turn only after the current turn
finishes. The UI correctly labels this behavior `QUEUE`.

That queue is also insufficient as a durable steering foundation: its user row
is initially UI-only and the transcript write is deferred until drain. An
extension-host crash can therefore lose the queued intent or leave ambiguous
transcript ordering. Steering must persist before delivery.

The existing process transports cannot be repurposed safely as live steering:

- one-shot calls write the initial prompt to child stdin and immediately close
  stdin;
- Terminal Bridge launches a fresh child for each request and serializes calls
  per head;
- raw terminal input is blocked while a Hydra turn is in flight and has no
  source-bound acknowledgement from the agent runtime; and
- `AgentAdapter` exposes invocation construction and output parsing, but no
  active-run handle or negotiated live-control capability.

The next-generation feature slate requires a ninth capability: while ordinary
room work is active, the user must be able to add context or redirect one or
more active heads without cancelling their work. This must work across Codex,
Claude, ACP, and future Hydra heads without pretending that every provider has
identical mid-turn semantics.

Current provider surfaces differ:

- Codex app-server has a bound `turn/steer` request. It appends input to the
  active turn and requires both `threadId` and the expected active `turnId`.
- Claude Code supports a long-lived stream-json input session. Additional
  messages are acknowledged and processed sequentially without killing the
  process, but the documented contract describes them as queued messages, not
  guaranteed same-model-turn injection.
- stable ACP v1 provides persistent sessions and prompt/update streaming, but
  does not standardize same-turn steering. ACP v2's more dynamic prompt
  lifecycle is still draft and explicitly leaves queueing semantics for later
  work.
- generic CLI-template and HTTP heads may expose no live-control surface at
  all.

Hydra therefore needs one honest steering abstraction with explicit delivery
timing, rather than terminal keystroke injection or a provider-specific branch
inside `HydraRoomPanel`.

## Decision

### Steering is distinct from interruption and ordinary queueing

Hydra uses these user-visible delivery classes:

| Delivery class | Meaning |
| --- | --- |
| `sameTurn` | The provider acknowledged that the message was appended to the exact active logical turn. |
| `yieldThenNext` | The provider acknowledged a graceful yield after its current safe operation, then processes the message next in the same live session. No process abort or restart occurs. |
| `sameSessionNextTurn` | The provider or Hydra queued the message inside the already-running persistent session for the next safe provider turn, without cancelling or restarting the process. |
| `nextHydraTurn` | The current head cannot accept live input; Hydra will run the message through the existing room-turn queue after the active Hydra turn ends. This is queueing, not live steering. |
| `unsupported` | Hydra cannot deliver safely and leaves the message available to retry or explicitly queue. |

Only the first three classes are shown as steering. Hydra never describes a
terminal write, process restart, interrupt-and-resume sequence, or a future
room turn as same-turn steering.

The primary composer action while ordinary work is active becomes `STEER` when
at least one selected active head supports `sameTurn`, `yieldThenNext`, or
`sameSessionNextTurn`. `Queue after turn` remains an explicit alternative.
The UI shows the selected targets and each target's expected delivery class
before send, then replaces that preview with a per-target acknowledgement.

The default target is the visible set of active runs at the instant the user
opens the steering action. A target selector permits one run, several runs, or
all visible active runs. It labels nested workers separately even when several
runs share the same canonical agent ID. Hydra never infers targets from prose.
Nested workers are targetable only when they have their own visible, registered
active-run handle.

### Live control is an adapter capability

Add a focused live-control contract beside the existing invocation contract:

```ts
type SteeringDelivery =
  | "sameTurn"
  | "yieldThenNext"
  | "sameSessionNextTurn"
  | "nextHydraTurn"
  | "unsupported";

interface ActiveAgentRunHandle {
  readonly agentId: AgentId;
  readonly callId: string;
  readonly generation: string;
  readonly capability: SteeringDelivery;
  steer(request: SteeringRequest): Promise<SteeringAcknowledgement>;
  close(reason: "completed" | "cancelled" | "failed"): Promise<void>;
}
```

The real types also bind the room session, phase, provider session/thread,
active provider turn when one exists, Mission Contract hash, and effective
authority hash. They use discriminated unions and strict runtime guards rather
than optional fields that can form impossible states.

`agentAdapter.ts` declares the optional session-control capability and
`agentRegistry.ts` resolves it. Provider modules implement it. The panel does
not branch on `codex`, `claude`, or `acp`.

Create focused modules:

- `src/steeringProtocol.ts` - pure request, acknowledgement, capability, and
  event schemas plus validation;
- `src/steeringStore.ts` - private append-only event replay and crash-safe
  pending delivery state;
- `src/steeringController.ts` - trace/call-ID-keyed active-run registry, target
  snapshots, bounded per-run delivery queues, lifecycle fencing, and UI
  snapshots;
- `src/codexAppServerTransport.ts` - Codex JSON-RPC session and
  `turn/steer`;
- `src/claudeSessionTransport.ts` - Claude stream-json input/output session;
  and
- `src/acpTransport.ts` - stable ACP v1 session transport and negotiated
  capabilities.

`HydraRoomPanel` receives one `SteeringController` with a narrow dependency
object. Transports register an active handle only after the provider has
acknowledged the run start and unregister it before final completion becomes
visible. `src/phases.ts` remains the only room phase reducer; steering lifecycle
is orthogonal runtime state and never mutates a phase directly.

The controller assigns a unique `roomTurnId`, reuses the existing unique
call/trace ID as `runId`, and assigns a monotonic steering sequence within that
room turn. Provider thread, session, and turn identifiers stay inside the
private transport handle. They are never written to `.hydra` mirrors.

### Provider mappings are explicit and version-gated

| Head/runtime | Initial mapping | Required acknowledgement |
| --- | --- | --- |
| Codex | `sameTurn` through app-server `turn/steer` | Response `turnId` exactly matches the registered active turn, the request used its `expectedTurnId` precondition, and Hydra passes the steering UUID as `clientUserMessageId` when supported. |
| Claude Code | `sameSessionNextTurn` through `--input-format stream-json`, `--output-format stream-json`, and user-message replay. It may upgrade to `yieldThenNext` only after the installed runtime explicitly advertises and passes a contract test for that behavior. | The exact FIFO message is replayed by the same live session; later provider results prove processing. It is never labeled same-turn without a stronger documented provider contract. |
| ACP v1 | `sameSessionNextTurn` only when the session survives the current prompt and the adapter can submit the next prompt at a safe session boundary | Stable ACP request response plus session-id-bound updates. Concurrent prompt submission is never assumed. |
| CLI-template / HTTP | `nextHydraTurn` by default | Existing Hydra queue receipt. A custom adapter may advertise a stronger class only after a runtime capability handshake. |

Codex room calls use app-server only when Hydra can preserve the effective
model, working directory, approval policy, sandbox/authority, configured
integrations, and environment policy of the existing invocation. An
unmappable flag or failed capability probe disables live steering for that
head; Hydra does not silently weaken or broaden authority to gain steering.

Claude's stdin remains open only in the session transport. One-shot and
Terminal Bridge behavior stays unchanged. A replayed user message acknowledges
acceptance into the live process, not completion by the model. The current
Claude Agent SDK exposes message priorities such as `now`, `next`, and `later`,
but their exact current-turn semantics are not sufficiently documented for
Hydra to equate `now` with Codex `turn/steer`. Hydra keeps the active call open
until all accepted FIFO messages reach a terminal provider result or the run
fails.

Claude can emit more than one result envelope during a controlled run. The
transport aggregates every segment's text and usage instead of reusing the
current last-result normalization. Cost, token, completion, and verification
receipts bind the aggregate.

Hydra targets stable ACP v1 for the planned ACP adapter. It does not make core
steering depend on draft ACP v2 behavior. A future v2 adapter may advertise a
stronger delivery class only after protocol negotiation and conformance tests.

All provider capabilities are discovered at runtime and cached only for the
extension-host session. Doctor reports the exact installed version, available
delivery class, parity-check result, and reason for any downgrade. Unknown
schema versions and malformed acknowledgements fail closed.

The 2026-07-24 package check found official `@agentclientprotocol/sdk` version
`1.3.0`, Apache-2.0, ESM-only, with a Zod peer dependency and no declared Node
engine. That is sufficient to keep it as the ACP candidate, but it is not yet a
VS Code extension-host compatibility proof. Before pinning it, Hydra must run
an isolated import/protocol smoke on the shipped VS Code Node version and
measure the lockfile and packaged VSIX footprint.

### Delivery is source-bound, ordered, and individually acknowledged

Each user action gets a random `steeringId`. The controller snapshots:

- direct user or separately confirmed external source;
- exact selected active `callId` and generation for every target;
- text hash and bounded character count;
- Mission Contract and effective authority hashes;
- request time and per-target sequence number; and
- expected delivery class.

The request records the user's intent separately from the provider result.
Initial intents are `steer` and `queue`; effective dispositions are
`acceptedCurrent`, `yieldedThenAccepted`, `queuedProvider`,
`queuedHydra`, `rejected`, or `deliveryUnknown`. This prevents a provider
downgrade from being mislabeled as the behavior the user requested.

Per-active-run requests are serialized. A later steer cannot overtake an
earlier one for the same call. A broadcast is a fan-out of independently
acknowledged target deliveries, not an atomic claim. Partial success is shown
explicitly. The registry is keyed by Hydra's unique call/trace ID, never only by
agent ID, because Many Heads may have several live workers with the same
canonical agent identity.

The same serialization queue owns completion. If completion closes acceptance
first, a concurrent steer is `missedWindow`. If the steer begins delivery
first, completion waits for that target's bounded acknowledgement path. A
stale or closed request is never redirected to a later phase leg or worker.

Before each provider write, the controller rechecks the active handle's
generation, provider turn/session binding, Mission Contract hash, and authority
hash. If the call ended or changed, the request becomes
`endedBeforeAcceptance`; Hydra offers `nextHydraTurn` but does not silently
retarget it.

Hydra does not automatically retry an acknowledgement timeout. The native
runtime may have accepted the message even if the acknowledgement was lost, so
an automatic retry could duplicate user intent. The target is marked
`deliveryUnknown`, and the user may explicitly retry or queue a clarified
message.

Every controlled run maintains:

```text
steeringChainSha256 =
  H(initialPromptSha256, ordered acknowledged steering message hashes)
```

Completion, usage, verification, claim, and Flight Recorder receipts bind that
chain. Any `deliveryUnknown` outcome marks the chain and downstream provenance
indeterminate instead of pretending the final result incorporated or ignored
the message.

Only the canonical final assistant segment after the last acknowledged steer
may supply a Decision Packet, approval sentinel, duel/claim control record, or
review convergence signal. Earlier streamed or intermediate segments remain
visible evidence but cannot close workflow state.

### Private state is authoritative; transcript and Markdown are inspectable

Steering affects dispatch, so authoritative delivery metadata lives in
workspace-specific private extension storage:

- `steering/events.v1.jsonl` - append-only, hash-bound request and per-target
  outcome events; and
- `steering/pending.v1.json` - an atomic, bounded snapshot containing message
  bodies only while delivery is unresolved.

The event ledger stores text hashes and lengths, not message bodies. A
successful, rejected, or user-resolved terminal outcome removes the body from
the pending snapshot through atomic replacement. Full replay fails closed on
unknown versions, invalid references, duplicate terminal outcomes, truncation,
or bounds violations.

The visible user steering message is durably appended to the room transcript
before provider delivery. `.hydra/steering.md` is a disposable redacted mirror
of delivery classes and outcomes. Neither the transcript nor the Markdown
mirror can forge a private delivery receipt.

Per-target events use explicit append-only states:

```text
accepted -> deliveryStarted ->
  acknowledged | sentUnconfirmed | missedWindow | unsupported |
  rejected | failed | deliveryUnknown
```

Terminal states are never edited or retried in place. A user retry receives a
new steering ID and a provenance link to the earlier outcome.

Flight Recorder receives metadata-only steering events by default: IDs,
hashes, targets, capability class, timing, and outcome. It receives message
content only under the separate bounded content-capture opt-in. A replay of a
steering trace is still a new consent- and cost-gated run.

### Steering cannot expand authority or rewrite locked contracts

A steering message is user input to an already-authorized run. It does not:

- change filesystem, terminal, network, browser, tool, or secret permissions;
- approve a pending native or browser action;
- amend the authoritative Mission Contract, protected paths, budgets,
  acceptance checks, or non-goals;
- change builder assignment, speaking order, convergence policy, standings, or
  duel authority; or
- bypass a provider or Hydra cost limit.

The currently registered authority and Mission Contract hashes remain the
enforcement boundary. If the user wants to change either, Hydra uses the
separate preview-and-confirm flow and starts or rebinds work as that flow
requires.

Only direct local-user sends enter `SteeringController` without a relay grant.
The Telegram steering foundation is separately opt-in and is stricter than the
legacy inbound-room path: a non-empty slash-command prefix, exact chat ID, and
a non-empty exact sender-ID allowlist are all mandatory. Telegram text cannot
select a run or supply Mission/authority metadata; the owner supplies those
bindings from its authenticated target advertisement. Native `@hydra`, MCP,
or other external mutations require an equivalent explicit grant. Agent-authored
text and web content can never create a steering request.

Steering consumes model work and counts against the active mission/session
budget. The UI shows that fact before delivery. Automatic follow-up generation
may propose a steer, but only a user-confirmed action can send one.

Steering does not reset or extend the active run timeout automatically.
Mission/session cost guards reserve additional headroom before a provider
write; an exhausted budget rejects the steer without cancelling the work
already in progress.

### Independent and sealed work is not steerable

Live steering is allowed for ordinary discussion, build, review, Mission Graph
tasks, and visible nested workers whose adapters expose handles.

It is disabled for:

- sealed Blind Review Jury findings before joint reveal;
- formal duel commitments and deterministic referee execution;
- hidden/headless wiki or maintenance calls;
- verification commands; and
- Arena contestants after the mission and base revision are locked.

Steering one Arena contestant would destroy identical-input comparability.
Steering all contestants would change the locked mission after dispatch. The
user can stop the Arena run or create a new run from an explicitly amended and
relocked Mission Contract; Hydra preserves the old receipts.

If an implementation ever allows an identical Arena broadcast, every
contestant must acknowledge the same ordered steering chain. A partial,
unknown, or unequal chain marks the comparison compromised and prevents winner
promotion from claiming identical inputs.

### Bounds and failure behavior

Initial limits are conservative and configurable only from application-scoped,
trust-restricted settings:

- 64 KiB UTF-8 per steering message;
- 32 unresolved messages per room;
- 8 unresolved messages per active run;
- 256 KiB total unresolved message content; and
- a short bounded provider acknowledgement timeout that does not cancel the
  active run when it expires.

Queue-full, stale-handle, unsupported, sealed-work, mission-hash mismatch,
authority-hash mismatch, provider rejection, acknowledgement timeout, and
process-exit outcomes are distinct machine-readable codes. None triggers an
interrupt or a fresh paid call automatically.

Stop Current Turn remains the explicit cancellation operation. Steering never
calls Stop as an implementation detail.

Only the extension host that owns the native provider handle may deliver to it.
`steeringRelayProtocol.ts` and `steeringRelay.ts` provide the cross-window
backend: owners publish short-lived exact target snapshots, sending windows
append HMAC-authenticated bounded envelopes to private extension storage, and
only the destination owner may claim and forward them. Per-producer sequence
IDs are monotonic and idempotent. A claimed message is never replayed after an
ambiguous crash; it becomes `deliveryUnknown`. The state and every envelope
are authenticated, queue/body/history cardinalities are bounded, and the key
is supplied from outside the relay rather than written to state or diagnostics.

`telegramSteering.ts` converts an already-polled, explicitly authorized update
into the same workspace/owner/turn/run/Mission/authority-bound envelope without
persisting the bot token, chat ID, or sender ID. The extension integration loads
one per-workspace relay key from VS Code SecretStorage under a non-secret
cross-process bootstrap lease, refreshes short-lived owner advertisements on
both a timer and native-handle lifecycle changes, and pumps exact-owner claims
into `SteeringController`. Telegram steering runs only after the existing
bot/chat/bot-author/sender and durable room-routing boundary; it additionally
requires a separate opt-in, slash prefix, and non-empty sender-ID allowlist.
Real Telegram Bot API credentials remain an external operator prerequisite,
not a permission that the transport infers.

## Consequences

### Positive

- The user can redirect active Codex work and feed follow-ups into live Claude
  and compatible agent sessions without killing the process.
- Hydra exposes provider differences instead of promising false parity.
- A single controller supports N heads, nested visible workers, future native
  adapters, and ACP without provider branches in `panel.ts`.
- Source, target, authority, mission, ordering, and acknowledgement are
  auditable and available to Flight Recorder.
- Existing one-shot and Terminal Bridge transports remain valid fallbacks.

### Negative

- Codex app-server and Claude streaming sessions add persistent-process
  lifecycle, backpressure, parsing, cost-accounting, and crash-recovery work.
- Claude and stable ACP v1 initially provide next-provider-turn delivery rather
  than Codex-equivalent same-turn injection.
- Some configured CLI arguments cannot be mapped safely to a persistent
  transport, so those heads remain queue-only until an adapter supports them.
- Streaming transcript presentation needs first-class steering messages and
  continuation bubbles rather than treating one pending bubble as immutable.

## Alternatives considered

- Keep the existing Hydra room queue only: safe but does not let the user
  influence the active session and can unnecessarily re-run the full room.
- Write keystrokes or raw lines into visible terminals: timing-dependent,
  unacknowledged, not source-bound, and unsafe across shells and CLI modes.
- Interrupt and resume every head with the new message: changes semantics,
  discards in-flight work, and directly violates the non-interruption
  requirement.
- Require every agent to poll a Hydra MCP mailbox: useful as an advisory
  extension, but it cannot guarantee when a model or tool loop will poll and
  therefore cannot be called live steering.
- Adopt ACP v2 immediately: its prompt lifecycle is draft, while the product
  requirement explicitly keeps the core ACP adapter on stable v1.

## Implementation order

1. Land pure steering schemas, replay validation, private pending state, and a
   fake controllable-agent harness.
2. Add `SteeringController` and active-run registration without changing the
   room phase reducer.
3. Add Codex app-server with invocation-parity checks and true `sameTurn`
   steering.
4. Add Claude stream-json sessions with FIFO replay acknowledgements and
   `sameSessionNextTurn` labeling.
5. Add the composer target/delivery UI, transcript records, continuation
   bubbles, and explicit queue alternative.
6. Add stable ACP v1 session delivery and Agent Lab capability previews.
7. Feed steering metadata into Flight Recorder and expose confirmed steering
   through `@hydra` and scoped-token MCP adapters.

VS Code's built-in chat UI distinguishes Queue, Steer, and Stop and Send.
`@hydra` routes each new request through the same controller and returns the
effective Hydra disposition. The public Chat Participant callback and
cancellation token do not themselves prove that a selected native provider
accepted same-turn input.

The first two steps belong with Mission Contract and Flight Recorder
foundations, before Arena or sealed convergence features rely on active-run
semantics. Shared edits to `panel.ts`, `package.json`, `media/webview.js`,
`src/webview.html.ts`, `src/webviewMessages.ts`, and `src/doctor.ts` remain
single-owner integration work.

Any setting that selects a persistent spawn, endpoint, environment, or
automatic delivery behavior must have `scope: "application"`, appear in
`capabilities.untrustedWorkspaces.restrictedConfigurations`, and be checked by
Doctor.

## Validation

### Pure and adversarial tests

- strict schema, size, source, target, hash, and event-reference validation;
- complete fail-closed replay, duplicate IDs, torn records, unknown versions,
  and bounded pending-state recovery;
- per-active-run FIFO ordering and independent broadcast outcomes;
- stale call-generation and active-turn races;
- acknowledgement loss producing `deliveryUnknown` without retry;
- mission/authority changes rejecting delivery;
- owner-lease loss and second-window delivery rejection;
- steering-chain binding on completion, usage, verification, claims, and
  convergence controls;
- multiple Claude result envelopes aggregating rather than overwriting usage
  or text;
- sealed Jury, duel, referee, verification, and Arena targets rejecting
  steering; and
- no steering outcome changing phase state or authority.

### Provider contract tests

- generate the installed Codex app-server schema and pin the required
  `threadId`, `expectedTurnId`, input, and returned `turnId` shape;
- fake app-server tests for start, steer, completion, overload, stale turn,
  malformed response, process exit, and bounded queues;
- fake Claude stream-json tests for open stdin, FIFO user-message replay,
  multiple provider results, malformed JSONL, backpressure, and clean close;
- ACP v1 conformance tests proving Hydra waits for the safe prompt boundary and
  never infers concurrent steering; and
- capability downgrade tests for unmappable flags and version/schema changes.

### Extension-host and manual tests

- steer one serial head and all heads in a parallel turn;
- mix per-head `sameTurn`, `sameSessionNextTurn`, and `nextHydraTurn` outcomes;
- send at the exact completion boundary and confirm no silent retargeting;
- reload/crash with unresolved delivery and confirm no automatic duplicate;
- revoke authority or change the Mission Contract before provider write;
- stop an active steered turn and confirm one cancellation path;
- verify cross-window ledger refresh and redacted Flight Recorder output; and
- run paid/native smoke tests only after explicit user confirmation, with a
  bounded cost cap.

## Rollout and rollback

Roll out behind a session-visible capability gate. Start with fake transports,
then Codex, then Claude, then ACP. A head is steering-enabled only after its
runtime probe and invocation-parity check pass.

Rollback disables new live-control registration and restores the current
composer `QUEUE` behavior. Existing one-shot calls, phase transitions, and
room queues remain untouched. Preserve the private event ledger for audit;
clear only resolved pending message bodies through the normal compaction path.

## Source anchors

- Codex steering and app-server lifecycle:
  https://developers.openai.com/codex/app-server
- Codex CLI steering and queueing:
  https://developers.openai.com/codex/cli/features
- Claude Code CLI stream-json input and queued-message behavior:
  https://code.claude.com/docs/en/cli-usage
- Claude Agent SDK streaming input and queued messages:
  https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- VS Code Queue, Steer, and Stop and Send semantics:
  https://code.visualstudio.com/docs/chat/chat-overview#_send-messages-while-a-request-is-running
- ACP architecture and stable v1 session model:
  https://agentclientprotocol.com/get-started/architecture
- Official ACP TypeScript SDK:
  https://agentclientprotocol.com/libraries/typescript
- ACP v2 draft prompt lifecycle and its unresolved queueing semantics:
  https://agentclientprotocol.com/rfds/v2/prompt
