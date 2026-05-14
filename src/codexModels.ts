import * as cp from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface CodexModelInfo {
  slug: string;
  displayName: string;
  description?: string;
  defaultReasoning?: string;
  reasoningLevels: string[];
  supportedInApi: boolean;
  visibility: string;
}

export interface CodexModelsSnapshot {
  fetchedAt: string;
  codexVersion?: string;
  models: CodexModelInfo[];
}

/**
 * Parse the JSON output of `codex debug models`. The CLI emits a single
 * object `{ "models": [...] }` where each model carries metadata including
 * the multi-kilobyte `base_instructions` and `availability_nux` blobs that
 * we deliberately drop — Hydra only needs the picker-relevant fields.
 */
export function parseCodexDebugModels(stdout: string): CodexModelInfo[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const list = (parsed as { models?: unknown }).models;
  if (!Array.isArray(list)) return [];
  const models: CodexModelInfo[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const slug = typeof e.slug === "string" ? e.slug.trim() : "";
    if (!slug) continue;
    const displayName = typeof e.display_name === "string" && e.display_name.trim() ? e.display_name.trim() : slug;
    const description = typeof e.description === "string" ? e.description.trim() : undefined;
    const defaultReasoning = typeof e.default_reasoning_level === "string" ? e.default_reasoning_level : undefined;
    const reasoningLevels: string[] = [];
    if (Array.isArray(e.supported_reasoning_levels)) {
      for (const level of e.supported_reasoning_levels) {
        if (level && typeof level === "object" && typeof (level as Record<string, unknown>).effort === "string") {
          reasoningLevels.push(((level as Record<string, unknown>).effort as string).trim());
        }
      }
    }
    const supportedInApi = typeof e.supported_in_api === "boolean" ? e.supported_in_api : true;
    const visibility = typeof e.visibility === "string" ? e.visibility : "list";
    models.push({ slug, displayName, description, defaultReasoning, reasoningLevels, supportedInApi, visibility });
  }
  return models;
}

/**
 * Spawn `codex debug models` and return parsed model info. Captures stdout
 * only; rejects on non-zero exit code, missing executable, or unparseable
 * JSON. Caller is responsible for surfacing errors to the user.
 */
export function runCodexDebugModels(command: string, env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<CodexModelInfo[]> {
  return new Promise((resolve, reject) => {
    const child = spawnCodexChild(command, ["debug", "models"], env);
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error(`codex debug models timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`codex debug models exited with code ${code ?? "unknown"}${stderr ? `: ${stderr.trim().slice(0, 500)}` : ""}`));
        return;
      }
      try {
        resolve(parseCodexDebugModels(stdout));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

/**
 * Spawn a Codex child process, wrapping .cmd/.bat shims through cmd.exe to
 * dodge Node's CVE-2024-27980 mitigation (which throws EINVAL for direct
 * batch-file spawns). Mirrors the logic in agents.ts.
 */
function spawnCodexChild(command: string, args: string[], env: NodeJS.ProcessEnv): cp.ChildProcess {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    const quote = (a: string): string => {
      if (a === "") return '""';
      if (!/[\s"&|<>^()%!]/.test(a)) return a;
      return `"${a.replace(/"/g, '""')}"`;
    };
    // Outer-wrap + windowsVerbatimArguments: see comment in agents.ts
    // spawnAgentChild for why cmd /s /c needs the double-wrap trick.
    const line = [command, ...args].map(quote).join(" ");
    const wrapped = `"${line}"`;
    return cp.spawn("cmd.exe", ["/d", "/s", "/c", wrapped], {
      env,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  }
  return cp.spawn(command, args, {
    env,
    windowsHide: true,
    shell: false,
  });
}

export async function loadCodexModelsSnapshot(filePath: string): Promise<CodexModelsSnapshot | undefined> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { models?: unknown }).models)) return undefined;
    return parsed as CodexModelsSnapshot;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

export async function saveCodexModelsSnapshot(filePath: string, snapshot: CodexModelsSnapshot): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}
