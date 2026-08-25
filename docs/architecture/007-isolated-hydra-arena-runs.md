# ADR 007: Isolated, evidence-bound Hydra Arena runs

- Status: Accepted; isolated core and operator workflows implemented, production native admission gated
- Date: 2026-07-24
- Owners: Hydra maintainers

## Context

Hydra Arena compares two or more selected heads on one locked mission and one
base revision. A useful comparison needs stronger attribution than ordinary
parallel Build:

- every contestant must start from the same Git object and receive the same
  locked mission payload, verification plan, and optional browser journeys;
- one contestant must not observe another contestant's edits;
- main-workspace changes, missing evidence, or unequal controls must remain
  visible and must not be repaired into a claim of comparability;
- patches and receipts must survive cleanup; and
- selecting or promoting a winner must remain a local-user decision and must
  not merge, commit, push, publish, deploy, or transfer authority.

Git linked worktrees provide separate indexes and working directories while
sharing repository objects and refs. They are therefore useful for attribution,
rollback, and disposable execution, but they are not an operating-system
security boundary. A same-user native process can leave its assigned worktree,
modify the source workspace, mutate shared Git state, use credentials, or
access other local resources permitted by its effective authority.

Windows cleanup adds another integrity boundary. Agent descendants, language
servers, antivirus, or editor processes may retain handles after a contestant
finishes. Recursive deletion against an unchecked path, broad
`git worktree prune`, or cleanup before patch capture could lose evidence or
affect an unrelated worktree.

## Decision

### Admission locks one exact Arena contract

Arena MVP admits a run only when all of these preconditions hold:

1. VS Code trusts the workspace.
2. The workspace is the repository's main, non-bare Git worktree.
3. `HEAD` resolves to one commit object and Git reports no staged, tracked,
   deleted, renamed, or untracked workspace changes.
4. No merge, rebase, cherry-pick, revert, bisect, or other sequencer operation
   is active.
5. Sparse checkout, submodules, unmerged index stages, `skip-worktree`, and
   `assume-unchanged` index entries are absent. Repository-local filters,
   `include`/`includeIf` directives, prunable or duplicate worktree rows, and
   active Git lock files are also rejected. They remain unsupported in the MVP
   because they make clean-state and candidate-content equivalence ambiguous or
   can execute helpers during an otherwise administrative Git operation.
6. Hydra can resolve one trusted absolute Git executable.
7. An active confirmed Mission Contract authorizes the requested mutations and
   acceptance evidence.
8. At least two distinct supported local heads pass capability, authority,
   authentication, and cost preflight. The initial UI may cap the selection at
   eight even though the manifest is N-head shaped.
9. The local user confirms the exact Arena preview.

Admission is serialized by a canonical digest of the Git common-directory
identity, not only by VS Code workspace storage. Only one active Arena run may
own a repository at a time, including when two VS Code windows opened the same
repository through different paths.

The preview and `arenaRunLocked` event bind:

- the Mission Contract mission ID, revision, document hash, and active-binding
  hash;
- the Git object format, exact base commit, canonical base-content hash,
  repository identity, source workspace fingerprint, and shared Git ref/config
  control hash;
- the ordered contestant IDs, canonical head IDs, head-configuration hashes,
  authority hashes, invocation-plan hashes, and private worktree IDs;
- one content-free input-bundle hash shared by every contestant;
- a nullable, separately confirmed preparation-plan hash shared by every
  contestant; no contestant may hydrate dependencies through an unrecorded
  private preparation path;
- the ordered verification check IDs and plan hashes;
- the ordered optional browser-journey IDs and plan hashes;
- the environment-policy hash, budgets, and local confirmation ID; and
- steering policy `disabled`.

Every `arenaContestantStarted` receipt repeats and replay-validates the locked
input-bundle, environment-policy, budget, invocation, authority, and prepared
state hashes. Provider-specific prompt/context hashes are additional
attribution; they cannot replace those shared semantic and cost controls.

