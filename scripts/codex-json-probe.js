// Run `codex exec --json` against a small read-only prompt and pipe the
// stdout through the typed parser in src/codexEvents.ts (compiled). This
// exists to:
//   1. Verify the parser handles real Codex output, not just synthesized
//      JSON in unit tests.
//   2. Give a one-shot CLI you can run to confirm a Codex install is wired
//      up correctly: same `codex` binary that VS Code resolves, same
//      sandbox semantics Hydra uses, and -- now -- structured event
//      coverage including any new types Codex adds.
//
// Output lands under `.hydra/codex-json-probe/<timestamp>/`:
//   - prompt.txt              -- prompt that was sent
//   - stdout.jsonl            -- raw JSONL events from `codex exec --json`
//   - stderr.txt              -- raw stderr (codex auth / parse messages)
//   - summary.json            -- CodexThreadSummary as JSON
//   - summary.txt             -- formatCodexThreadSummary rendering
//
// Usage:
//   node scripts/codex-json-probe.js
//   node scripts/codex-json-probe.js --prompt "Explain the repo layout in 2 sentences."
//   node scripts/codex-json-probe.js --sandbox workspace-write
//   node scripts/codex-json-probe.js --timeout-ms 60000
//
// The probe defaults to `--sandbox read-only` so it's safe to run in any
// workspace; the agent gets read-only access only.

const cp = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const probeRoot = path.join(repoRoot, ".hydra", "codex-json-probe");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(probeRoot, runId);
const promptArg = readArg("--prompt");
const sandbox = readArg("--sandbox") || "read-only";
const timeoutMs = Number(readArg("--timeout-ms") || 90000);
const prompt = promptArg || [
  "Codex JSON probe.",
  "Reply with a single short sentence describing the cwd and current git branch.",
  "Do not edit files.",
].join(" ");

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

async function main() {
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, "prompt.txt"), prompt, "utf8");

  const command = resolveCommand("codex");
  if (!command) {
    console.error("codex CLI not found on PATH. Install it (npm i -g @openai/codex) or set hydraRoom.codexCommand.");
    process.exitCode = 1;
    return;
  }

  // The compiled parser lives at dist/src/codexEvents.js after `npm run compile`.
  // Fall back to a runtime ts-node-ish bootstrap if dist is missing.
  const codexEvents = await loadCodexEvents();

  const args = [
    "exec",
    "--json",
    "--sandbox", sandbox,
    "--color", "never",
    "--cd", repoRoot,
    "--skip-git-repo-check",
    "-",
  ];

  const started = Date.now();
  const result = await runProbe(command, args, prompt, timeoutMs);
  const durationMs = Date.now() - started;

  await fsp.writeFile(path.join(outDir, "stdout.jsonl"), result.stdout, "utf8");
  await fsp.writeFile(path.join(outDir, "stderr.txt"), result.stderr, "utf8");

  const events = codexEvents.parseCodexEventStream(result.stdout);
  const summary = codexEvents.summarizeCodexEvents(events);
  const rendered = codexEvents.formatCodexThreadSummary(summary);

  await fsp.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  await fsp.writeFile(path.join(outDir, "summary.txt"), rendered, "utf8");

  const meta = {
    runId,
    repoRoot,
    command,
    args,
    sandbox,
    timeoutMs,
    durationMs,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
    stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
    eventCount: events.length,
    malformedJsonLines: summary.malformedJsonLines,
    threadId: summary.threadId,
    turnsCompleted: summary.turns.completed,
  };
  await fsp.writeFile(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");

  console.log(rendered);
  console.log("");
  console.log(`Run artifacts: ${outDir}`);
  if (result.timedOut) console.log(`(timed out after ${timeoutMs}ms)`);
  if (result.exitCode !== 0) console.log(`(codex exited with ${result.exitCode})`);
}

async function loadCodexEvents() {
  const compiled = path.join(__dirname, "..", "dist", "src", "codexEvents.js");
  if (fs.existsSync(compiled)) return require(compiled);
  console.error(
    `Compiled parser not found at ${compiled}. Run \`npm run compile\` first.`
  );
  process.exitCode = 1;
  process.exit(1);
}

function runProbe(command, args, stdin, timeoutMsLocal) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // Node 20.12+ refuses to spawn .bat/.cmd without shell:true on Windows
    // (CVE-2024-27980 mitigation). Our args are fixed strings so the
    // shell-quoting risk is bounded; opt into shell mode on Windows for
    // .cmd/.bat shims.
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
  // Windows: prefer entries that already carry an executable extension.
  // child_process.spawn does NOT honor PATHEXT, so a bare "codex" path
  // (which is a shell-script shim) will fail with ENOENT.
  const executableExts = new Set([".exe", ".cmd", ".bat", ".com"]);
  const direct = candidates.find((c) => executableExts.has(path.extname(c).toLowerCase()));
  if (direct) return direct;
  // Fall back: try appending each PATHEXT to the bare candidate.
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
