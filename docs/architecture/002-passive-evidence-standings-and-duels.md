# ADR 002: Keep evidence standings, duel ratings, and authority separate

- Status: Accepted
- Date: 2026-07-14
- Amended: 2026-07-15
- Owners: Hydra maintainers

## Context

Hydra rooms can seat more than two heads. Stable N-head identity must exist before reputation can be meaningful: a score belongs to a durable agent identifier, not to a mutable display name, provider slot, or the binary assumption that every room contains only Codex and Claude.

The experiment benefits from remembering which heads made claims that later held up. That feedback can reward careful reasoning, expose domain strengths, and make discussions more competitive. It also creates a dangerous shortcut if a score is allowed to become filesystem access, terminal access, approval power, speaking priority, builder assignment, or permission to bypass a human decision. A head can be historically accurate without being safe to authorize, and peer agreement is not independent evidence.

Hydra therefore needs three concepts with different evidence and trust models:

1. passive reliability standings derived from adjudicated real-room claims;
2. a competitive rating derived only from formal duels that a head initiates from an observed disagreement; and
3. native permissions and orchestration authority assigned by policy and the user.

## Decision

### Identity first

Standings use Hydra's canonical agent IDs as their keys. Display names are presentation only. New scoring or duel features must not reintroduce two-head complements, provider-specific identity, or positional identity such as "the other head." A claim is associated with an explicit head, round, and domain.

### Passive evidence ledger

The source of truth is an append-only event ledger with three event kinds:

- `claimRegistered` records a falsifiable statement, claimant, round, domain, and optional self-assessed confidence;
- `verdictRecorded` records an outcome, evidence source, adjudicator, durable evidence reference, and required rationale for a registered claim; and
- `verdictReversed` records an actor and reason, then invalidates a prior verdict without editing or deleting history, after which a replacement verdict may be appended.

Only claims that could be shown wrong are eligible for correctness scoring. Opinions, preferences, rhetorical quality, consensus, and unfalsifiable predictions may remain in discussion but should be marked void or unresolved rather than converted into points. Claimant confidence is retained for future calibration analysis and does not increase the score.

Verdict sources have explicit weights:

- deterministic verification has weight `1.0`;
- human adjudication has weight `0.75`; and
- peer assessment has weight `0` and is advisory only.

The interactive recorder may label evidence deterministic only when it generates the scored claim directly from Hydra's latest passing verification receipt, including its command, timestamp, Git HEAD when available, and a content hash. A free-form claim cannot borrow an unrelated green verification. Human and peer verdicts receive explicit actor/time references. Every verdict requires a non-empty evidence note; selecting a stronger label without provenance is not enough.

A head cannot adjudicate its own claim as a peer. Peer critiques remain visible because they can sharpen the discussion, but a group of heads cannot vote itself or another head upward. Correct, partial, and incorrect outcomes affect weighted accuracy only when backed by deterministic or human evidence. Unresolved and void outcomes remain auditable but do not affect the score.

Standings are computed by replaying the complete ledger, both overall and by domain. Correlated claims from one head/domain/round are combined and contribute at most one unit of evidence; splitting one prediction into five claims cannot manufacture maturity. Overall aggregation applies the same cap across every domain in a round. A standing remains provisional until it has at least five distinct independently resolved rounds. This threshold is evidence maturity, not proof of general competence.

The displayed score is a one-standard-deviation Wilson lower confidence bound over source-weighted correctness. This deliberately penalizes losses during the provisional period and stops one lucky correct claim from looking equivalent to an established record. Raw weighted accuracy and evidence maturity remain visible beside the score.

### Storage and inspection boundary

The authoritative ledger lives in workspace-specific private extension storage at `competition/score-events.jsonl`. It is validated by full replay and fails closed on malformed, truncated, oversized, duplicate, or invalidly referenced events. Workspace agents must not be able to improve their standing by editing a repository file.

Hydra derives `.hydra/scoreboard.md` from the private ledger for human inspection and `.hydra/score-evidence.md` as a readable audit of active claims, pending replacement adjudications, and the complete actor-attributed reversal history. Both Markdown files are disposable mirrors, never inputs to aggregation. They may be regenerated or deleted without changing history. Failure to write a mirror is reported separately and never hides a valid ledger or tells the user that an already-appended verdict failed.

### No authority transfer in this release

Passive standings do not change:

- native action permissions or trust boundaries;
- filesystem, terminal, network, or secret access;
- approval, review-convergence, or safety decisions;
- builder assignment, speaking order, context allocation, or orchestration priority; or
- the ability to adjudicate claims or modify the authoritative ledger.

The user and existing safety policies retain those powers. Any future experiment that lets evidence influence orchestration requires a separate ADR, explicit opt-in, bounded influence, and a rollback path. Reliability alone will never grant security authority.

### Formal duel system (Elo v3 agent initiated)

Duels use a separate private event stream and a separate domain-specific rating. The current `elo-v3-agent-initiated` policy starts every head at 1000 in each domain and uses K=24 for decisive matches. Ratings, records, and corrections are derived by replay; they never reuse passive reliability as a starting rating or permission level. Existing rated policies remain replayable audit history but neither affect current Elo nor constrain v3 anti-farming admission; legacy exhibition/operator events remain immutable unranked history. No v3 code path creates an exhibition.

