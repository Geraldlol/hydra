# ADR 007: Isolated, evidence-bound Hydra Arena runs

- Status: Accepted for staged implementation
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
5. Sparse checkout, submodules, `skip-worktree`, and `assume-unchanged` index
   entries are absent. They remain unsupported in the MVP because they make
   clean-state and candidate-content equivalence ambiguous.
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
<storageUri>/arena/artifacts/<runId>/<contestantId>/...
<storageUri>/arena/worktrees/<runId>/<contestantId>/...
```

Run manifests and retained artifacts are physically separate from disposable
worktrees so worktree cleanup cannot erase patches or receipts.
`.hydra/arena.md` is a bounded, redacted, disposable comparison mirror and is
never an input to replay, promotion, Jury, or cleanup.

The v1 manifest is an append-only, domain-separated SHA-256 chain. Every exact
schema event carries a run ID, contiguous sequence, previous-event hash, and
event hash. Full replay rejects unknown keys or versions, malformed IDs,
cross-run records, duplicate IDs, invalid hashes, missing references,
impossible lifecycle order, records after finalization except cleanup, and
hard record/byte bounds.

The run index is a rebuildable discovery cache only. A stale or forged index
cannot create, hide, complete, or authorize a run.

The v1 event vocabulary is:

- `arenaRunLocked`;
- `arenaMainWorkspaceObserved`;
- `arenaWorktreeProvisioned`;
- `arenaContestantStarted`;
- `arenaContestantFinished`;
- `arenaVerificationRecorded`;
- `arenaBrowserJourneyRecorded`;
- `arenaEvidencePreserved`;
- `arenaRunFinalized`; and
- `arenaCleanupStepRecorded`.

Sequence, not wall-clock time, establishes causality. A future file store must
reload and fully replay under a cross-process per-run lease before each append.
An exact retry of an existing event ID is idempotent only when the complete
canonical event matches; a same-ID collision fails closed.

### Disposable detached worktrees

Each contestant gets one exact private direct-child directory created with an
argument-vector spawn equivalent to:

```text
git worktree add --detach --lock --reason <opaque-run-binding> \
  --no-relative-paths <exact-private-path> <locked-base-object>
