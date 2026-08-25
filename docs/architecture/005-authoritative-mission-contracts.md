# ADR 005: Private, explicitly confirmed Mission Contracts

- Status: Accepted; implemented
- Date: 2026-07-24
- Owners: Hydra maintainers

## Context

Hydra's pinned objective is useful conversational context, but it is an
editable workspace Markdown file. It cannot safely authorize dispatch,
comparison, replay, promotion, or automatic task execution. The next platform
features need one versioned mission definition that binds the requested
outcome, allowed work, acceptance evidence, and budgets without letting an
agent or workspace edit expand authority.

The contract must coexist with existing rooms while the new surfaces roll out.
An absent contract therefore has an explicit hash-bound `unbound` state; it is
never inferred from the objective, transcript, agent prose, or a Markdown
mirror.

## Decision

### Contract document

Hydra normalizes an exact-schema `MissionContractDocument` containing:

- a bounded title and outcome;
- ordered acceptance checks of kind `verificationCommand`, `artifact`,
  `browserJourney`, or `manual`;
- protected workspace-relative path scopes;
- allowed mutation rules with explicit create, modify, delete, and rename
  operations;
- nullable cost, call-count, wall-clock, and retry budgets;
- ordered evidence requirements; and
- explicit non-goals.

Paths use normalized POSIX-style workspace-relative syntax. Absolute paths,
parent traversal, empty segments, `.git`, and `.hydra` are invalid. Protected
paths always win. An unmatched mutation is disallowed, and a rename requires
both source and destination to pass. A contract only narrows the separately
configured native authority; it never grants filesystem, terminal, network,
browser, secret, approval, publish, or deployment permission.

The document hash is SHA-256 over `hydra-mission-contract-v1`, one NUL byte,
and UTF-8 canonical JSON with fixed keys. Text is normalized to NFC and
rejects NUL, controls, and bidirectional formatting characters. Numbers
reject non-finite values, negative zero, and unsafe integers. Meaningful
acceptance and evidence order is preserved; set-like mutation operations are
normalized, deduplicated, and sorted. A published golden vector pins the
exact bytes and digest.

Document identity and active authority identity are distinct. Every
confirmation derives an active-binding digest over the mission ID, revision,
confirmation event ID, and document hash. The explicit unbound state has its
own binding digest. Runtime freshness compares this active-binding digest, not
only document bytes, so an identical-document amendment or a retired mission
re-created with identical text still invalidates an older turn.

### Proposal and activation protocol

The append-only event stream has four event types:

1. `missionContractProposed` stores the normalized document, its hash, the
   mission/proposal IDs, exact active-base hash, and source binding.
2. `missionContractConfirmed` activates one unresolved exact proposal.
3. `missionContractProposalDismissed` closes a proposal without authority
   effect.
4. `missionContractRetired` retires the exact active hash and returns to the
   unbound sentinel without deleting history.

Only a local-user confirmation event may activate or retire a contract. The
host displays the complete proposal, hash, source, budgets, commands, path
rules, evidence, and non-goals in a modal, then requires the exact
`Confirm Mission Contract` action. Confirmation references the exact proposal,
document hash, and derived binding only; it does not duplicate mutable command
text and does not execute any acceptance command.

Agents may emit one strict, column-zero proposal control record from a
successful eligible top-level room reply. Hydra supplies the real agent,
call, message, and response-hash binding. Quoted, fenced, indented, nested,
maintenance, verifier, Arena, Jury, duel, or referee output cannot propose.
Parsing produces only a bounded ephemeral candidate: agent output is never
appended directly to the permanent authoritative ledger. The host first shows
the complete candidate and requires an explicit local-user
`Admit Mission Proposal` action. Only that admission creates a
`missionContractProposed` event carrying both the agent source binding and the
local admission evidence. Activation still requires the separate exact
`Confirm Mission Contract` action. This two-step boundary prevents an
agent-output flood from exhausting the permanent ledger or blocking a local
confirm/retire operation. No agent-authored record can admit, confirm, dismiss,
retire, or amend authority.

### Authoritative storage and concurrency

The authoritative ledger is private workspace-specific extension state:

```text
<storageUri>/mission/contract-events.v1.jsonl
```

The human-readable `.hydra/mission.md` file is a disposable one-way mirror.
It contains only the active confirmed contract plus safe pending proposal
counts/opaque IDs, never full unconfirmed agent proposals or their source
bindings. Hydra never reads it into authority or prompt context.

Every mutation runs under one cross-process critical section:

1. reload the complete bounded ledger;
2. fail closed on a torn, malformed, oversized, unknown, duplicate, or
   invalidly referenced record;
3. replay the current active hash and proposal state;
4. compare the caller's expected base/proposal/hash;
5. validate the complete candidate history; and
6. append the new event.

This compare-and-append sequence prevents two VS Code windows from confirming
stale proposals against the same base. Initial activation is revision 1.
Amendments keep the mission ID and increment exactly once. A stale proposal
cannot be confirmed after another activation. Corruption blocks new bound
dispatch; it never silently degrades to unbound.

Outstanding durable proposals and total ledger size are bounded. Because only
an explicit local action can admit a proposal, untrusted agent output cannot
consume those bounds. Confirmation, dismissal, and retirement retain reserved
append capacity so an already-admitted proposal cannot wedge its own
resolution or prevent the user from returning to the unbound state.
The protocol pins UTF-8 byte limits for documents, records, files, event
counts, and outstanding proposals. New admissions stop before consuming the
space reserved for one terminal action per admitted proposal and retirement
of an active contract.