A valid current duel must satisfy all of these rules:

1. Only a successful serial reactor or closer reply may initiate a challenge. The head emits Hydra's strict challenge control record immediately before its Decision Packet and names the head whose reply it just examined. Hydra binds the challenger from the actual reply role and the opponent/source from the current turn; a human prompt, free-form disagreement, forged opponent ID, stale message, opener reply, quoted marker, or parallel reply cannot create a duel.
2. The challenge fixes one falsifiable proposition, named domain, evidence contract, and rationale. Hydra removes the control record from the visible reply and builds the bounded shared evidence packet itself from the current user request, disputed head reply, proposition, contract, and rationale. The model cannot choose arbitrary evidence files or import the opponent's sealed answer.
3. Hydra policy admits or rejects the challenge atomically. Unsupported or unequal full-native profiles, missing persistent consent, session cost limits, malformed evidence, repeated propositions, reciprocal farming, another unresolved autonomous duel for either head, a 60-minute per-head initiation cooldown, or more than three initiations per head in 24 hours reject the challenge before commitments. Rejection is explicit, auditable, changes no Elo, and never becomes an exhibition. There is no challenged-head acceptance ceremony and no human Create Duel action.
4. Every answer and confidence value is generated by a private dispatch to the actual configured head under `hydra-duel-full-native-v1`. Before admission, Hydra applies the same maximum-permission preflight to both configured heads and requires each to resolve to a supported local full-native spawn. Codex uses ephemeral `danger-full-access`; Claude uses unrestricted nonpersistent execution. Known configured model, profile, feature, MCP, plugin, browser/IDE, settings, agent, and extra-directory capability flags carry into the forced full-native launch; Hydra replaces restrictive authority, output, persistence, prompt, and working-directory controls. Hydra locks each participant's effective command, model, arguments, working directory, and environment digest at admission and verifies the lock again before dispatch; the digest binds the effective environment without persisting raw values. Each head retains its configured native integration surface, but vendor tool names, catalogs, and implementations can differ. Parity means equal maximum Hydra-granted permissions, not identical tools, provider capabilities, or provider attestation.
5. Autonomous commitments require prior persistent full-native consent for both participants. The background path never opens a consent modal or falls back to a manual/operator-authored answer. If authorization is absent or ceases to be valid, Hydra rejects or stops the duel and reports the reason.
6. Both heads receive the same bounded evidence starting brief, quoted as untrusted data. It is not a closed-book limit: participants may independently inspect the workspace, run verification, browse, and use configured integrations. The shared project workspace is read-only by duel contract even though the native runtime retains maximum authority: participants must not modify, create, delete, or rename project content and must put disposable verification artifacts in the operating-system temp directory. At admission, Hydra fingerprints bounded project content and entry metadata outside `.git` and Hydra-owned `.hydra`, rechecks that state before and after commitments, and runs a live mutation monitor over the same project boundary. A detected mutation, watcher failure, or unverifiable state automatically cancels the duel with no Elo. This guard detects ordinary project-evidence mutation; it is not an absolute defense against a malicious process with the same OS-user authority. Participants must not ask another head for its answer, seek the sealed opponent payload, or optimize Elo above truth, safety, and the user's objective.
7. Hydra automatically dispatches both commitments when the room is idle. Every participant commits before seeing the opponent commitment. Hydra appends only a SHA-256 seal and execution provenance to the private duel ledger, keeps the unrevealed payload in VS Code SecretStorage, and appends both payloads together in one reveal event. A private cleanup index makes crashes and terminal cleanup recoverable. Missing or mismatched secrets fail closed and can only be cancelled by the operator.
8. The human evidence contract and identified local adjudicator are fixed before commitments. After the paired reveal, the human evaluates the falsifiable proposition and evidence—not style, popularity, verbosity, or later revisions—and cites a durable artifact, HTTPS URL, or command/receipt reference. Human duel actions are limited to adjudicating, cancelling, or appending a correction; the human never initiates the duel or supplies a participant commitment. Peer vote never decides the result. Deterministic adjudication remains reserved until an authoritative machine mapping and duel-bound receipt exist.
9. The strict commitment response echoes duel, participant, and commitment identifiers. Hydra binds the initiation source, admission-time workspace fingerprint, capability policy and participant lock, effective invocation, prompt, response, timing, transport, configured head metadata, and exact evidence SHA-256 into the execution receipt before sealing. V3 replay rejects missing or mismatched challenge, capability, workspace, evidence, or head bindings and rejects HTTP-only or operator-authored commitments because they did not run the local full-access profile.
10. A decisive rated result updates only that domain. Winner and loser deltas are equal and opposite. A tie records a rated draw with exactly zero rating delta even when ratings differ. Void, unresolved, rejected, cancelled, and legacy-unranked matches produce no rating change.
11. Domain rank is motivational only. Lower-ranked heads receive their exact gap to #1 and are pressed to verify more, expose assumptions, and make sharper falsifiable predictions. A provisional #1 must mature the lead; after five rated matches, the Supreme Head receives equal pressure to defend it. Elo never grants native permissions, approval rights, safety authority, builder assignment, speaking order, context allocation, or orchestration priority.

