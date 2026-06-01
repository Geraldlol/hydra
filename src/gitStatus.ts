export interface WorkspaceChange {
  path: string;
  status: string;
  kind: string;
}

export function parseGitStatusEntries(raw: string): WorkspaceChange[] {
  const entries = raw.split("\0");
  const changes: WorkspaceChange[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    // Why: rename/copy entries are emitted as two NUL fields — the NEW path
    // first, then the ORIG path. Advance past the ORIG field so it is consumed,
    // not re-emitted as a phantom change; the pushed change keeps the NEW path.
    if (status.includes("R") || status.includes("C")) i += 1;
    changes.push({
      path: filePath,
      status: status.trim() || status,
      kind: gitStatusKind(status),
    });
  }
  return changes;
}

export function gitStatusKind(status: string): string {
  if (status === "??") return "untracked";
  if (status.includes("A")) return "added";
  if (status.includes("D")) return "deleted";
  if (status.includes("R")) return "renamed";
  if (status.includes("C")) return "copied";
  if (status.includes("M")) return "modified";
  return "changed";
}