### Runtime binding

Hydra latches one immutable `MissionContractBinding` for a room turn and
records its mission ID, revision, document hash, and active-binding hash in
prompts, calls, steering, traces, verification, and usage provenance. Direct
native actions, Wiki wrapup, and duel calls refresh and freeze their own
binding instead of borrowing mutable room-turn state.

Every irreversible provider submission uses a branded short-write gate under
the same cross-process contract lock used by mutation. The gate strictly
reloads the ledger, compares the full frozen binding, then holds the lease only
through the actual spawn, HTTP fetch initiation, terminal `sendText`, Codex
`turn/start` or `turn/steer` JSON-RPC write, Claude initial or steering stdin
write, or durable Hydra queue append. It never waits for model completion or
provider acknowledgement. Stop, interrupt, process teardown, stdin close, and
cleanup are never gated. Corruption or read failure rejects admission before
any provider bytes are written. A cross-window amendment therefore either
linearizes after the admitted write or stops the stale write.

Steering cannot amend a contract. `SteeringController` passes the exact frozen
binding's short-write gate into provider handles; Claude applies it after FIFO
queueing at the real stdin write rather than at queue admission. A rejected
steering gate is a known zero-write `missionHashMismatch` and cannot fail or
interrupt an otherwise healthy provider session.

For compatibility, ordinary discussion and legacy room Build may use the
explicit unbound sentinel; those paths still record it rather than claiming
contract coverage. Arena, Mission Graph automatic dispatch, Replay, and other
contract-dependent features require an active confirmed contract. The
proposal/confirmation UI and Mission recovery smoke are implemented, but they
do not reinterpret an explicitly unbound legacy call as Mission-bound work.

Rollback or temporarily unavailable Mission UI never reinterprets an active or
invalid ledger as unbound. If strict replay or the enforcement controller is
unavailable, write-capable dispatch fails closed. Discussion may use unbound
only when strict replay proves the ledger genuinely empty or explicitly
retired. The mirror never activates a contract.

## Consequences

### Positive

- Mission scope changes are explicit, hash-bound, reviewable, and reversible.
- Workspace agents and Markdown edits cannot authorize work.
- Arena, Mission Graph, steering, replay, verification, and evidence can share
  one exact mission identity.
- Cross-window races fail closed instead of producing split-brain revisions.

### Negative

- A private authoritative ledger plus public mirror creates two storage
  surfaces.
- Users must confirm amendments explicitly, including seemingly small ones.
- Contract enforcement can stop a multi-head turn after an amendment; Hydra
  must surface the stale-binding reason clearly.

## Alternatives considered

- Treat `.hydra/objective.md` as the contract: rejected because it is advisory,
  workspace-writable, unversioned, and lacks structured safety boundaries.
- Let the first agent draft activate automatically: rejected because
  agent-authored input is untrusted and cannot grant authority.
- Store only the latest contract snapshot: rejected because it loses proposal,
  correction, retirement, and concurrency provenance.
- Put the authoritative ledger in `.hydra`: rejected because the same
  workspace processes governed by the contract can edit it.

## Validation and rollout

Validation covers canonical hash sensitivity, exact-key and bound checks,
unsafe paths, protected-path precedence, rename source/destination checks,
budget limits, proposal-only agent input, activation/amendment/retirement
replay, torn and oversized files, stale-base races, concurrent confirmations,
cross-window refresh, mirror non-authority, prompt/call/steering/trace hash
equality, contract changes during turns and steering delivery, and agent
proposal floods proving that untrusted output cannot consume authoritative
ledger or confirm/retire capacity.

Canonicalization tests cover key insertion order, CRLF/backslash paths,
composed/decomposed Unicode, ordered versus set fields, negative zero,
exponent forms, unsafe integers, and caller mutation after normalization.
Windows path tests reject case-insensitive `.git`/`.hydra`, traversal with
either separator, drives, UNC and ADS colons, dot/empty segments, trailing
dot/space aliases, controls, and reserved device names. Rename checks both
ends independently, protected paths always win, and lexical authorization is
never treated as proof that a symlink-resolved target remains in scope.
Concurrency tests race confirmation against dispatch admission in both
orders, prove the lease is released while provider completion remains pending,
and prove Stop while waiting performs zero provider writes. Transport tests
pin zero-write rejection at spawn/fetch/terminal/Codex/Claude boundaries.
Identical-document revisions and re-created missions reject old bindings;
corruption between legs blocks rather than becoming unbound.

Roll out pure schema/replay first, then private storage/controller, then the
modal and mirror, then runtime latching. Contract-dependent new features stay
disabled when the binding is unbound or invalid. Rollback hides new controls
and disables bound dispatch while preserving the private history. Never
reconstruct authority from the mirror during rollback.

### Current implementation

The foundation now opens and strictly replays the private Mission controller
before Flight Recorder and steering initialization. Each room turn, direct
native action, Wiki wrapup, and duel commitment refreshes and freezes its own
binding. The frozen human-readable contract terms are rendered into every
autonomous prompt, including Wiki and duel prompts, while prompt provenance
retains both document and active-binding hashes.

The branded short-write gate is wired at the exact one-shot spawn, HTTP
request, Terminal Bridge dispatch/raw-line, Codex `turn/start` and
`turn/steer`, Claude initial/steering stdin, and durable Hydra queue-write
boundaries. Mission rejection remains a known pre-submission validation
outcome; it is not reclassified as provider failure and cannot trigger a
fallback retry. A failed or corrupt Mission controller blocks bound dispatch
instead of silently becoming unbound.
