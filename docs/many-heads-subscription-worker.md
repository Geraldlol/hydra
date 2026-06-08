# Many Heads Subscription Worker

Status: draft design note for Many Heads Mode after the Claude automation
credit guard slices.

## Decision

Many Heads Mode should spend from the user's subscription-backed Claude Agent
SDK credit pool, not from Anthropic Platform API keys. That means Hydra cannot
replace `claude -p` with a direct Messages API loop for this feature. A direct
API runner would be a different billing pool and an uncapped invoice, which is
not the requested product behavior.

For subscription-credit execution, Hydra's worker transport must orchestrate an
official subscription-aware Claude runtime:

- `claude -p --output-format stream-json --verbose --include-partial-messages`
  while it remains the supported headless entrypoint.
- A first-party Agent SDK/Claude Code runtime that explicitly supports the same
  subscription auth and Agent SDK credit pool, if that becomes the stronger
  surface.

The transport can wrap and supervise those runtimes, but it should not attempt
to reimplement their private auth/session protocol.

## Why Not Our Own API Runner

An in-extension Messages API loop would be technically simpler than supervising
Claude Code, but it misses the main constraint: API-key usage is pay-as-you-go
and does not draw from the subscription Agent SDK credit. It is useful as a
future optional transport for users who want API-key billing, but it is not the
Many Heads default.

For open-source users, Hydra can later expose an API-key runner as an explicit
transport choice. For this workspace's default Many Heads Mode, the workaround
for losing practical access to `claude -p` is subscription-auth Agent SDK /
Claude Code execution, not Anthropic Platform API billing.

## No-API Subscription Workaround

The replacement target is an official subscription-aware runtime invoked through
Hydra's worker contract. For local workers, that can continue to use the logged
in Claude Code credential store. For noninteractive workers or containers, the
documented subscription-auth path is a long-lived OAuth token generated with:

```powershell
claude setup-token
```

The resulting token is supplied as `CLAUDE_CODE_OAUTH_TOKEN` to the worker
environment. That token authenticates through the Claude subscription and draws
from the Agent SDK credit pool. It is not an Anthropic Platform API key.

Important constraint: `--bare` does not read `CLAUDE_CODE_OAUTH_TOKEN`, so the
subscription-credit worker path must not rely on bare mode unless Claude
provides another official subscription-auth mechanism for it.

## Why Not Kubernetes First

Docker and Kubernetes solve isolation, scaling, cleanup, and remote scheduling.
They do not solve subscription-credit auth. A container still has to run an
official subscription-aware Claude runtime with valid Claude Code auth state or
an approved first-party Agent SDK subscription credential.

For Hydra's current single-user VS Code extension shape, the first production
slice should be a local worker pool:

1. Hydra starts bounded local worker processes with the same configured Claude
   command/path/env as normal room calls.
2. Each worker emits the existing `claudeStreamJson`-compatible event stream.
3. Hydra mirrors each stream into `.hydra/live/<turn>/<head>.jsonl`.
4. Codex receives the live-file path in its prompt and can inspect/tail it with
   normal tools during parallel discussions.
5. The Slice 2/3 credit guard gates dispatch before every Claude worker starts.

Kubernetes becomes a later deployment target only when the goal changes to a
remote or multi-machine worker fleet.

## Local Worker Contract

Hydra defines a small internal contract before broadening fanout:

```ts
interface ClaudeWorkerRequest {
  turnId: string;
  headId: string;
  phase: "opener" | "reactor" | "closer" | "build" | "review" | "parallel";
  promptPath: string;
  workspaceFolder: string;
  model?: string;
  effort?: string;
  timeoutMs: number;
  manyHeads: boolean;
  maxBudgetUsd?: number;
}

interface ClaudeWorkerEvent {
  turnId: string;
  headId: string;
  kind:
    | "text_delta"
    | "tool_start"
    | "tool_result"
    | "task_started"
    | "task_progress"
    | "task_notification"
    | "task_summary"
    | "usage"
    | "done"
    | "error";
  timestamp: string;
  payload: unknown;
}
```

The first implementation is a local wrapper around the current one-shot Claude
spawn path for parallel discussion turns. When `hydraRoom.manyHeadsMode` is on
and one-shot transport is active, Hydra plans one Codex worker plus
`hydraRoom.manyHeadsClaudeWorkerCount` Claude workers. Each Claude worker still
dispatches through `callAgent`, so the subscription credit guard runs before
the official Claude runtime starts; each worker receives its own trace/live
file, and Codex receives all Claude live-channel paths in its prompt.

Build/review fanout can reuse the same worker contract later, but it should be a
separate UI/state-machine slice because those phases carry editing/review
ownership semantics beyond discussion.

## Dispatch Guard

Many Heads Mode must not dispatch a Claude head until the guard has evaluated:

- sanitized Claude auth status from `claude auth status`
- current-month Claude spend from `.hydra/usage.jsonl`
- `hydraRoom.claudeAutomationCreditGuard`
- `hydraRoom.claudeAgentCreditCapUsd`
- whether this dispatch is normal Claude automation or Many Heads fanout

`evaluateClaudeAutomationGuard(...)` runs at the `callAgent`/worker-dispatch
boundary, so a block decision prevents spend before the official Claude runtime
starts. Before each allowed Claude dispatch, Hydra also adds
`hydraRoom.claudeAgentEstimatedRunCostUsd` to an in-flight reservation counter
and evaluates later sequential or cross-turn dispatches against recorded month
spend plus those reservations. The reservation is released when the worker
returns; recorded usage remains authoritative once the stream reports actual
cost.

Concurrent fanout still has a narrow overshoot window: workers launched under
the same `Promise.all` can evaluate the guard before sibling reservations are
installed. Closing that requires reserving before guard evaluation and releasing
on block; until then, the reservation hardens sequential dispatches and probe
concurrency, but not every same-turn fanout race.

This is an estimate, not a hard billing boundary. A worker can still cost more
than the configured estimate, so the guard should be treated as a launch-time
brake for Many Heads fanout rather than a substitute for provider-side spend
limits.

## Kubernetes Option

If Hydra later needs remote workers, use Kubernetes as a deployment wrapper
around the same worker contract, not as a different product architecture:

- one Job per Claude head or per bounded batch of heads
- image pins the Hydra worker and the official Claude runtime version
- workspace is mounted from an explicit volume or uploaded bundle
- Claude auth material is supplied only through a dedicated Secret
- no Docker socket mount
- namespace-scoped RBAC
- NetworkPolicy defaults deny except required Claude endpoints and approved MCPs
- CPU, memory, wall-clock, and per-worker budget limits are mandatory
- Job TTL cleanup is mandatory
- every event is mirrored back to `.hydra/live/<turn>/<head>.jsonl`

Do not make Kubernetes the first implementation unless the user explicitly wants
a remote/multi-tenant fleet. It expands the security and ops surface before the
local Many Heads semantics exist.

## Open Questions

- Which official subscription-aware runtime should Hydra target after
  `claude -p`: current Claude Code print mode, Agent SDK, or both behind one
  worker interface?
- Can Claude auth state be used safely in a container without copying raw user
  credentials, or must K8s mode require an explicit user-created Secret?
- Should Many Heads have a separate lower per-head timeout/effort default from
  ordinary Claude turns?
- Should completed child-head summaries become transcript messages, or remain
  live sidecar artifacts unless Claude's parent message references them?