The semantic mission payload and acceptance controls are identical. Provider
wrappers, model implementations, effective invocations, hidden provider state,
timing, and operating-system scheduling can differ and are recorded rather
than presented as identical. Arena is comparative evidence, not proof of a
controlled scientific experiment or deterministic reproduction.

Any Mission Contract amendment, base change, source-workspace mutation,
authority change, invocation-plan change, or acceptance-plan change after the
lock rejects an undispatched contestant and compromises already-dispatched
comparison. Hydra never silently refreshes a locked run.

### Private per-run authority and separate retained evidence

Authoritative Arena state lives beneath workspace-specific private extension
storage:

```text
<storageUri>/arena/runs/<runId>/manifest.v1.jsonl
<storageUri>/arena/runs/<runId>/manifest.v1.segments/NNNNNNNN.jsonl
<storageUri>/arena/artifacts/<runId>/<contestantId>/...
<globalStorageUri>/as/<workspaceHash>/arena/worktrees/p/<opaque128>/...
<storageUri>/arena/registrations/<runId>/<contestantId>/intent.v1.json
<storageUri>/arena/registrations/<runId>/<contestantId>/receipt.v1.json
```

Run manifests and retained artifacts are physically separate from disposable
worktrees so worktree cleanup cannot erase patches or receipts.
`.hydra/arena.md` is a bounded, redacted, disposable comparison mirror and is
never an input to replay, promotion, Jury, or cleanup.

The event schema remains the append-only, domain-separated v1 SHA-256 chain.
Its physical storage uses a downgrade-safe v2 layout marker in
`manifest.v1.jsonl`, followed by the first v1 event, with every later event in
an immutable, sequence-named segment. Older readers therefore reject a new
run instead of silently replaying only its base event. A legacy single-file v1
manifest is migrated atomically once before its next append. Full replay
rejects unknown keys or versions, malformed IDs, cross-run records, duplicate
IDs, invalid hashes, missing references, impossible lifecycle order, records
after finalization except cleanup, and cumulative record/byte bounds.

The run index is a rebuildable discovery cache only. A stale or forged index
cannot create, hide, complete, or authorize a run.

Repository ownership is a separate extension-global authority record:

```text
<globalStorageUri>/arena-repository-leases/
  <repositoryIdentitySha256>.owner.v1.jsonl
```

The filename key is derived from the Git common-directory filesystem identity
and object format, not a workspace path, so two VS Code windows and path aliases
converge on one owner. The append-only, hash-chained ledger binds the run,
source-directory identity, private-storage identity, locked repository
controls, base revision, and exact manifest-lock event hash. It never stores
raw source or private paths.

The cross-process file mutex is short-lived serialization only. The repository
owner claim is durable and has no TTL, heartbeat expiry, force-release, or
steal operation. A different run remains blocked until the active run appends a
release that is independently proven from the private manifest, immutable
registration receipts, complete cleanup replay, Git registry absence, and
exact target-path absence. Run IDs cannot be reused after release, and an old
claim receipt cannot regain authority after recovery or release.

Restart takeover additionally requires private, typed, run- and
process-generation-bound quiescence for every submitted generation. Strict
startup replay classifies intent-only delivery as unknown, submitted work
without a quiescence receipt as unconfirmed, finalized runs as cleanup-only,
and interrupted promotion intents as inspection-only. A typed recovery action
proof binds the run, manifest lock/latest event, and complete generation root.
Only then may the repository ledger append `claimRecovered`, and only after the
prior extension-host PID is definitely gone. A dead or ambiguous PID alone
never proves contestant quiescence and never grants takeover.

The v1 event vocabulary is:

- `arenaRunLocked`;
- `arenaMainWorkspaceObserved`;
- `arenaWorktreeRegistered`;
- `arenaWorktreeProvisioned`;
- `arenaContestantStarted`;
- `arenaContestantFinished`;
- `arenaVerificationRecorded`;
- `arenaBrowserJourneyRecorded`;
- `arenaEvidencePreserved`;
- `arenaRunFinalized`; and
- `arenaCleanupStepRecorded`.

