const cp = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

// scripts/ is a direct child of the repository root. Keep probe artifacts and
// every agent cwd scoped to this checkout -- walking three levels up would
// target the user's home hierarchy instead.
const repoRoot = path.resolve(__dirname, "..");
const hydraDir = path.join(repoRoot, ".hydra", "native-contract-probe");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(hydraDir, runId);
const execute = process.argv.includes("--execute");
const promptArg = readArg("--prompt");
const timeoutMs = Number(readArg("--timeout-ms") || 180000);
const prompt = promptArg || [
  "Native contract probe.",
  "Use your available CLI/tooling if allowed to inspect the current working directory and git status.",
  "Do not edit files. Do not commit. Do not ask follow-up questions.",
  "Reply with: CONTRACT_PROBE, the cwd you observed, whether you used tools/commands, and any permission or sandbox limits you hit.",
].join(" ");

const probes = [
  {
    id: "codex-version",
    agent: "codex",
    command: "codex",
    args: ["--version"],
    stdin: "",
    kind: "metadata",
  },
  {
    id: "codex-help",
    agent: "codex",
    command: "codex",
    args: ["--help"],
    stdin: "",
    kind: "metadata",
  },
  {
    id: "claude-version",
    agent: "claude",
    command: "claude",
    args: ["--version"],
    stdin: "",
    kind: "metadata",
  },
  {
    id: "claude-help",
    agent: "claude",
    command: "claude",
    args: ["--help"],
    stdin: "",
    kind: "metadata",
  },
  {
    id: "codex-hydra-discussion-default",
    agent: "codex",
    command: "codex",
    args: ["exec", "--sandbox", "workspace-write", "--color", "never", "--cd", repoRoot, "-"],
    stdin: prompt,
    kind: "agent",
  },
  {
    // `--ask-for-approval` is the TUI root flag (`codex` interactive); it is
    // NOT valid on `codex exec`. The exec-equivalent of "never ask" is
    // `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`), which
    // also disables the sandbox -- so an explicit `--sandbox danger-full-access`
    // is redundant. See docs/native-internals/codex-wire-protocol.md.
    id: "codex-direct-danger-never",
    agent: "codex",
    command: "codex",
    args: ["exec", "--dangerously-bypass-approvals-and-sandbox", "--color", "never", "--cd", repoRoot, "-"],
    stdin: prompt,
    kind: "agent",
  },
  {
    id: "claude-hydra-discussion-default",
    agent: "claude",
    command: "claude",
    args: ["-p", "--permission-mode", "acceptEdits", "--add-dir", repoRoot],
    stdin: prompt,
    kind: "agent",
  },
  {
    id: "claude-direct-bypass-print",
    agent: "claude",
    command: "claude",
    args: ["-p", "--permission-mode", "bypassPermissions", "--add-dir", repoRoot],
    stdin: prompt,
    kind: "agent",
  },
  {
    id: "claude-stream-json-accept-edits",
    agent: "claude",
    command: "claude",
    args: ["-p", "--permission-mode", "acceptEdits", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--add-dir", repoRoot],
    stdin: prompt,
    kind: "agent",
  },
];

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

async function main() {
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "prompt.txt"), prompt, "utf8");

  const selected = execute ? probes : probes.filter((probe) => probe.kind === "metadata");
  const results = [];
  for (const probe of selected) {
    const resolved = resolveCommand(probe.command);
    const record = {
      id: probe.id,
      agent: probe.agent,
      kind: probe.kind,
      command: resolved || probe.command,
      args: probe.args,
      cwd: repoRoot,
      stdinChars: probe.stdin.length,
      stdinSha256: sha256(probe.stdin),
      timeoutMs,
      startedAt: new Date().toISOString(),
      skipped: !resolved,
    };
    if (!resolved) {
      record.error = `Command not found: ${probe.command}`;
      results.push(record);
      continue;
    }

    const result = await runProbe({ ...probe, command: resolved }, timeoutMs);
    const stdoutPath = path.join(outDir, `${probe.id}.stdout.txt`);
    const stderrPath = path.join(outDir, `${probe.id}.stderr.txt`);
    await fsp.writeFile(stdoutPath, result.stdout, "utf8");
    await fsp.writeFile(stderrPath, result.stderr, "utf8");
    results.push({
      ...record,
      completedAt: new Date().toISOString(),
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdoutChars: result.stdout.length,
      stderrChars: result.stderr.length,
      stdoutPath,
      stderrPath,
      stdoutPreview: preview(result.stdout),
      stderrPreview: preview(result.stderr),
    });
  }

  const report = {
    runId,
    repoRoot,
    node: process.version,
    platform: `${process.platform} ${os.release()}`,
    execute,
    promptPath: path.join(outDir, "prompt.txt"),
    resultPath: path.join(outDir, "report.json"),
    probes: results,
    manualInteractiveChecks: [
      `codex --cd ${quote(repoRoot)}`,
      `claude --add-dir ${quote(repoRoot)}`,
      "Compare whether interactive sessions continue context, ask permission, and perform tools differently from the one-shot probes.",
    ],
  };
  await fsp.writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "report.md"), renderMarkdown(report), "utf8");
  console.log(`Native contract probe written to ${outDir}`);
  if (!execute) {
    console.log("Metadata-only run complete. Re-run with --execute to call Codex/Claude agent prompts.");
  }
}

