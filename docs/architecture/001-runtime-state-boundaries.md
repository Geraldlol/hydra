# ADR 001: Separate durable workspace state from ephemeral runtime state

- Status: Accepted
- Date: 2026-07-14
- Owners: Hydra maintainers

## Context

Hydra coordinates long-running agent processes, Telegram delivery, and append-only workspace records. Those paths have different durability and trust requirements:

- room transcripts, decisions, events, and queues are user-owned records that should remain inspectable in `.hydra/`;
- terminal dispatch files can contain prompts, commands, paths, or authentication material and are only needed while a request is running;
- Telegram polling is shared across windows, while delivery into a room is complete only after the room has durably handled the item;
- append-only files can grow without bound, making startup work and memory use depend on repository age.

Treating every artifact as ordinary workspace state exposed transient data to workspace processes and made crash recovery ambiguous.

## Decision

### Durable workspace records

User-facing room state remains under `.hydra/`. Reads are capped or streamed, appends use path-safe helpers, and indexes may be compacted with an atomic replacement. The active transcript rotates before a new message would cross its size ceiling; the archived prefix is removed from in-memory panel state at the same boundary.

### Ephemeral terminal artifacts

Terminal prompts, launchers, replies, logs, and session snapshots live under a workspace-specific directory rooted in VS Code `ExtensionContext.storageUri`. A hashed directory under `globalStorageUri` is used when workspace storage is unavailable. The bridge rejects roots inside the workspace, checks containment and file identity, uses private permissions where the platform supports them, authenticates replies and log snapshots, deletes request material promptly, and sweeps crash leftovers after a short retention window.

Environment overrides are passed directly to terminal creation. Persisted dispatch data contains only an environment fingerprint, never environment values.

### Telegram commit points

Polling uses a token-scoped, fixed-expiry lease. An update offset advances only after a routed item is durably appended to the destination inbox. A room acknowledges that inbox item only after its handling reaches the room's durable transcript boundary. Lease fencing prevents an expired poller from updating offsets or deleting a successor's lease.

## Alternatives considered

- Keep terminal artifacts in `.hydra/`: simpler discovery, but broadens access to sensitive transient data and leaves it in user backups and source-control tooling.
- Keep all runtime state only in memory: reduces disk exposure, but loses crash recovery and cannot coordinate extension windows safely.
- Read append-only files in full: simplest implementation, but creates unbounded latency and memory use.
- Advance Telegram offsets on receipt: maximizes throughput, but can lose routed commands between receipt and durable inbox storage.

## Consequences

- Workspace state stays portable and inspectable without including terminal secrets.
- Terminal diagnostics are intentionally short-lived and move outside the repository.
- Large histories have bounded read costs, with older transcript messages available in timestamped archives.
- Telegram may redeliver after a crash, so inbox identifiers and room acknowledgements must remain idempotent.
- Storage helpers and protocol validation add implementation complexity and require adversarial filesystem tests.

## Validation and rollback

Contract tests cover storage containment, links and replacement races, reply authentication, bounded/torn-record reads, transcript rotation, Telegram lease fencing, and durable acknowledgements. CI runs unit tests on Linux and Windows and an extension-host smoke test on both platforms.

Rollback is component-scoped: disable the affected transport or restore the previous reader while preserving the durable files. Do not move terminal artifacts back into the workspace or advance Telegram offsets before durable routing; those are security and delivery invariants, not optional optimizations.