Sequence, not wall-clock time, establishes causality. The file store reloads
and fully replays under a cross-process per-run lease before each append, then
publishes the complete validated history by same-directory atomic replacement.
The repository-owner history uses the same crash-atomic old-or-new rule.
An exact retry of an existing event ID is idempotent only when the complete
canonical event matches; a same-ID collision fails closed.

### Disposable detached worktrees

Before any Git side effect, Hydra exclusively creates and flushes one immutable
registration intent. It binds the run, contestant, derived private path, exact
base, source/repository identity, pre-run worktree registry, static ref/config
controls, and opaque Git lock reason. Only then does Hydra create one exact
private direct-child directory with an argument-vector spawn equivalent to:

```text
git worktree add --detach --lock --reason <opaque-run-binding> \
  --no-relative-paths -- <exact-private-path> <locked-base-object>
```

Hydra does not invoke a shell, derive a branch name, use `-b` or `-B`, inherit
Git directory/index override variables, or accept a contestant-selected path
or revision. The executor sanitizes Git environment overrides and disables
optional locks, fsmonitor, external diff, textconv, and other configured helper
surfaces where the operation permits it. After creation Hydra verifies:

On Windows the executor also supplies its own `core.longpaths=true` override.
That removes the legacy Win32 checkout limit, but Git still has a separate
internal linked-worktree `$GIT_DIR` path budget. Stage 2 therefore places its
synthetic physical worktrees under a short, workspace-keyed child of
`globalStorageUri` rather than the longer per-workspace `storageUri`. The
private manifest still binds the exact derived path and directory identity.
The stage-3 controller maps logical run/head IDs to one fixed-length opaque
physical segment, parses bounded `git ls-files -z` output, and enforces a
conservative UTF-16 budget for both `<target>/.git` and the longest tracked
path. It fails before parent creation or intent publication when that budget
does not fit. Doctor reports the OS `LongPathsEnabled` and Git
`core.longpaths` state without treating either as a substitute for preflight.

- the logical and real path remain inside the expected private Arena worktree
  parent and no parent or target is a symbolic link or reparse-point escape;
- Git's stable `worktree list --porcelain -z` output lists the exact path as a
  locked linked worktree with Hydra's exact opaque lock reason and no prunable
  or duplicate registration;
- `HEAD` is detached at the locked base object; and
- the initial content fingerprint matches the locked canonical base content.

Hydra then exclusively creates and flushes an immutable registration receipt
binding the intent hash, real-path hash, directory identity, Git registration,
detached `HEAD`, and initial fingerprint. `arenaWorktreeRegistered` binds that
receipt hash into the manifest before preparation. A crash before `git
worktree add` leaves only a harmless intent; a crash after Git registration but
before the receipt or manifest event is recovered by re-reading the intent and
strict `worktree list --porcelain -z` state. An unregistered directory at the
derived target, a different lock reason, a changed identity, or an unrelated
registry delta fails closed. Hydra never retries with a different target.

If dependencies or generated prerequisites are needed, Hydra runs only the
separately confirmed preparation plan with the same resolved executable,
arguments, environment policy, limits, and base controls in every contestant
worktree. One `arenaWorktreeProvisioned` event repeats the durable registration
hash and records the explicit preparation outcome (`succeeded`, `failed`,
`cancelled`, or `timedOut`), receipt, and post-attempt fingerprint. No hidden
per-head install or setup command is allowed. Every locked worktree must be
registered and provisioned before the first contestant dispatch; dispatch additionally
requires every preparation outcome to be `succeeded` and every
post-preparation fingerprint to be identical. A mismatch permanently latches
`preparationStateMismatch` and prevents all dispatch. A failed preparation is
never called dispatch-ready, but its registered worktree can enter the
`beforeDispatch` terminal/evidence/cleanup path. Registration that succeeded
before preparation began has the same recovery path.

