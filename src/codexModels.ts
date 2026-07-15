import * as cp from "node:child_process";
import { isWindowsBatchCommand, spawnViaCmdShim, terminateProcessTree } from "./agents";
import { atomicWriteFile, readFileHead } from "./fileQueue";

export const MAX_CODEX_DEBUG_MODELS_STDOUT_BYTES = 8 * 1024 * 1024;
export const MAX_CODEX_DEBUG_MODELS_STDERR_BYTES = 64 * 1024;
export const MAX_CODEX_MODELS_SNAPSHOT_BYTES = 4 * 1024 * 1024;

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

export class CodexModelsTerminationError extends Error {
  readonly terminationFailed = true;

  constructor(message: string) {
    super(message);
    this.name = "CodexModelsTerminationError";
  }
}

export function isCodexModelsTerminationError(value: unknown): value is CodexModelsTerminationError {
  return value instanceof CodexModelsTerminationError || (
    value instanceof Error &&
    (value as Error & { terminationFailed?: unknown }).terminationFailed === true
  );
}

/**
 * Parse the JSON output of `codex debug models`. The CLI emits a single
 * object `{ "models": [...] }` where each model carries metadata including
 * the multi-kilobyte `base_instructions` and `availability_nux` blobs that
 * we deliberately drop — Hydra only needs the picker-relevant fields.
 */
export function parseCodexDebugModels(stdout: string): CodexModelInfo[] {
  try {
    return parseCodexDebugModelsStrict(stdout);
  } catch {
    return [];
  }
}

function parseCodexDebugModelsStrict(stdout: string): CodexModelInfo[] {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("codex debug models returned empty output");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error("codex debug models returned invalid JSON", { cause: err });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("codex debug models returned an invalid response object");
  }
  const list = (parsed as { models?: unknown }).models;
  if (!Array.isArray(list)) {
    throw new Error("codex debug models response is missing a models array");
  }
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
 * Spawn `codex debug models` and return parsed model info. Captures bounded
 * stdout/stderr; rejects on overflow, non-zero exit, missing executable, or
 * an invalid response. Caller is responsible for surfacing errors to the user.
 */
export function runCodexDebugModels(command: string, env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<CodexModelInfo[]> {
  return new Promise((resolve, reject) => {
    let child: cp.ChildProcess;
    try {
      child = spawnCodexChild(command, ["debug", "models"], env);
    } catch (err) {
      reject(err);
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let forceBackstop: NodeJS.Timeout | undefined;
    let failureBackstop: NodeJS.Timeout | undefined;
    let pendingTerminationError: Error | undefined;
    const clearTimers = (): void => {
      if (timer) clearTimeout(timer);
      if (forceBackstop) clearTimeout(forceBackstop);
      if (failureBackstop) clearTimeout(failureBackstop);
    };
    const finishWithError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    };
    const beginTermination = (error: Error): void => {
      if (settled || pendingTerminationError) return;
      pendingTerminationError = error;
      void terminateProcessTree(child, false);
      forceBackstop = setTimeout(() => {
        void terminateProcessTree(child, true);
        failureBackstop = setTimeout(() => {
          finishWithError(new CodexModelsTerminationError(
            `${error.message}; Hydra did not observe the model-discovery process close and it may still be running. Restart VS Code before starting more Hydra work.`
          ));
        }, 1_000);
      }, 1_000);
    };
    const capture = (
      chunk: Buffer | string,
      chunks: Buffer[],
      currentBytes: number,
      maxBytes: number,
      label: "stdout" | "stderr"
    ): number => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      const nextBytes = currentBytes + buffer.byteLength;
      if (nextBytes > maxBytes) {
        beginTermination(new Error(`codex debug models ${label} exceeded the ${maxBytes}-byte limit`));
        return currentBytes;
      }
      chunks.push(buffer);
      return nextBytes;
    };

    timer = setTimeout(() => {
      beginTermination(new Error(`codex debug models timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (!settled) {
        stdoutBytes = capture(chunk, stdoutChunks, stdoutBytes, MAX_CODEX_DEBUG_MODELS_STDOUT_BYTES, "stdout");
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (!settled) {
        stderrBytes = capture(chunk, stderrChunks, stderrBytes, MAX_CODEX_DEBUG_MODELS_STDERR_BYTES, "stderr");
      }
    });
    child.on("error", (err) => {
      finishWithError(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (pendingTerminationError) {
        reject(pendingTerminationError);
        return;
      }
      const stderr = Buffer.concat(stderrChunks, stderrBytes).toString("utf8");
      if (code !== 0) {
        reject(new Error(`codex debug models exited with code ${code ?? "unknown"}${stderr ? `: ${stderr.trim().slice(0, 500)}` : ""}`));
        return;
      }
      try {
        const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8");
        resolve(parseCodexDebugModelsStrict(stdout));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

/**
 * Spawn a Codex child process, wrapping .cmd/.bat shims through cmd.exe
 * via the shared spawnViaCmdShim helper (see agents.ts).
 */
function spawnCodexChild(command: string, args: string[], env: NodeJS.ProcessEnv): cp.ChildProcess {
  if (isWindowsBatchCommand(command)) {
    return spawnViaCmdShim(command, args, {
      env,
      windowsHide: true,
    });
  }
  return cp.spawn(command, args, {
    env,
    windowsHide: true,
    shell: false,
    detached: process.platform !== "win32",
  });
}

export async function loadCodexModelsSnapshot(filePath: string): Promise<CodexModelsSnapshot | undefined> {
  try {
    const bounded = await readFileHead(filePath, MAX_CODEX_MODELS_SNAPSHOT_BYTES);
    if (bounded.truncated) return undefined;
    const parsed = JSON.parse(bounded.text);
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { models?: unknown }).models)) return undefined;
    return parsed as CodexModelsSnapshot;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

export async function saveCodexModelsSnapshot(filePath: string, snapshot: CodexModelsSnapshot): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`);
}
