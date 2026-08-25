import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { windowsSystemExecutable } from "./executablePath";
import { WINDOWS_PROCESS_TREE_JOB_BIND_TIMEOUT_MS } from "./processTreeBudgets";

const HOST_SPEC_ENV = "HYDRA_WINDOWS_PROCESS_TREE_HOST_V1";
const MAX_HOST_SPEC_BYTES = 256 * 1024;

interface HostSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly shell: boolean | string;
  readonly windowsVerbatimArguments: boolean;
  readonly stdinMode: "pipe" | "ignore" | "inherit";
  readonly electronRunAsNode: {
    readonly present: boolean;
    readonly value: string | null;
  };
}

function fail(message: string): never {
  process.stderr.write(`Hydra Windows process host: ${message}\n`);
  process.exit(125);
}

function parseSpec(): HostSpec {
  const encoded = process.env[HOST_SPEC_ENV];
  if (!encoded || Buffer.byteLength(encoded, "ascii") > MAX_HOST_SPEC_BYTES) {
    fail("missing or oversized launch specification");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    fail("malformed launch specification");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid launch specification");
  }
  const row = value as Record<string, unknown>;
  const exactKeys = [
    "args",
    "command",
    "cwd",
    "electronRunAsNode",
    "shell",
    "stdinMode",
    "windowsVerbatimArguments",
  ];
  const keys = Object.keys(row).sort();
  if (keys.length !== exactKeys.length
    || keys.some((key, index) => key !== exactKeys[index])) {
    fail("launch specification has unknown or missing fields");
  }
  const electron = row.electronRunAsNode;
  if (typeof row.command !== "string" || row.command.length === 0
    || row.command.length > 32_768
    || typeof row.cwd !== "string" || row.cwd.length === 0
    || row.cwd.length > 32_768
    || !Array.isArray(row.args) || row.args.length > 16_384
    || row.args.some((arg) => typeof arg !== "string" || arg.length > 131_072)
    || (typeof row.shell !== "boolean" && typeof row.shell !== "string")
    || (typeof row.shell === "string" && row.shell.length > 32_768)
    || typeof row.windowsVerbatimArguments !== "boolean"
    || !["pipe", "ignore", "inherit"].includes(String(row.stdinMode))
    || !electron || typeof electron !== "object" || Array.isArray(electron)) {
    fail("launch specification contains invalid values");
  }
  const electronRow = electron as Record<string, unknown>;
  if (Object.keys(electronRow).sort().join("\u0000") !== "present\u0000value"
    || typeof electronRow.present !== "boolean"
    || (electronRow.value !== null
      && typeof electronRow.value !== "string")) {
    fail("launch specification has an invalid Electron environment receipt");
  }
  return {
    command: row.command,
    args: row.args as string[],
    cwd: row.cwd,
    shell: row.shell as boolean | string,
    windowsVerbatimArguments: row.windowsVerbatimArguments,
    stdinMode: row.stdinMode as HostSpec["stdinMode"],
    electronRunAsNode: {
      present: electronRow.present,
      value: electronRow.value as string | null,
    },
  };
}

/**
 * Put this host into a dedicated Windows Job Object before it can start the
 * requested command. The out-of-job keeper owns the only job handle and
 * closes it when this host exits (or automatically when the keeper is
 * terminated). KILL_ON_JOB_CLOSE then terminates every inherited descendant,
 * including one created after an external PID snapshot began.
 */