Worktree paths and provider session identifiers remain private. The manifest
uses opaque worktree IDs plus hashes of preparation receipts.

Contestants may edit only their assigned worktree under the already-confirmed
Mission Contract. Steering is disabled for locked Arena work. Arena prompts
forbid commits, ref changes, pushes, publication, deployment, and access to
other contestant directories. Those instructions narrow intended behavior but
do not turn linked worktrees into a sandbox; native authority and user consent
remain the real security boundary.

The Stage-3 compatibility path remains Hydra's installed, identity-bound
fake-head helper. The controller writes a metadata-only process intent before
spawn, rechecks the Mission binding, executable, helper, worktree directory,
and sanitized environment policy, then awaits durable submission publication
before writing stdin. Native admission is now an explicit adapter capability:
the controller requires the locked `agentKind`, and the supervisor requires an
exact platform and executable-identity-bound broker that owns spawn and returns
a bounded, process-generation-bound zero-descendant proof. A direct child's
`close` event never satisfies that contract. Hydra currently ships no such
native adapter broker, so built-in Codex, Claude, ACP, and other native heads
remain closed rather than receiving a synthetic proof. Steering and Terminal
Bridge are structurally absent from this path.

On Windows, the existing identity-bound snapshot killer is useful teardown but
is not admission proof: a descendant can escape or be reparented between
snapshots. A native broker needs pre-execution Job Object containment and a
reliable active-process-zero observation. On POSIX systems, a detached process
group is also insufficient because a descendant can call `setsid`; a broker
needs a cgroup/container-style containment boundary or an equivalent primitive
that it can prove quiescent. These are intentional platform gates, not inferred
fallbacks.

All process factories are provider-write-free and ready before the first spawn.
Hydra repeats the source check after those factories finish, then serializes a
fresh source receipt immediately before each contestant intent and again after
intent publication immediately before spawn. Once the operating system accepts
the child, that contestant's start event and submission receipt become durable
inside one supervisor gate before stdin; a contestant rejected or cancelled
before acceptance remains truthfully `beforeDispatch` and unstarted. Execution
becomes parallel only after that contestant's durable submission boundary. The
first rejected or unsafe dispatch aborts its siblings, but the controller
awaits every supervisor's confirmed or explicitly unconfirmed terminal result
before closing the monitor or returning. A receipt publication failure is
classified before sibling cancellation and can never be relabeled as a user
Stop. Because Node filesystem promises cannot be cancelled safely, the
broker-owned start/submission callback is awaited to actual settlement; Hydra
never abandons an authority write behind a timer and then returns while it can
still mutate the run.

### Source-workspace integrity is latched

Hydra captures the source-workspace fingerprint before lock, starts the
existing recursive mutation monitor before creating contestant worktrees, and
records a private monitor-start receipt with one opaque epoch ID. Provisioning
is rejected until that `monitorStarted` event replays successfully. Every later
checkpoint and post-evidence observation must bind the same epoch and a unique
receipt; a crash or restart does not silently replace the monitor epoch.
Checkpoint calls are serialized because observation counts are authority data,
and every receipt is privately durable before its manifest reference.
Hydra captures a final `postEvidence` fingerprint after all contestant evidence
is durable.
`.git` changes needed for linked-worktree administration and Hydra-owned
`.hydra` state are excluded. Project changes elsewhere, write-then-revert
events, monitor failure, fingerprint failure, or an unexpected source `HEAD`
change append `arenaMainWorkspaceObserved` and permanently latch the run as
compromised.

A separate repository-control snapshot covers shared refs and repository
configuration. Expected linked-worktree administration rows are allowlisted by
exact run and contestant identity; a new branch/ref, changed remote/config,
moved worktree, unexpected lock, registry mismatch, or contestant `HEAD` that
no longer equals the locked base also latches compromise. This cannot prevent
a malicious same-user process from changing and restoring shared state between
captures.

