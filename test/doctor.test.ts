import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  formatDoctorReport,
  runHydraDoctor,
  TRUST_SCOPED_SETTINGS,
  trustScopeWarnings,
} from "../src/doctor";

describe("Hydra Doctor", () => {
  test("passes with resolved commands, writable .hydra, and git available", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-doctor-"));
    // Create real placeholder files so commandCheck's fileExists guard passes
    // — Doctor now refuses to call a resolved path "ok" without confirming
    // the file actually exists on disk.
    const codexPath = path.join(workspaceRoot, "codex.cmd");
    const claudePath = path.join(workspaceRoot, "claude.cmd");
    await fs.writeFile(codexPath, "");
    await fs.writeFile(claudePath, "");
    const report = await runHydraDoctor({
      workspaceRoot,
      gitAvailable: true,
      codexCommand: "codex",
      codexResolvedCommand: codexPath,
      claudeCommand: "claude",
      claudeResolvedCommand: claudePath,
      trustWarnings: [],
      terminalBridge: { ok: true, message: "Terminal bridge self-test passed." },
    });

    assert.equal(report.ok, true);
    assert.equal(report.checks.some((check) => check.status === "fail"), false);
    assert.match(formatDoctorReport(report), /Hydra Doctor: Hydra Doctor passed\./);
  });

  test("fails unresolved native commands and missing workspace", async () => {
    const report = await runHydraDoctor({
      workspaceRoot: undefined,
      gitAvailable: false,
      codexCommand: "codex",
      codexResolvedCommand: "codex",
      claudeCommand: "claude",
      claudeResolvedCommand: "claude",
      trustWarnings: [],
    });

    assert.equal(report.ok, false);
    assert.equal(report.checks.filter((check) => check.status === "fail").length, 4);
    assert.match(formatDoctorReport(report), /Codex CLI/);
  });

  test("fails an explicit native command path that does not exist", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-doctor-"));
    const missingCodex = path.join(workspaceRoot, "missing", "codex.exe");
    const report = await runHydraDoctor({
      workspaceRoot,
      gitAvailable: true,
      codexCommand: missingCodex,
      codexResolvedCommand: missingCodex,
      claudeCommand: "claude",
      claudeResolvedCommand: "C:\\Tools\\claude.cmd",
      trustWarnings: [],
    });

    const codexCheck = report.checks.find((check) => check.id === "codex-command");
    assert.equal(codexCheck?.status, "fail");
    assert.match(codexCheck?.detail ?? "", /does not exist/);
    assert.equal(report.ok, false);
  });

  test("includes args-validation pass check when all configured args are clean", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-doctor-"));
    const codexPath = path.join(workspaceRoot, "codex.cmd");
    const claudePath = path.join(workspaceRoot, "claude.cmd");
    await fs.writeFile(codexPath, "");
    await fs.writeFile(claudePath, "");
    const report = await runHydraDoctor({
      workspaceRoot,
      gitAvailable: true,
      codexCommand: "codex",
      codexResolvedCommand: codexPath,
      claudeCommand: "claude",
      claudeResolvedCommand: claudePath,
      trustWarnings: [],
      argsValidation: [
        { agent: "codex", profile: "discussion", warnings: [] },
        { agent: "claude", profile: "build", warnings: [] },
      ],
    });
    const check = report.checks.find((c) => c.id === "args-validation");
    assert.equal(check?.status, "pass");
    assert.match(check?.detail ?? "", /pass all known-bad-combination checks/);
    assert.equal(report.ok, true);
  });

  test("surfaces validateNativeArgs warnings as a single args-validation warn check", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-doctor-"));
    const codexPath = path.join(workspaceRoot, "codex.cmd");
    const claudePath = path.join(workspaceRoot, "claude.cmd");
    await fs.writeFile(codexPath, "");
    await fs.writeFile(claudePath, "");
    const report = await runHydraDoctor({
      workspaceRoot,
      gitAvailable: true,
      codexCommand: "codex",
      codexResolvedCommand: codexPath,
      claudeCommand: "claude",
      claudeResolvedCommand: claudePath,
      trustWarnings: [],
      argsValidation: [
        { agent: "codex", profile: "discussion", warnings: [] },
        {
          agent: "codex",
          profile: "build",
          warnings: ["Codex `--ask-for-approval` is only valid on the interactive root command, not `codex exec`."],
        },
        {
          agent: "claude",
          profile: "review",
          warnings: ["Claude `--print --output-format=stream-json` requires `--verbose`."],
        },
      ],
    });
    const check = report.checks.find((c) => c.id === "args-validation");
    assert.equal(check?.status, "warn");
    assert.match(check?.detail ?? "", /codex\/build/);
    assert.match(check?.detail ?? "", /claude\/review/);
    assert.match(check?.detail ?? "", /interactive root command/);
    // A pass-with-warnings is still ok=true (Doctor.ok checks for failures only).
    assert.equal(report.ok, true);
    assert.match(formatDoctorReport(report), /WARN: Native CLI args/);
  });

  test("omits args-validation check when input.argsValidation is undefined", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-doctor-"));
    const codexPath = path.join(workspaceRoot, "codex.cmd");
    const claudePath = path.join(workspaceRoot, "claude.cmd");
    await fs.writeFile(codexPath, "");
    await fs.writeFile(claudePath, "");
    const report = await runHydraDoctor({
      workspaceRoot,
      gitAvailable: true,
      codexCommand: "codex",
      codexResolvedCommand: codexPath,
      claudeCommand: "claude",
      claudeResolvedCommand: claudePath,
      trustWarnings: [],
    });
    assert.equal(report.checks.some((c) => c.id === "args-validation"), false);
  });

  test("warns when sensitive native settings are workspace scoped", () => {
    const warnings = trustScopeWarnings([
      { key: "codexCommand", workspaceValue: "C:\\evil.exe" },
      { key: "claudeExecArgsBuild", workspaceFolderValue: ["-p"] },
      { key: "firstSpeaker" },
    ]);

    assert.equal(TRUST_SCOPED_SETTINGS.includes("codexCommand"), true);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /codexCommand/);
    assert.match(warnings[1], /workspace-folder/);
  });

  test("TRUST_SCOPED_SETTINGS covers every package.json restricted setting", () => {
    // These mirror package.json capabilities.untrustedWorkspaces.restrictedConfigurations.
    // If a setting is added there, this list must grow too so Doctor surfaces the warning.
    const expected = [
      "transcriptPath",
      "workspaceRoot",
      "verifyCommand",
      "handoffWebhookUrl",
      "telegramBotToken",
      "telegramChatId",
      "telegramInboundPollingEnabled",
      "telegramInboundCommandPrefix",
      "telegramInboundPollIntervalSeconds",
      "nativeEnv",
      "codexNativeEnv",
      "claudeNativeEnv",
      "nativePathPrepend",
      "codexNativePathPrepend",
      "claudeNativePathPrepend",
    ];
    for (const key of expected) {
      assert.equal(
        TRUST_SCOPED_SETTINGS.includes(key as typeof TRUST_SCOPED_SETTINGS[number]),
        true,
        `TRUST_SCOPED_SETTINGS missing ${key} — re-sync with restrictedConfigurations`
      );
    }
  });
});