function runProbe(probe, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = cp.spawn(probe.command, probe.args, {
      cwd: repoRoot,
      windowsHide: true,
      env: { ...process.env },
      shell: isWindowsCommandScript(probe.command),
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {}
      if (process.platform === "win32" && child.pid) {
        cp.spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += stripAnsi(chunk.toString("utf8"))));
    child.stderr.on("data", (chunk) => (stderr += stripAnsi(chunk.toString("utf8"))));
    child.on("error", (err) => {
      stderr += `${stderr ? "\n" : ""}${err.message}`;
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut, durationMs: Date.now() - started });
    });
    if (probe.stdin && child.stdin && !child.stdin.destroyed) {
      child.stdin.on("error", () => {});
      child.stdin.write(probe.stdin);
      child.stdin.end();
    }
  });
}

function isWindowsCommandScript(command) {
  if (process.platform !== "win32") return false;
  return /\.(cmd|bat)$/i.test(command);
}

function resolveCommand(command) {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const result = cp.spawnSync(lookup, [command], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return "";
  const candidates = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (process.platform !== "win32") return candidates.find(Boolean) || "";
  const resolved = candidates.map(resolveWindowsCandidate).filter(Boolean);
  return resolved.find((candidate) => /\.exe$/i.test(candidate))
    || resolved.find((candidate) => /\.(cmd|bat|com)$/i.test(candidate))
    || resolved[0]
    || "";
}

function resolveWindowsCandidate(candidate) {
  if (path.extname(candidate)) return fs.existsSync(candidate) ? candidate : "";
  const pathext = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  for (const ext of pathext) {
    const withExt = `${candidate}${ext.toLowerCase()}`;
    if (fs.existsSync(withExt)) return withExt;
    const upper = `${candidate}${ext.toUpperCase()}`;
    if (fs.existsSync(upper)) return upper;
  }
  if (fs.existsSync(candidate)) return candidate;
  return "";
}

function renderMarkdown(report) {
  const rows = report.probes.map((probe) => [
    probe.id,
    probe.skipped ? "skipped" : String(probe.exitCode),
    probe.timedOut ? "yes" : "no",
    String(probe.durationMs ?? ""),
    String(probe.stdoutChars ?? 0),
    String(probe.stderrChars ?? 0),
  ]);
  return [
    "# Native Contract Probe",
    "",
    `Run: ${report.runId}`,
    `Workspace: ${report.repoRoot}`,
    `Executed agent prompts: ${report.execute ? "yes" : "no"}`,
    `Prompt: ${report.promptPath}`,
    "",
    "| Probe | Exit | Timed out | Duration ms | Stdout chars | Stderr chars |",
    "|---|---:|---:|---:|---:|---:|",
    ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
    "",
    "## Manual Interactive Checks",
    "",
    ...report.manualInteractiveChecks.map((line) => `- \`${line}\``),
    "",
    "## Notes",
    "",
    "- Full stdout/stderr files live next to this report.",
    "- The prompt hash lets this report be compared to Hydra `.hydra/agent-calls.jsonl` records.",
  ].join("\n");
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function preview(value) {
  const trimmed = value.trim();
  return trimmed.length <= 1200 ? trimmed : `${trimmed.slice(0, 1200)}\n[truncated ${trimmed.length - 1200} chars]`;
}

function quote(value) {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|");
}

const ANSI_RE = /\x1B(?:[\]PX^_][^\x07\x1B]*(?:\x07|\x1B\\)|\[[0-?]*[ -\/]*[@-~]|[@-Z\\-_])/g;
function stripAnsi(value) {
  return value.replace(ANSI_RE, "");
}