A later unchanged observation cannot clear compromise. Once compromise is
latched, Hydra rejects new provisioning, dispatch, verification, and browser
work. Already-dispatched contestants may finish, and provisioned contestants may
record a bounded `beforeDispatch` failed/cancelled terminal event. Hydra may
then preserve available evidence and finalize for cleanup. A compromised run
may show a complete matrix when the control failure happened after all
comparison evidence, but it is not promotion-eligible and cannot claim
identical controls.

### Verification and evidence are contestant-bound

Hydra, not a contestant, executes the locked verification checks and optional
browser journeys against each exact contestant worktree. Browser journeys
remain owned by `IntegratedBrowserBroker` and keep ADR 003's session consent,
per-action confirmation, owned-tab, URL, token, and private screenshot rules.
Each attempt records
the locked plan hash, contestant ID, worktree fingerprint, exact `HEAD`,
bounded status, and private receipt hash. A retry is a new ordered attempt; a
passing attempt is terminal for that check.

The controller requires an exact ordered execution-plan set before admission
and invokes trusted verifier/browser executors with only the assigned canonical
worktree, the locked command or journey digest, a timeout, output/count bounds,
and the run signal. Executors must settle only after their own process or browser
broker has produced typed quiescence. Receipts retain hashes, counts, status,
duration, and state bindings, never command output, paths, page content, URLs,
selectors, screenshots, or source bytes. Manifest append and replay both
re-open and validate the bounded private receipt. One continuous contestant
sentinel spans terminal publication, all acceptance attempts, and evidence
publication; write-then-revert activity fails closed and retains the run.

Before any destructive cleanup, Hydra preserves a bounded artifact set per
durably registered contestant:

- a binary/full-index patch against the locked base, including file modes and
  deletions;
- a separately bounded archive and inventory for permitted untracked files;
- final `HEAD` and workspace fingerprints;
- agent, verification, browser, cost, timing, and Flight receipt references;
  and
- a canonical artifact-set hash used by the comparison matrix.

Replay recomputes that artifact-set hash from the patch, untracked archive,
inventory, receipts root, typed quiescence, final `HEAD`, and final workspace
fingerprint. The controller also re-fingerprints the worktree after private
publication and refuses to append the evidence event if state changed during
capture.

A user Stop remains the cancellation signal for live providers. Only after the
bundled helper has confirmed close does Hydra switch to a fresh bounded
non-user-cancellable signal for quiescence fingerprints, artifact preservation,
the final source receipt, and exact cleanup. A contestant cancelled before
spawn has a typed `beforeDispatch` result with no submission and therefore no
quiescence receipt; Hydra fresh-captures its unchanged worktree, preserves the
partial artifact set with both quiescence fields null, finalizes the run as
cancelled/incomplete, and cleans it. Internal transport or receipt failures
remain failed even when their fail-fast signal cancels sibling heads.
A later user Stop cannot overwrite an already observed provider failure,
timeout, or delivery uncertainty; `userCancelled` is causal only when at least
one result is cancelled and every other result is succeeded or cancelled.

Files are opened without following links, content and entry counts are bounded,
and an unsafe artifact capture blocks Hydra-managed cleanup. Preservation binds
the terminal event plus every receipt that actually exists; it does not falsely
claim that missing locked checks ran. This partial-preservation path is what
allows cancelled, preparation-failed, or dispatch-rejected worktrees to clean
up safely. Comparison completeness remains a separate, stricter invariant.
Artifact retention is independent from worktree cleanup.

`arenaRunFinalized` distinguishes:

- `comparable`: every contestant completed a successful execution from the same
  prepared state, every locked check and journey has a receipt, every artifact
  set is durable, one fresh post-evidence monitor receipt matches the lock, and
  no compromise was latched;
- `compromised`: complete evidence exists but a locked control or source
  integrity invariant failed; and
- `incomplete`: required execution or evidence is missing, including
  pre-dispatch cancellation and uncertain process termination.

