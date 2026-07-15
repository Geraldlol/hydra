import { findExecutableOnPath } from "./executablePath";
import * as vscode from "vscode";

const cachedGitExecutables = new Map<string, string>();

/**
 * Workspace-local Git config can execute helpers (for example
 * `core.fsmonitor`) even for an otherwise read-only `git status`. Treat every
 * Git child with a workspace cwd as native workspace execution and fail closed
 * until VS Code Workspace Trust has been granted.
 */
export function workspaceGitExecutionAllowed(): boolean {
  return vscode.workspace.isTrusted === true;
}

/** Resolve Git to an absolute PATH candidate before using a workspace cwd. */
export async function resolveGitExecutable(workspaceRoot: string): Promise<string | undefined> {
  // Check before consulting the cache: a path resolved while trusted must not
  // remain usable if this helper is later called from an untrusted context.
  if (!workspaceGitExecutionAllowed()) return undefined;
  const cacheKey = process.platform === "win32" ? workspaceRoot.toLowerCase() : workspaceRoot;
  const cached = cachedGitExecutables.get(cacheKey);
  if (cached) return cached;
  const resolved = await findExecutableOnPath("git", {
    forbiddenRoots: [workspaceRoot],
    // panel/verification spawn with shell:false. Restrict Git to native
    // executables so a PATH-only git.cmd cannot reintroduce shell parsing.
    allowedWindowsExtensions: [".EXE", ".COM"],
  });
  if (resolved) cachedGitExecutables.set(cacheKey, resolved);
  return resolved;
}