```

Hydra does not invoke a shell, derive a branch name, use `-b` or `-B`, inherit
Git directory/index override variables, or accept a contestant-selected path
or revision. The executor sanitizes Git environment overrides and disables
optional locks, fsmonitor, external diff, textconv, and other configured helper
surfaces where the operation permits it. After creation Hydra verifies:

- the logical and real path remain inside the expected private Arena worktree
  parent and no parent or target is a symbolic link or reparse-point escape;
- Git's stable `worktree list --porcelain -z` output lists the exact path as a
  locked linked worktree with Hydra's exact opaque lock reason;
- `HEAD` is detached at the locked base object; and
- the initial content fingerprint matches the locked canonical base content.

If dependencies or generated prerequisites are needed, Hydra runs only the
separately confirmed preparation plan with the same resolved executable,
arguments, environment policy, limits, and base controls in every contestant
worktree. One `arenaWorktreeProvisioned` event records successful Git
registration plus the explicit preparation outcome (`succeeded`, `failed`,
`cancelled`, or `timedOut`), receipt, and post-attempt fingerprint. No hidden
per-head install or setup command is allowed. Every locked worktree must be
provisioned before the first contestant dispatch; dispatch additionally
requires every preparation outcome to be `succeeded` and every
post-preparation fingerprint to be identical. A mismatch permanently latches
`preparationStateMismatch` and prevents all dispatch. A failed preparation is
never called dispatch-ready, but its provisioned worktree can enter the
`beforeDispatch` terminal/evidence/cleanup path.

Worktree paths and provider session identifiers remain private. The manifest
uses opaque worktree IDs plus hashes of preparation receipts.

Contestants may edit only their assigned worktree under the already-confirmed
Mission Contract. Steering is disabled for locked Arena work. Arena prompts
forbid commits, ref changes, pushes, publication, deployment, and access to
other contestant directories. Those instructions narrow intended behavior but
do not turn linked worktrees into a sandbox; native authority and user consent
remain the real security boundary.

### Source-workspace integrity is latched

Hydra captures the source-workspace fingerprint before lock, starts the
existing recursive mutation monitor before creating contestant worktrees, and
records a private monitor-start receipt with one opaque epoch ID. Provisioning
is rejected until that `monitorStarted` event replays successfully. Every later
checkpoint and post-evidence observation must bind the same epoch and a unique
receipt; a crash or restart does not silently replace the monitor epoch.
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

Before any destructive cleanup, Hydra preserves a bounded artifact set per
provisioned contestant:

- a binary/full-index patch against the locked base, including file modes and
  deletions;
- a separately bounded archive and inventory for permitted untracked files;
- final `HEAD` and workspace fingerprints;
- agent, verification, browser, cost, timing, and Flight receipt references;
  and
- a canonical artifact-set hash used by the comparison matrix.

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

The pure cleanup protocol permits bounded retries only for
`processStillRunning`, `sharingViolation`, `pathBusy`, and
`directoryNotEmpty`, using the fixed delays 50, 100, 250, 500, 1000, and
2000 ms. Other failures block immediately. Exhausting the schedule records
`retryExhausted`; it does not fall through to recursive deletion.

If a process crashes after an external side effect but before its receipt
append, recovery probes the exact target again and records `notNeeded` when
the intended postcondition is already true. Completed steps never execute
again. A blocked cleanup remains visible and leaves retained evidence and any
unverified target in place for explicit recovery.

### Reveal, winner selection, promotion, and synthesis remain human gates

A future Arena controller reveals all contestant outcomes together in a
side-by-side matrix bound to the manifest and artifact-set hashes. It does not
rank hidden results while contestants are running.

The user may select a winner or request synthesis after reveal. Selection is a
workflow preference, not a factual verdict and not authority. Promotion
requires a separate preview showing the exact patch, target workspace state,
Mission Contract mutation decision, conflicts, and verification implications,
followed by an exact local confirmation. MVP promotion is unavailable if the
source workspace no longer matches its locked state; Hydra offers a new
isolated synthesis run instead of modifying around concurrent user work.

Hydra never automatically merges, commits, pushes, publishes, deploys, chooses
a winner, changes builder assignment, or grants permissions because of an
Arena result.

## Consequences

### Positive

- Contestant edits are attributable and reversible without branch creation.
- Locked mission, base, controls, evidence, and cleanup history survive crashes
  and cross-window replay.
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

Later store/worktree tests must cover invalid UTF-8, torn and oversized rows,
concurrent append/idempotency collisions, private-root and realpath
containment, links and path swaps, spaces and Unicode, dirty/bare/non-main
workspace rejection, configured Git helper suppression, locked Windows
handles, crash points around `git worktree add/remove`, unrelated linked
worktree preservation, and artifact retention after cleanup. An
`hydraRoom.runArenaSmokeTest` extension-host scenario must create two bounded
fake contestants, preserve patches/receipts, replay the matrix, clean exact
targets, and prove the source workspace and unrelated worktrees are unchanged.

Arena patch and untracked artifacts contain source content and therefore stay
in the separate private Arena artifact store; they are never copied into
metadata-only Flight records. `hydra.flight.v1` also has no Arena-specific
operation kind. Arena projection is deferred until a backward-readable Flight
schema revision or an explicitly compatible extension is designed; existing
v1 kinds must not be relabeled dishonestly.

Roll out in stages:

1. pure run-manifest and cleanup protocols;
2. private manifest/artifact store plus hardened Git worktree executor;
3. Arena controller with main-workspace monitor and fake-head smoke;
4. locked verification/browser execution and the compatible Flight schema
   revision/projection;
5. reveal matrix and explicit winner/synthesis controls; and
6. previewed, separately confirmed promotion.

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