Votes, Elo, standings, rhetorical quality, and peer support never change that
classification.

For a completed run, `evidenceMatrixSha256` is not a caller-supplied label.
Replay recomputes it with a separate domain from the run-lock event hash, the
fresh post-evidence observation event hash, and—in locked contestant, check,
and journey order—every terminal, verification-attempt, browser-attempt, and
artifact-set event hash. A forged or stale matrix digest invalidates the
manifest and cannot become promotion-eligible.

### Cleanup is ordered, resumable, and exact-target only

Cleanup is an append-only state machine defined in `src/arenaCleanup.ts`.
Hydra starts it only after the run is finalized and the target contestant's
artifact set is durably recorded. Its exact order is:

1. `quiesceProcesses`;
2. `verifyTarget`;
3. `unlockGitWorktree`;
4. `removeGitWorktree`;
5. `verifyGitRegistrationGone`; and
6. `removeResidualDirectory`.

Every destructive attempt re-resolves and verifies the expected private root,
run ID, contestant ID, path containment, link/reparse status, and captured
directory identity and Hydra lock reason. `unlockGitWorktree` removes only that
exact Hydra-owned lock. `removeGitWorktree` then uses exact-target
`git worktree remove --force`; force is required because contestant worktrees
are expected to be dirty and their artifacts are already preserved. Hydra
does not run broad `git worktree prune`, `git worktree repair`, Git GC, edit
`$GIT_COMMON_DIR/worktrees` directly, or delete a directory while Git still
reports it registered.

Stage 2 records `removeResidualDirectory` as `notNeeded` only when the exact
path is already absent. If Git removes its registry row but a directory
survives, the stage-2 executor blocks cleanup; it does not issue a recursive
path deletion vulnerable to a same-user path swap. A later cleanup broker must
quarantine and authenticate the exact filesystem object with crash-replayable
receipts before this step may remove a residual tree.

The pure cleanup protocol permits bounded retries only for
`processStillRunning`, `sharingViolation`, `pathBusy`, and
`directoryNotEmpty`, using the fixed delays 50, 100, 250, 500, 1000, and
2000 ms. Other failures block immediately. Exhausting the schedule records
`retryExhausted`; it does not fall through to recursive deletion.

If a process crashes after an external side effect but before its complete,
flushed receipt append, recovery probes the exact target again and records
`notNeeded` when the intended postcondition is already true. Completed steps
never execute again. A blocked cleanup remains visible and leaves retained
evidence and any unverified target in place for explicit recovery. Stage 3
drives only the next operation authorized by replay, follows the fixed retry
schedule, and uses crash-atomic manifest and owner-ledger histories. It never
truncates, repairs, or infers missing authority.

### Reveal, winner selection, promotion, and synthesis remain human gates

The Arena result surface reveals all contestant outcomes together in a
side-by-side matrix bound to the manifest and artifact-set hashes. It does not
rank hidden results while contestants are running. Winner and synthesis
choices are immutable local receipts: winner selection explicitly grants no
authority, while synthesis binds at least two retained artifact sets and
requires a new isolated run without source-workspace mutation.

The user may select a winner or request synthesis after reveal. Selection is a
workflow preference, not a factual verdict and not authority. Promotion
requires a separate preview showing the exact patch, target workspace state,
Mission Contract mutation decision, conflicts, and verification implications,
followed by an exact local confirmation. MVP promotion is unavailable if the
source workspace no longer matches its locked state; Hydra offers a new
isolated synthesis run instead of modifying around concurrent user work.

The operator preview renders the complete retained patch up to its explicit
1 MiB UI bound plus the exact untracked path/size/mode/digest inventory; larger
patches are refused by this surface rather than summarized as exact. Execution
double-verifies retained evidence, rechecks clean source/HEAD/controls and
untracked conflicts, persists an immutable intent before mutation, sends the
exact patch bytes to Git over bounded stdin, creates untracked files
exclusively without following links, and records a post-apply result. Promotion
holds the repository's cross-process unowned lock and never deletes evidence.
`retireAfterVerifiedPromotion` is only a recorded Mission postcondition request;
this workflow does not retire Mission authority.

