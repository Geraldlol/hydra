import * as cp from "node:child_process";
import * as path from "node:path";
import { runArenaGitCommand } from "./arenaGit";
import {
  resolveGitExecutable,
  workspaceGitExecutionAllowed,
} from "./gitExecutable";

export interface ArenaLongPathDiagnostics {
  readonly platform: NodeJS.Platform;
  readonly windowsRegistryEnabled: boolean | null;
  readonly gitCoreLongpathsEnabled: boolean | null;
  readonly hydraGitOverrideEnabled: true;
  readonly conservativePreflightEnabled: true;
}

export async function probeArenaLongPaths(
  workspaceRoot: string,
): Promise<ArenaLongPathDiagnostics> {
  if (process.platform !== "win32") {
    return {
      platform: process.platform,
      windowsRegistryEnabled: null,
      gitCoreLongpathsEnabled: null,
      hydraGitOverrideEnabled: true,
      conservativePreflightEnabled: true,
    };
  }
  const [windowsRegistryEnabled, gitCoreLongpathsEnabled] =
    await Promise.all([
      probeWindowsRegistry(),
      probeGitLongpaths(workspaceRoot),
    ]);
  return {
    platform: "win32",
    windowsRegistryEnabled,
    gitCoreLongpathsEnabled,
    hydraGitOverrideEnabled: true,
    conservativePreflightEnabled: true,
  };
}

async function probeGitLongpaths(
  workspaceRoot: string,
): Promise<boolean | null> {
  if (!workspaceGitExecutionAllowed()) return null;
  const git = await resolveGitExecutable(workspaceRoot);
  if (!git) return null;
  try {
    const result = await runArenaGitCommand(
      git,
      workspaceRoot,
      ["config", "--get", "core.longpaths"],
      {
        allowedExitCodes: [0, 1],
        timeoutMs: 5_000,
        maxStdoutBytes: 4_096,
        maxStderrBytes: 4_096,
      },
    );
    if (result.exitCode === 1) return null;
    return parseBoolean(result.stdout.toString("utf8").trim());
  } catch {
    return null;
  }
}

async function probeWindowsRegistry(): Promise<boolean | null> {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) return null;
  const command = path.win32.join(systemRoot, "System32", "reg.exe");
  try {
    const output = await runProbe(command, [
      "query",
      "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem",
      "/v",
      "LongPathsEnabled",
    ]);
    const match = output.match(
      /LongPathsEnabled\s+REG_DWORD\s+0x([0-9a-f]+)/iu,
    );
    if (!match) return null;
    return Number.parseInt(match[1]!, 16) !== 0;
  } catch {
    return null;
  }
}

function runProbe(
  command: string,
  args: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile(
      command,
      [...args],
      {
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 8 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

function parseBoolean(value: string): boolean | null {
  if (/^(?:true|yes|on|1)$/iu.test(value)) return true;
  if (/^(?:false|no|off|0)$/iu.test(value)) return false;
  return null;
}
