import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  argsSettingKey,
  applySpawnEnvironment,
  assertPhaseAuthority,
  buildAgentSpawn,
  expandRequestFileArgs,
  expandRequestFileSpawn,
  expandWorkspaceArgs,
  hasRequestFilePlaceholders,
  knownAgentExecutableCandidates,
  mergeNativeEnv,
  mergeNativePathPrepend,
  nativeCapabilitySummary,
  profileForPhase,
  resolveAgentCommand,
  shouldUseKnownAgentFallback,
  splitNativeArgs,
} from "../src/cli";

describe("Hydra CLI bridge", () => {
  test("maps phases onto native CLI profiles", () => {
    assert.equal(profileForPhase("opener"), "discussion");
    assert.equal(profileForPhase("reactor"), "discussion");
    assert.equal(profileForPhase("closer"), "discussion");
    assert.equal(profileForPhase("parallel"), "discussion");
    assert.equal(profileForPhase("build"), "build");
    assert.equal(profileForPhase("review"), "review");
  });

  test("builds per-agent settings keys for each profile", () => {
    assert.equal(argsSettingKey("codex", "opener"), "codexExecArgsDiscussion");
    assert.equal(argsSettingKey("claude", "reactor"), "claudeExecArgsDiscussion");
    assert.equal(argsSettingKey("codex", "closer"), "codexExecArgsDiscussion");
    assert.equal(argsSettingKey("claude", "parallel"), "claudeExecArgsDiscussion");
    assert.equal(argsSettingKey("codex", "build"), "codexExecArgsBuild");
    assert.equal(argsSettingKey("claude", "review"), "claudeExecArgsReview");
  });

  test("expands workspace placeholders without interpreting native args", () => {
    assert.deepEqual(
      expandWorkspaceArgs(["exec", "--cd", "${workspaceFolder}", "-c", "model=\"x\""], "C:\\workspaces\\hydra"),
      ["exec", "--cd", "C:\\workspaces\\hydra", "-c", "model=\"x\""]
    );
  });

  test("applies native env and PATH prepend to spawns", () => {
    const spawn = applySpawnEnvironment(
      { command: "codex", args: ["exec"], cwd: "C:\\repo" },
      "C:\\repo",
      { DOTNET_ROOT: "${env:USERPROFILE}\\.dotnet", HYDRA_ROOT: "${workspaceFolder}" },
      ["${env:USERPROFILE}\\.dotnet", "${workspaceFolder}\\bin"]
    );
    assert.equal(spawn.env?.HYDRA_ROOT, "C:\\repo");
    assert.match(spawn.env?.DOTNET_ROOT ?? "", /\\.dotnet$/);
    const pathValue = spawn.env?.Path ?? spawn.env?.PATH ?? "";
    assert.match(pathValue, /\\.dotnet/);
    assert.match(pathValue, /C:\\repo\\bin/);
  });

  test("merges shared and agent-specific native environment settings", () => {
    assert.deepEqual(
      mergeNativeEnv(
        { SHARED: "1", MODEL_HOME: "C:\\shared" },
        { MODEL_HOME: "C:\\codex", CODEX_ONLY: "yes" }
      ),
      { SHARED: "1", MODEL_HOME: "C:\\codex", CODEX_ONLY: "yes" }
    );
    assert.deepEqual(
      mergeNativePathPrepend(["C:\\shared"], ["C:\\codex", "C:\\codex\\bin"]),
      ["C:\\shared", "C:\\codex", "C:\\codex\\bin"]
    );
  });

  test("expands per-request Hydra file placeholders for native CLI args", () => {
    const files = {
      hydraPromptFile: "C:\\repo\\.hydra\\prompts\\p.md",
      hydraReplyFile: "C:\\repo\\.hydra\\replies\\r.json",
      hydraLogFile: "C:\\repo\\.hydra\\logs\\r.log",
    };
    assert.deepEqual(
      expandRequestFileArgs(
        ["exec", "--file", "${hydraPromptFile}", "--output-last-message", "${hydraReplyFile}", "--log=${hydraLogFile}"],
        files
      ),
      ["exec", "--file", files.hydraPromptFile, "--output-last-message", files.hydraReplyFile, `--log=${files.hydraLogFile}`]
    );

    const spawn = { command: "${hydraPromptFile}", args: ["--out", "${hydraReplyFile}"], cwd: "C:\\repo" };
    assert.equal(hasRequestFilePlaceholders(spawn), true);
    assert.deepEqual(expandRequestFileSpawn(spawn, files), {
      command: files.hydraPromptFile,
      args: ["--out", files.hydraReplyFile],
      cwd: "C:\\repo",
    });
    assert.equal(hasRequestFilePlaceholders({ command: "codex", args: ["exec", "-"], cwd: "C:\\repo" }), false);
  });

  test("splits native arg lines for exact subcommand actions", () => {
    assert.deepEqual(splitNativeArgs("doctor"), ["doctor"]);
    assert.deepEqual(splitNativeArgs("mcp list --config \"C:\\Program Files\\mcp.json\""), [
      "mcp",
      "list",
      "--config",
      "C:\\Program Files\\mcp.json",
    ]);
    assert.deepEqual(splitNativeArgs("exec --model 'gpt-5.4' --cd ${workspaceFolder} -"), [
      "exec",
      "--model",
      "gpt-5.4",
      "--cd",
      "${workspaceFolder}",
      "-",
    ]);
  });

  test("builds a spawn while preserving arbitrary native CLI flags", () => {
    const spawn = buildAgentSpawn(
      "codex",
      "build",
      "codex-nightly",
      ["exec", "--sandbox", "workspace-write", "--search", "--cd", "${workspaceFolder}", "-"],
      "C:\\repo"
    );
    assert.equal(spawn.command, "codex-nightly");
    assert.equal(spawn.cwd, "C:\\repo");
    assert.deepEqual(spawn.args, ["exec", "--sandbox", "workspace-write", "--search", "--cd", "C:\\repo", "-"]);
  });

  test("allows native Codex review command in Review", () => {
    assert.doesNotThrow(() => assertPhaseAuthority("codex", "review", ["review", "--uncommitted", "-"]));
    assert.doesNotThrow(() => assertPhaseAuthority("codex", "review", ["--color", "never", "review", "--uncommitted", "-"]));
  });

  test("does not downgrade native authority outside Build", () => {
    assert.doesNotThrow(() =>
      assertPhaseAuthority("codex", "opener", ["exec", "--sandbox=workspace-write", "--cd", "${workspaceFolder}", "-"])
    );
    assert.doesNotThrow(() =>
      assertPhaseAuthority("claude", "review", ["-p", "--permission-mode=acceptEdits", "--add-dir", "${workspaceFolder}"])
    );
    assert.doesNotThrow(() =>
      assertPhaseAuthority("codex", "reactor", ["exec", "--dangerously-bypass-approvals-and-sandbox", "-"])
    );
    assert.doesNotThrow(() =>
      assertPhaseAuthority("claude", "opener", ["-p", "--permission-mode", "acceptEdits", "--", "--dangerously-skip-permissions"])
    );
  });

  test("allows unknown/custom native args so CLI parity is preserved", () => {
    assert.doesNotThrow(() => assertPhaseAuthority("claude", "opener", ["-p"]));
    assert.doesNotThrow(() =>
      assertPhaseAuthority("codex", "build", ["exec", "--cd", "${workspaceFolder}", "-"])
    );
    assert.doesNotThrow(() => assertPhaseAuthority("claude", "review", []));

    const spawn = buildAgentSpawn(
      "codex",
      "build",
      "codex",
      ["exec", "--cd", "${workspaceFolder}", "--new-native-flag", "-"],
      "C:\\repo"
    );
    assert.deepEqual(spawn.args, ["exec", "--cd", "C:\\repo", "--new-native-flag", "-"]);
  });

  test("falls back to agent executable name when command is blank", () => {
    const spawn = buildAgentSpawn("claude", "build", "", ["-p", "--permission-mode", "acceptEdits"], "C:\\repo");
    assert.equal(spawn.command, "claude");
  });

  test("leaves explicit executable paths untouched", async () => {
    const command = "C:\\Tools\\codex.exe";
    assert.equal(await resolveAgentCommand("codex", command), command);
  });

  test("discovers Windows Codex fallbacks outside PATH", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-cli-"));
    const home = path.join(root, "home");
    const appData = path.join(root, "roaming");
    const localAppData = path.join(root, "local");
    await fs.mkdir(
      path.join(home, ".vscode", "extensions", "openai.chatgpt-26.429.30905-win32-x64"),
      { recursive: true }
    );
    await fs.mkdir(
      path.join(home, ".vscode", "extensions", "openai.chatgpt-26.506.21252-win32-x64"),
      { recursive: true }
    );
    await fs.mkdir(path.join(localAppData, "Packages", "OpenAI.Codex_test"), { recursive: true });

    const candidates = await knownAgentExecutableCandidates("codex", {
      USERPROFILE: home,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
    }, "win32");

    const extensionCandidates = candidates.filter((candidate) => candidate.includes(".vscode"));
    assert.match(extensionCandidates[0]!, /openai\.chatgpt-26\.506\.21252-win32-x64/);
    assert.ok(candidates.includes(path.join(appData, "npm", "codex.cmd")));
    assert.ok(candidates.includes(path.join(localAppData, "Packages", "OpenAI.Codex_test", "LocalCache", "Local", "OpenAI", "Codex", "bin", "codex.exe")));
  });

  test("uses known executable fallback only for default agent commands", () => {
    assert.equal(shouldUseKnownAgentFallback("codex", "codex"), true);
    assert.equal(shouldUseKnownAgentFallback("codex", "codex.cmd"), true);
    assert.equal(shouldUseKnownAgentFallback("claude", "claude.exe"), true);
    assert.equal(shouldUseKnownAgentFallback("codex", "codex-nightly"), false);
    assert.equal(shouldUseKnownAgentFallback("codex", "__hydra_echo__"), false);
  });

  test("summarizes native Codex and Claude capabilities for prompts", () => {
    assert.match(nativeCapabilitySummary("codex"), /Codex CLI/);
    assert.match(nativeCapabilitySummary("codex"), /raw native args/);
    assert.match(nativeCapabilitySummary("codex"), /MCP\/plugin\/model\/config\/search\/app\/remote/);
    assert.match(nativeCapabilitySummary("codex"), /codexExecArgs/);
    assert.match(nativeCapabilitySummary("claude"), /Claude Code CLI/);
    assert.match(nativeCapabilitySummary("claude"), /raw native args/);
    assert.match(nativeCapabilitySummary("claude"), /plugins, skills, agents, memory/);
    assert.match(nativeCapabilitySummary("claude"), /settings, and worktree/);
    assert.match(nativeCapabilitySummary("claude"), /claudeExecArgs/);
  });
});

describe("capabilities for arbitrary heads", () => {
  test("an unknown/gemini head gets a generic capability line, not a crash", () => {
    const summary = nativeCapabilitySummary("gemini");
    assert.ok(summary.length > 0);
    assert.doesNotThrow(() => nativeCapabilitySummary("ollama-qwen"));
  });

  test("known executable candidates for a gemini/unknown head is empty (falls through to PATH)", async () => {
    // No bespoke install locations are known for gemini/custom heads yet;
    // resolveAgentCommand should fall through to a plain PATH lookup instead
    // of guessing at codex-shaped install paths.
    assert.deepEqual(
      await knownAgentExecutableCandidates("gemini", { USERPROFILE: "C:\\Users\\x" }, "win32"),
      []
    );
  });
});