Hydra never automatically merges, commits, pushes, publishes, deploys, chooses
a winner, changes builder assignment, or grants permissions because of an
Arena result.

## Consequences

### Positive

- Contestant edits are attributable and reversible without branch creation.
- Complete flushed mission, base, control, evidence, and cleanup records
  survive crashes and cross-window replay; each authoritative history exposes
  the complete old or new sequence rather than a torn append.
- Main-workspace interference and incomplete capture remain visible instead of
  being repaired into false comparability.
- Windows handle failures cannot trigger an unsafe broad deletion.
- Jury findings can later bind stable run, contestant, base, and artifact-set
  hashes.

### Negative

- Worktrees share repository objects, refs, configuration, and same-user host
  authority; stronger isolation would require a separate sandbox/container
  design.
- Full fingerprints, patches, untracked archives, and identical verification
  multiply I/O, storage, latency, and cost by contestant count.
- Strict cleanup can leave a blocked private worktree for manual recovery.
- No production native-head adapter currently owns the OS containment needed
  by the new quiescence-broker contract. Windows requires Job Object-style
  containment; POSIX process groups alone do not contain `setsid` descendants.
- Recovery is deliberately fail-closed: corrupt supporting receipts,
  intent-only delivery, live or ambiguous prior owner PIDs, and incomplete
  quiescence all remain inspect-only. Startup scanning never resumes, aborts,
  takes ownership, or reapplies an interrupted promotion automatically.
- Requiring a clean main worktree narrows the MVP but prevents ambiguous
  attribution and promotion.

## Alternatives considered

- Run contestants sequentially in the same workspace: rejected because edits,
  caches, and failure residue leak between contestants and attribution becomes
  ambiguous.
- Clone the repository per contestant: stronger object-store separation but
  slower, larger, and more credential/remote-sensitive than a local detached
  linked worktree. It remains a future isolation option.
- Create one branch per contestant: rejected because branch/ref creation is
  durable shared repository mutation and cleanup becomes a ref-management
  feature.
- Treat worktrees as a security sandbox: rejected because linked worktrees and
  same-user native processes do not enforce that boundary.
- Delete directories directly and run `git worktree prune`: rejected because
  it can lose unpreserved evidence and broad prune can affect unrelated stale
  worktrees.
- Let a model or vote choose/promote the winner: rejected because comparison
  evidence does not grant authority or establish factual truth.

## Validation and rollout

The pure protocol tests pin a canonical golden hash; exact-key and byte bounds;
SHA-1 and SHA-256 Git object validation; duplicate contestants/checks; hash,
sequence, and reference corruption; cross-run splicing; lifecycle
permutations; stable pre-provision monitor epochs; all-provisioned dispatch
barriers; explicit failed-preparation recovery; equal preparation
fingerprints; locked input/environment/budget binding; matrix-root
recomputation; main-workspace compromise latching; post-compromise execution
refusal; partial pre-dispatch evidence; attempt ordering;
evidence-before-cleanup; finalization classification; and no post-finalization
records except cleanup.

Cleanup tests cover exact step order, contiguous attempts, fixed retry delays,
transient/non-transient failure classification, retry exhaustion, terminal
blocking, crash recovery through `notNeeded`, duplicate successful steps, and
refusal to start without durable evidence.

