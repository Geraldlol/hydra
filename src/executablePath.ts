import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ExecutablePathOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Absolute roots whose files must never be selected (including symlink targets). */
  forbiddenRoots?: readonly string[];
  /** Optional Windows executable suffix allowlist, e.g. [".EXE", ".COM"]. */
  allowedWindowsExtensions?: readonly string[];
}

export type WindowsSystemExecutable = "cmd.exe" | "powershell.exe" | "taskkill.exe";

/**
 * Return an absolute path for a Windows inbox executable.
 *
 * Windows searches the child working directory before PATH for bare command
 * names. Hydra deliberately avoids that lookup when the cwd is an untrusted
 * workspace. The fallback is only used by platform-simulation tests; a real
 * Windows extension host always supplies SystemRoot/WINDIR.
 */
export function windowsSystemExecutable(
  executable: WindowsSystemExecutable,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configuredRoot = stripSurroundingQuotes((env.SystemRoot ?? env.WINDIR ?? "").trim());
  const root = path.win32.isAbsolute(configuredRoot) ? configuredRoot : "C:\\Windows";
  if (executable === "powershell.exe") {
    return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", executable);
  }
  return path.win32.join(root, "System32", executable);
}

/**
 * Resolve a bare command by inspecting absolute PATH entries directly.
 *
 * Why: on Windows, CreateProcess searches the child cwd before PATH. Asking a
 * shell/`where.exe` from an untrusted workspace to resolve `git` can therefore
 * execute a workspace-local `git.exe`. Returning an absolute candidate keeps
 * the eventual spawn out of that cwd-first lookup path.
 */
export async function findExecutableOnPath(
  command: string,
  options: ExecutablePathOptions = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (!command.trim() || command.includes("/") || command.includes("\\")) return undefined;

  const pathValue = platform === "win32"
    ? env.Path ?? env.PATH ?? ""
    : env.PATH ?? "";
  const delimiter = platform === "win32" ? ";" : ":";
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const extensions = executableExtensions(command, env, platform, options.allowedWindowsExtensions);
  const forbiddenRoots = await Promise.all(
    (options.forbiddenRoots ?? []).map((root) => canonicalPath(root, pathApi)),
  );

  for (const rawEntry of pathValue.split(delimiter)) {
    const entry = stripSurroundingQuotes(rawEntry.trim());
    // Empty and relative PATH entries intentionally mean "the current cwd".
    // Hydra workspaces are untrusted for executable discovery, so skip them.
    if (!entry || !pathApi.isAbsolute(entry)) continue;
    for (const extension of extensions) {
      const candidate = pathApi.join(entry, `${command}${extension}`);
      const spawnable = await spawnablePath(candidate, platform, pathApi, forbiddenRoots);
      if (spawnable) return spawnable;
    }
  }
  return undefined;
}

function executableExtensions(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  allowedWindowsExtensions: readonly string[] | undefined,
): string[] {
  if (platform !== "win32" || path.win32.extname(command)) return [""];
  const configured = (allowedWindowsExtensions ?? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";"))
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
  return [...new Set(configured)];
}

async function spawnablePath(
  candidate: string,
  platform: NodeJS.Platform,
  pathApi: typeof path.win32 | typeof path.posix,
  forbiddenRoots: readonly string[],
): Promise<string | undefined> {
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return undefined;
    if (platform !== "win32") await fs.access(candidate, fs.constants.X_OK);
    const realCandidate = await fs.realpath(candidate);
    if (forbiddenRoots.some((root) => isPathInside(realCandidate, root, platform, pathApi))) {
      return undefined;
    }
    return realCandidate;
  } catch {
    return undefined;
  }
}

async function canonicalPath(value: string, pathApi: typeof path.win32 | typeof path.posix): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch {
    return pathApi.resolve(value);
  }
}

function isPathInside(
  candidate: string,
  root: string,
  platform: NodeJS.Platform,
  pathApi: typeof path.win32 | typeof path.posix,
): boolean {
  const normalizedCandidate = platform === "win32" ? candidate.toLowerCase() : candidate;
  const normalizedRoot = platform === "win32" ? root.toLowerCase() : root;
  const relative = pathApi.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relative)
  );
}

function stripSurroundingQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}