async function bindSelfToKillOnCloseJob(): Promise<string> {
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class HydraKillOnCloseJob {",
    "  private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;",
    "  private const uint PROCESS_TERMINATE = 0x0001;",
    "  private const uint PROCESS_SET_QUOTA = 0x0100;",
    "  private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;",
    "  private const uint SYNCHRONIZE = 0x00100000;",
    "  private const uint WAIT_OBJECT_0 = 0x00000000;",
    "  private const uint INFINITE = 0xffffffff;",
    "  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {",
    "    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;",
    "    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;",
    "    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;",
    "  }",
    "  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS {",
    "    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;",
    "    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;",
    "  }",
    "  [StructLayout(LayoutKind.Sequential)] public struct FILETIME { public uint Low; public uint High; }",
    "  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {",
    "    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;",
    "    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;",
    "  }",
    "  [DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);",
    "  [DllImport(\"kernel32.dll\")] private static extern bool CloseHandle(IntPtr handle);",
    "  public static int BindAndWait(int processId) {",
    "    IntPtr job = CreateJobObjectW(IntPtr.Zero, null); if (job == IntPtr.Zero) return 10;",
    "    try {",
    "      var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();",
    "      info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;",
    "      if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) return 11;",
    "      IntPtr process = OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, processId);",
    "      if (process == IntPtr.Zero) return 12;",
    "      try {",
    "        if (!AssignProcessToJobObject(job, process)) return 13;",
    "        FILETIME creation, exit, kernel, user;",
    "        if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) return 15;",
    "        long identity = ((long)creation.High << 32) | creation.Low; if (identity <= 0) return 16;",
    "        Console.Out.WriteLine(identity.ToString()); Console.Out.WriteLine(\"READY\"); Console.Out.Flush();",
    "        return WaitForSingleObject(process, INFINITE) == WAIT_OBJECT_0 ? 0 : 14;",
    "      } finally { CloseHandle(process); }",
    "    } finally { CloseHandle(job); }",
    "  }",
    "}",
    "'@",
    `exit [HydraKillOnCloseJob]::BindAndWait(${process.pid})`,
  ].join("\n");

  return new Promise<string>((resolve, reject) => {
    let keeper: cp.ChildProcess;
    try {
      const keeperExecutable = windowsSystemExecutable("powershell.exe");
      keeper = cp.spawn(
        keeperExecutable,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          // The out-of-job keeper necessarily survives this host briefly while
          // it observes the host exit and closes the Job Object. Never let that
          // lifecycle tail pin an untrusted workspace as its Windows cwd.
          cwd: path.dirname(keeperExecutable),
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finishFailure = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { keeper.kill(); } catch { /* already closed */ }
      keeper.stdout?.destroy();
      keeper.stderr?.destroy();
      keeper.unref();
      reject(new Error(message));
    };
    const timeout = setTimeout(() => {
      finishFailure("timed out while binding the kill-on-close Job Object");
    }, WINDOWS_PROCESS_TREE_JOB_BIND_TIMEOUT_MS);
    keeper.stdout?.on("data", (chunk: Buffer | string) => {
      if (settled || stdout.length >= 64) return;
      stdout += (Buffer.isBuffer(chunk) ? chunk.toString("ascii") : chunk)
        .slice(0, 64 - stdout.length);
      const lineBreaks = stdout.match(/\n/gu)?.length ?? 0;
      if (lineBreaks < 2 && stdout.length < 64) return;
      const lines = stdout.trim().split(/\r?\n/u);
      const identity = lines[0] ?? "";
      if (lines.length !== 2
        || !/^[1-9][0-9]{0,18}$/u.test(identity)
        || lines[1] !== "READY") {
        finishFailure("received an invalid kill-on-close Job Object receipt");
        return;
      }
      settled = true;
      clearTimeout(timeout);
      // The keeper must outlive this host without keeping its Node event loop
      // alive. It performs no further I/O; its OS-owned job handle remains
      // live after these local pipe handles are released.
      keeper.stdout?.destroy();
      keeper.stderr?.destroy();
      keeper.on("error", () => {});
      keeper.unref();
      resolve(identity);
    });
    keeper.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length >= 512) return;
      stderr += (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk)
        .slice(0, 512 - stderr.length);
    });
    keeper.once("error", (error) => {
      finishFailure(`could not start the kill-on-close Job Object keeper: ${error.message}`);
    });
    keeper.once("close", (code) => {
      finishFailure(
        `kill-on-close Job Object keeper exited before readiness (${code ?? "unknown"})${
          stderr.trim() ? `: ${stderr.trim()}` : ""
        }`,
      );
    });
  });
}

function restoreTargetEnvironment(spec: HostSpec): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[HOST_SPEC_ENV];
  if (spec.electronRunAsNode.present) {
    env.ELECTRON_RUN_AS_NODE = spec.electronRunAsNode.value ?? "";
  } else {
    delete env.ELECTRON_RUN_AS_NODE;
  }
  return env;
}

async function main(): Promise<void> {
  if (process.platform !== "win32") fail("invoked on an unsupported platform");
  const spec = parseSpec();
  const identity = await bindSelfToKillOnCloseJob();

  // Descriptor 3 is a private one-shot receipt pipe. The host is necessarily
  // alive while it samples itself, and the kill-on-close job is bound before
  // this receipt, so the identity cannot belong to a reused or uncontained
  // process generation. Only after publishing it may the target start.
  fs.writeSync(3, `${identity}\n`, undefined, "ascii");

  let child: cp.ChildProcess;
  try {
    child = cp.spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: restoreTargetEnvironment(spec),
      shell: spec.shell,
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      stdio: [spec.stdinMode === "ignore" ? "ignore" : "pipe", "pipe", "pipe"],
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (spec.stdinMode !== "ignore" && child.stdin) {
    process.stdin.pipe(child.stdin);
    child.stdin.on("error", () => {});
  }
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  let receiptClosed = false;
  const closeReceipt = () => {
    if (receiptClosed) return;
    receiptClosed = true;
    fs.closeSync(3);
  };
  child.once("spawn", () => {
    fs.writeSync(3, "READY\n", undefined, "ascii");
    closeReceipt();
  });
  let targetSpawnFailed = false;
  child.once("error", (error) => {
    targetSpawnFailed = true;
    closeReceipt();
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 125;
  });
  child.once("close", (code) => {
    closeReceipt();
    process.stdin.unpipe(child.stdin ?? undefined);
    process.stdin.pause();
    process.exitCode = targetSpawnFailed ? 125 : code ?? 1;
  });
}

void main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