Store/worktree tests must cover invalid UTF-8, torn and oversized rows,
concurrent append/idempotency collisions, private-root and realpath
containment, links and path swaps, spaces and Unicode, dirty/bare/non-main
workspace rejection, configured Git helper suppression, locked Windows
handles, crash points around `git worktree add/remove`, unrelated linked
worktree preservation, owner-ledger races/release/restart fencing, and artifact
retention after cleanup. The `hydraRoom.runArenaSmokeTest` command first
retains the stage-2 synthetic lifecycle coverage: it creates two detached
targets, reconciles the
receipt-to-manifest crash window, records bounded pre-dispatch cancellation
evidence, cleans exact targets, and proves the source workspace and an
unrelated worktree are unchanged. Before its first Git side effect it publishes an immutable
private recovery catalog naming only the exact synthetic roots; confirmed
cleanup removes that catalog, while a hard host death leaves it for the
bounded startup recovery scan. The current activation scan also replays the
authoritative manifest, strict dispatch receipt generations, and promotion
intent/result pairs. It exposes explicit recovery classifications and proof
preparation; repository-owner recovery remains a separate typed executor call.

The command then runs the stage-3 controller against two supervised fake
heads. It exercises continuous source monitoring, durable process
intent/submission/quiescence receipts, parallel tracked and untracked edits,
binary/full-index artifact preservation, a recomputed comparable evidence
matrix, replay-driven exact cleanup, repository-owner release, and unchanged
source proof in a real extension host. It does not execute a native model,
verification plan, browser journey, UI reveal, promotion, or recovery
takeover.

Adversarial controller tests mutate the source during provider-free process
preparation and prove that no submission or stdin follows. Separate cancellation
tests stop before the first spawn and after submitted fake heads begin work;
they pin typed pre-dispatch cancellation, sibling drain, fresh post-close
quiescence, partial/full evidence preservation, exact cleanup, source
immutability, and lease release. The pure batch test proves the primary error
is retained while a slower sibling drains and that internal fail-fast never
aborts the caller's parent signal.

Arena patch and untracked artifacts contain source content and therefore stay
in the separate private Arena artifact store; they are never copied into
metadata-only Flight records. `hydra.flight.v1` still has no Arena-specific
operation kind and its readers remain unchanged. Arena now uses the explicitly
compatible `hydra.flight.arena.v1` sidecar under private Arena support storage.
It projects the Arena event hash, Mission binding, contestant/status, receipt,
artifact-set, and matrix hashes into its own bounded immutable hash chain. The
projection is replay-validated but non-authoritative: its failure marks the
returned projection incomplete and cannot cancel, retry, or relabel Arena work.

Roll out in stages:

1. pure run-manifest and cleanup protocols;
2. private manifest/artifact store plus hardened Git worktree executor and
   synthetic lifecycle smoke only (no real-workspace Arena admission);
3. Arena controller with main-workspace monitor and fake-head smoke
   (implemented; built-in native heads remain closed until an adapter supplies
   real OS containment proof);
4. locked verification/browser execution and the compatible Flight extension
   projection (implemented in Arena core; runtime browser/native adapters remain
   separately gated);
5. reveal matrix and explicit winner/synthesis controls (implemented);
6. exact-previewed, separately confirmed local-workspace promotion
   (implemented; no commit/push/publish/deploy or Mission retirement); and
7. strict startup classification, typed recovery-action proof, and dead-owner
   repository-claim recovery (implemented; no automatic resume or reapply).

Rollback disables new Arena admission and cleanup dispatch while preserving
private manifests, evidence, and blocked targets. Existing detached worktrees
remain recoverable from their manifests. Rollback must not reconstruct
authority from `.hydra`, delete retained artifacts, or run broad Git cleanup.

## Source anchors

- Git worktree lifecycle and detached throwaway worktrees:
  https://git-scm.com/docs/git-worktree
- Git porcelain status:
  https://git-scm.com/docs/git-status
- Git diff and binary/full-index patching:
  https://git-scm.com/docs/git-diff
- Mission Contract authority:
  `docs/architecture/005-authoritative-mission-contracts.md`
- Flight Recorder metadata and replay boundary:
  `docs/architecture/006-private-metadata-flight-recorder.md`
- Steering exclusion for locked Arena work:
  `docs/architecture/004-non-interrupting-live-steering.md`