Hydra writes a redacted binding record to `.hydra/agent-calls.jsonl` before sealing. The private execution path does not enter the room transcript, prompt envelopes, pending bubbles, live channel, stderr preview, or agent stream summary. The receipt proves that Hydra observed the strict control record in a bound agent reply, locked the configured effective spawn, and dispatched the configured heads; it does not prove provider identity, independent subjective intent, identical vendor tools, equal hidden server state, or resistance to a malicious same-user full-native process. The workspace mutation monitor and SecretStorage are application integrity controls, not host security boundaries.

## Alternatives considered

- Let heads score one another: fast and lively, but creates collusion, retaliation, popularity contests, and self-reinforcing authority. Peer assessments are retained with zero score weight instead.
- Use user reactions or review approvals as correctness: easy to collect, but those signals mix preference, task ownership, and safety policy with factual accuracy.
- Maintain one universal supremacy score: simple to display, but collapses domain expertise, formal competition, and permission into a misleading number.
- Let the current leader choose builders or speak first: immediately creates feedback loops before the evidence model has been validated and turns a passive experiment into an authority mechanism.
- Let the human create or script a duel: operationally simple, but defeats the experiment's test of whether a head recognizes a falsifiable disagreement worth contesting. Human involvement begins at independent adjudication instead.
- Let any reply or free-form phrase initiate: lively, but easy to trigger accidentally or forge from quoted/untrusted content. Initiation is limited to a strict source-bound reactor/closer control record.
- Ask the challenged head to accept: adds theater without stronger evidence and can stall the room. Hydra's published admission policy accepts or rejects before either sealed commitment runs.
- Store the authoritative ledger in `.hydra/`: portable and inspectable, but writable by the same workspace processes whose performance it measures.
- Correct verdicts in place: compact, but destroys provenance and makes disputes or recovery difficult to audit.

## Consequences

- Hydra can show who has accumulated evidence-backed correctness without changing how safely the room operates.
- Domain standings can reveal real specialization while the overall standing remains a compact summary.
- Early standings are visibly provisional, and peer debate cannot manufacture maturity.
- Reversals preserve provenance and permit correction without rewriting history.
- The private ledger and derived mirror introduce two storage surfaces, but only one is authoritative.
- Agent-initiated duels can emerge from ordinary critique without a human staging the contest, while strict source binding and policy admission keep that autonomy attributable and bounded.
- Automatic commitments consume two full-native model calls and therefore require persistent consent, cost headroom, an idle room, and explicit rate limits.
- Humans still carry the adjudication burden because factual correctness cannot be inferred safely from rhetorical quality or peer consensus.
- A head may lead reliability while another leads one duel domain, and neither fact implies additional permissions. Hydra does not collapse domain ratings into a universal supremacy score.

## Rollout and rollback

Roll out in stages:

1. finish durable N-head identity and roster handling;
2. collect claim and verdict events while standings remain passive;
3. inspect provisional thresholds, source weighting, reversals, and domain labels using real rounds;
4. expose standings and their evidence trail without using them in orchestration; and
5. enable source-bound reactor/closer challenge intent, policy admission, automatic isolated head-generated commitments, Hydra-bound execution receipts, sealed paired reveal, human adjudication, replayed domain Elo, anti-farming reservations, correction events, orphan-secret recovery, and a separate audit surface.

Validation covers event-shape and reference checks, required evidence provenance, actor-attributed append-only reversal semantics, active-evidence inspection, peer weight zero, source weighting, per-round evidence caps, Wilson small-sample behavior, and the five-round provisional boundary. Duel coverage includes strict reactor/closer marker parsing, quote/fence and forged-opponent rejection, source-turn binding, host-built evidence bounds, atomic challenge/admission appends, no human creation surface, no exhibition fallback, persistent-consent and equal-capability preflight rejection, exact command/model/args/cwd/environment-digest locking, bounded project-content and entry-metadata fingerprinting, live mutation monitoring and cancellation, one-active-duel/cooldown/daily-cap enforcement, automatic two-head sealing, successful-cycle paired reveal, strict head-response identity binding, execution-receipt hashing, redacted call tracing, cancellation and orphan-secret cleanup races, Elo replay and zero-sum deltas, exact-zero ties, concurrent append serialization, fail-closed ledger loading, and one-way Markdown generation. UI and contract tests must keep agent initiation, human adjudication, equal maximum granted permissions without catalog-identity claims, read-only project integrity and its same-user limitation, no-authority warnings, and the receipt limitation visible.

Rollback disables recording and hides the standings and duel surfaces while preserving both private event ledgers for audit. Derived Markdown mirrors can be removed and regenerated. Unrevealed SecretStorage payloads may be deleted after the corresponding duel is cancelled. Do not reinterpret existing score or duel events as permissions, delete disputed events, or merge passive and duel histories during rollback. If a scoring or rating formula changes later, version the aggregation policy or rebuild the derived view from the original events; never rewrite the evidence history.
