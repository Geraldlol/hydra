// Run `claude -p --output-format stream-json --verbose` against a small
// read-only prompt and pipe stdout through the typed parser in
// src/claudeEvents.ts (compiled). Parallel to scripts/codex-json-probe.js.
//
// Purposes:
//   1. Verify the parser handles real Claude output, not just synthesized
//      JSON in unit tests.
//   2. One-shot diagnostic: does the configured `claude` binary launch?
//      Is auth working? What tools, MCP servers, plugins, skills, and
//      slash_commands does this session resolve? The `system / init`
//      envelope answers all of that without a model call.
//
// Output lands under `.hydra/claude-stream-json-probe/<timestamp>/`:
//   - prompt.txt              prompt that was sent
//   - stdout.jsonl            raw JSONL from claude
//   - stderr.txt              raw stderr (auth / hook failures land here)
//   - summary.json            ClaudeStreamSummary as JSON
//   - summary.txt             formatClaudeStreamSummary rendering
//   - meta.json               run metadata (exit code, duration, etc.)
//
// Usage:
//   node scripts/claude-stream-json-probe.js
//   node scripts/claude-stream-json-probe.js --prompt "Reply with one word: hello."
//   node scripts/claude-stream-json-probe.js --permission-mode plan
//   node scripts/claude-stream-json-probe.js --timeout-ms 60000
//
// Defaults to `--permission-mode plan` so the agent has read-only access.

const cp = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const probeRoot = path.join(repoRoot, ".hydra", "claude-stream-json-probe");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(probeRoot, runId);
const promptArg = readArg("--prompt");
const permissionMode = readArg("--permission-mode") || "plan";
const timeoutMs = Number(readArg("--timeout-ms") || 120000);
const prompt = promptArg || [
  "Claude stream-json probe.",
  "Reply with exactly one word: ready.",
  "Do not call any tools or edit any files.",
].join(" ");

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

async function main() {
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "prompt.txt"), prompt, "utf8");

  const command = resolveCommand("claude");
  if (!command) {
    console.error(
      "claude CLI not found on PATH. Install Claude Code or set hydraRoom.claudeCommand to a full path."
    );
    process.exitCode = 1;
    return;
  }

  const claudeEvents = loadClaudeEvents();

  const args = [
    "-p",
    "--permission-mode", permissionMode,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--add-dir", repoRoot,
  ];

  const started = Date.now();
  const result = await runProbe(command, args, prompt, timeoutMs);
  const durationMs = Date.now() - started;

  await fsp.writeFile(path.join(outDir, "stdout.jsonl"), result.stdout, "utf8");
  await fsp.writeFile(path.join(outDir, "stderr.txt"), result.stderr, "utf8");

  const events = claudeEvents.parseClaudeEventStream(result.stdout);
  const summary = claudeEvents.summarizeClaudeEvents(events);
  const rendered = claudeEvents.formatClaudeStreamSummary(summary);

  await fsp.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "summary.txt"), rendered, "utf8");

  const meta = {
    runId,
    repoRoot,
    command,
    args,
    permissionMode,
    timeoutMs,
    durationMs,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
    stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
    eventCount: events.length,
    malformedJsonLines: summary.malformedJsonLines,
    sessionId: summary.sessionId,
    resultSubtype: summary.resultSubtype,
  };
  await fsp.writeFile(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");

  console.log(rendered);
  console.log("");
  console.log(`Run artifacts: ${outDir}`);
  if (result.timedOut) console.log(`(timed out after ${timeoutMs}ms)`);
  if (result.exitCode !== 0) console.log(`(claude exited with ${result.exitCode})`);
}

function loadClaudeEvents() {
  const compiled = path.join(__dirname, "..", "dist", "src", "claudeEvents.js");
  if (fs.existsSync(compiled)) return require(compiled);
  console.error(`Compiled parser not found at ${compiled}. Run \`npm run compile\` first.`);
  process.exitCode = 1;
  process.exit(1);
}

function runProbe(command, args, stdin, timeoutMsLocal) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // Same Node 20.12+ .bat/.cmd safety dance as codex-json-probe.js.
    const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
    const child = cp.spawn(command, args, {
      cwd: repoRoot,
      windowsHide: true,
      env: { ...process.env },
      shell: useShell,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch {}
      if (process.platform === "win32" && child.pid) {
        cp.spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
      }
    }, timeoutMsLocal);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", (err) => {
      stderr += `${stderr ? "\n" : ""}${err.message}`;
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    });
    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.on("error", () => {});
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

function resolveCommand(command) {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const result = cp.spawnSync(lookup, [command], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return "";
  const candidates = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (process.platform !== "win32") return candidates[0] || "";
  const executableExts = new Set([".exe", ".cmd", ".bat", ".com"]);
  const direct = candidates.find((c) => executableExts.has(path.extname(c).toLowerCase()));
  if (direct) return direct;
  const pathext = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  for (const candidate of candidates) {
    if (path.extname(candidate)) continue;
    for (const ext of pathext) {
      const withExt = `${candidate}${ext}`;
      if (fs.existsSync(withExt)) return withExt;
    }
  }
  return candidates[0] || "";
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}
