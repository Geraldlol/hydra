import type { AgentId } from "./phases";
import { claudeUsesPrintModeArgs } from "./claudeCli";
import type { Phase } from "./prompts";

export type AuthorityLevel = "readOnly" | "workspaceWrite" | "fullNative" | "unknown";

export interface AuthorityClassification {
  level: AuthorityLevel;
  label: string;
  detail: string;
  warnings: string[];
}

export function classifyAgentAuthority(
  agent: AgentId,
  phase: Phase,
  args: string[]
): AuthorityClassification {
  const validation = validateNativeArgs(agent, args);
  const dangerous = dangerousFlag(args);
  if (dangerous) {
    return classification(
      "fullNative",
      "Full native",
      `${agent} args include ${dangerous}; Hydra will not sandbox this call.`,
      [
        "Full native authority can read, edit, and run commands according to the native CLI configuration.",
        ...validation,
      ]
    );
  }

  const base =
    agent === "codex" ? classifyCodexAuthority(phase, args)
    : agent === "claude" ? classifyClaudeAuthority(phase, args)
    : classifyGenericAuthority(phase, args); // gemini + custom heads: no vendor-specific sandbox flags known
  if (validation.length === 0) return base;
  return { ...base, warnings: [...base.warnings, ...validation] };
}

// Catch arg combinations the native CLI will reject or that have known
// unintended consequences. Every entry below is grounded in the RE specs
// under docs/native-internals/. Returns warnings for surfacing in
// classifyAgentAuthority -> AuthorityClassification.warnings (already
// rendered by Doctor, supportBundle, status bar, and prompt preview).
// Never throws -- the native CLI is the final word on validity.
export function validateNativeArgs(agent: AgentId, args: string[]): string[] {
  const warnings: string[] = [];
  if (agent === "codex") {
    // `--ask-for-approval` is on the TUI root (`codex` interactive) only --
    // not on `codex exec` / `codex review`. clap will fail to parse it.
    // See codex-rs/utils/cli/src/approval_mode_cli_arg.rs and the
    // `dangerous_bypass_conflicts_with_approval_policy` test for the
    // canonical conflict rule.
    if (isCodexExecArgs(args) && args.some((arg) => arg === "--ask-for-approval" || arg === "-a")) {
      warnings.push(
        "Codex `--ask-for-approval` is only valid on the interactive root command, not `codex exec`. " +
          "Use `--dangerously-bypass-approvals-and-sandbox` for an exec-equivalent of `never`."
      );
    }
    // `--full-auto` was removed in v0.130.0; the binary keeps a hidden compat
    // trap that prints a warning and conflicts with the bypass flag.
    if (args.includes("--full-auto")) {
      warnings.push(
        "Codex `--full-auto` is removed; the binary keeps a hidden compat trap that warns and may conflict with sandbox flags. " +
          "Switch to `--sandbox` + `--ask-for-approval` (TUI) or `--dangerously-bypass-approvals-and-sandbox` (exec)."
      );
    }
    // `codex review` flags --uncommitted / --base / --commit are mutually
    // exclusive among themselves (and with the positional prompt). Source:
    // codex-rs/exec/src/cli.rs:266 with `conflicts_with_all`. clap will
    // reject combinations at parse time.
    if (isCodexReviewArgs(args)) {
      const reviewFlags = ["--uncommitted", "--base", "--commit"].filter((f) => args.includes(f));
      if (reviewFlags.length > 1) {
        warnings.push(
          `Codex \`review\` flags ${reviewFlags.join(", ")} are mutually exclusive. Pick exactly one of --uncommitted, --base, --commit, or supply a prompt instead.`
        );
      }
    }
    // `--sandbox` value must be one of clap's accepted enum values (kebab-case)
    // -- typos silently fall through to default sandbox authority on the live
    // CLI's parse error, which is a security-sensitive footgun.
    // Source: codex-rs/utils/cli/src/sandbox_mode_cli_arg.rs.
    const sandbox = readLastFlagValue(args, "--sandbox") ?? readLastFlagValue(args, "-s");
    const validSandboxModes = new Set(["read-only", "workspace-write", "danger-full-access"]);
    if (sandbox !== undefined && !validSandboxModes.has(sandbox)) {
      warnings.push(
        `Codex \`--sandbox\` must be one of read-only, workspace-write, danger-full-access; got "${sandbox}". The CLI rejects unknown values.`
      );
    }
    // `--remote` accepts only ws:// or wss:// websocket URLs. clap doesn't
    // pre-validate the scheme; a typo silently goes to connection attempt.
    const remote = readLastFlagValue(args, "--remote");
    if (remote !== undefined && !/^wss?:\/\//.test(remote)) {
      warnings.push(
        `Codex \`--remote\` requires a ws:// or wss:// URL; got "${remote}". The CLI fails to connect with unrecognized schemes.`
      );
    }
    // `--local-provider` is the local-provider enum (with --oss).
    const localProvider = readLastFlagValue(args, "--local-provider");
    if (localProvider !== undefined && !["lmstudio", "ollama"].includes(localProvider)) {
      warnings.push(
        `Codex \`--local-provider\` must be lmstudio or ollama; got "${localProvider}".`
      );
    }
  } else if (agent === "claude") {
    // `--output-format stream-json` (with `--print`/`-p`) requires `--verbose`.
    // panel.ts auto-injects --verbose when Hydra wraps the spawn, but
    // user-supplied args are passed raw -- catch the typo before runtime.
    const outputFormat = readLastFlagValue(args, "--output-format");
    const printMode = claudeUsesPrintModeArgs(args);
    if (outputFormat === "stream-json" && printMode && !args.includes("--verbose")) {
      warnings.push(
        "Claude `--print --output-format=stream-json` requires `--verbose`. The CLI will exit 1 with this combination."
      );
    }
    // `--input-format stream-json` is only valid with `--output-format=stream-json`.
    const inputFormat = readLastFlagValue(args, "--input-format");
    if (inputFormat === "stream-json" && outputFormat !== "stream-json") {
      warnings.push(
        "Claude `--input-format=stream-json` is only valid alongside `--output-format=stream-json` and `--print`."
      );
    }
    // `--include-partial-messages` is only meaningful with stream-json output.
    if (args.includes("--include-partial-messages") && outputFormat !== "stream-json") {
      warnings.push(
        "Claude `--include-partial-messages` only applies with `--output-format=stream-json`; otherwise it is silently ignored."
      );
    }
    // `--include-hook-events` is only meaningful with stream-json output.
    if (args.includes("--include-hook-events") && outputFormat !== "stream-json") {
      warnings.push(
        "Claude `--include-hook-events` only applies with `--output-format=stream-json`; otherwise it is silently ignored."
      );
    }
    // The following flags only work with `--print` (per `claude --help`):
    // --max-budget-usd, --fallback-model, --no-session-persistence.
    const printOnlyFlags: string[] = [
      "--max-budget-usd",
      "--fallback-model",
      "--no-session-persistence",
    ];
    for (const flagName of printOnlyFlags) {
      if (args.includes(flagName) && !printMode) {
        warnings.push(
          `Claude \`${flagName}\` only works with \`--print\` / \`-p\`; it is ignored otherwise.`
        );
      }
    }
    // `--replay-user-messages` requires both stream-json input and output.
    if (args.includes("--replay-user-messages") && (inputFormat !== "stream-json" || outputFormat !== "stream-json")) {
      warnings.push(
        "Claude `--replay-user-messages` requires both `--input-format=stream-json` and `--output-format=stream-json`."
      );
    }
    // `plan` permission mode is read-only; combining with --accept-edits
    // semantics doesn't exist as a flag, but combining --permission-mode=plan
    // with --tools that include destructive tools is a user-visible mismatch.
    // We skip that one because the tool list is dynamic; covered by Doctor's
    // authority classification instead.
    // `--session-id` must be a UUID. We don't fully validate -- just check
    // the obvious "looks roughly like a uuid" shape so a typo gets caught.
    const sessionId = readLastFlagValue(args, "--session-id");
    if (sessionId !== undefined && !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(sessionId)) {
      warnings.push(
        `Claude \`--session-id\` must be a valid UUID; got "${sessionId}". The CLI rejects malformed UUIDs.`
      );
    }
    // Enum-value typo guards. Each list comes from `claude --help` (captured
    // in docs/native-internals/claude-help.txt) "choices:" annotations.
    const permMode = readLastFlagValue(args, "--permission-mode");
    const validPermModes = new Set(["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"]);
    if (permMode !== undefined && !validPermModes.has(permMode)) {
      warnings.push(
        `Claude \`--permission-mode\` must be one of acceptEdits, auto, bypassPermissions, default, dontAsk, plan; got "${permMode}". A typo here silently falls through to default authority on the live CLI parse error.`
      );
    }
    if (outputFormat !== undefined && !["text", "json", "stream-json"].includes(outputFormat)) {
      warnings.push(
        `Claude \`--output-format\` must be one of text, json, stream-json; got "${outputFormat}".`
      );
    }
    if (inputFormat !== undefined && !["text", "stream-json"].includes(inputFormat)) {
      warnings.push(
        `Claude \`--input-format\` must be one of text, stream-json; got "${inputFormat}".`
      );
    }
    const effort = readLastFlagValue(args, "--effort");
    if (effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(effort)) {
      warnings.push(
        `Claude \`--effort\` must be one of low, medium, high, xhigh, max; got "${effort}".`
      );
    }
  }
  return warnings;
}

function isCodexExecArgs(args: string[]): boolean {
  return firstCodexPositional(args) === "exec" || firstCodexPositional(args) === "e";
}

function isCodexReviewArgs(args: string[]): boolean {
  return firstCodexPositional(args) === "review";
}

// Find the first non-flag positional in a Codex args list. `codex` keeps
// subcommand-style positioning -- skip leading flags (and the value-taking
// ones we know about).
function firstCodexPositional(args: string[]): string | undefined {
  const valueFlags = new Set([
    "--color", "--cd", "-C", "--config", "-c", "--profile", "-p",
    "--model", "-m", "--add-dir", "--image", "-i", "--local-provider",
    "--sandbox", "-s", "--output-schema", "-o", "--output-last-message",
    "--ask-for-approval", "-a", "--base", "--commit", "--title",
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith("-")) {
      const eq = arg.indexOf("=");
      if (eq < 0 && valueFlags.has(arg)) i++;
      continue;
    }
    return arg;
  }
  return undefined;
}

// Rank encodes position on a permissive → deny axis: readOnly is safest,
// fullNative is the highest known authority level, and unknown sits as a
// sentinel above all known levels because Hydra cannot prove anything
// about an unrecognized configuration. Any safety gate of the form
// "rank(level) <= threshold" therefore correctly denies unknown when the
// threshold is below the unknown sentinel.
export function authorityRank(level: AuthorityLevel): number {
  switch (level) {
    case "readOnly": return 0;
    case "workspaceWrite": return 1;
    case "fullNative": return 2;
    case "unknown": return 4; // sentinel — outside the known scale
  }
}

function classifyCodexAuthority(phase: Phase, args: string[]): AuthorityClassification {
  const sandbox = readLastFlagValue(args, "--sandbox");
  if (sandbox === "danger-full-access") {
    return classification(
      "fullNative",
      "Full native",
      "Codex sandbox is danger-full-access.",
      ["Hydra is allowing Codex full native authority for this call."]
    );
  }
  if (sandbox === "workspace-write") {
    return classification("workspaceWrite", "Workspace-write", "Codex sandbox is workspace-write.", []);
  }
  if (sandbox === "read-only") {
    return classification("readOnly", "Read-only", "Codex sandbox is read-only.", []);
  }
  // Native `codex review` subcommand. Detect anywhere it appears as a
  // positional (non-flag) word — args may include leading flags like --color.
  if (hasReviewSubcommand(args)) {
    return classification(
      "readOnly",
      "Read-only",
      "Codex native review command is treated as review-only unless raw args add broader authority.",
      []
    );
  }
  return classification(
    "unknown",
    "Unknown/custom",
    `Codex ${phase} args do not declare a recognized sandbox.`,
    ["Hydra cannot prove this Codex call is read-only or workspace-write from args alone."]
  );
}

function classifyClaudeAuthority(phase: Phase, args: string[]): AuthorityClassification {
  const mode = readLastFlagValue(args, "--permission-mode");
  if (mode === "bypassPermissions" || mode === "dangerouslySkipPermissions") {
    return classification(
      "fullNative",
      "Full native",
      `Claude permission mode is ${mode}.`,
      ["Hydra is allowing Claude full native authority for this call."]
    );
  }
  if (mode === "acceptEdits" || mode === "auto") {
    return classification("workspaceWrite", "Workspace-write", `Claude permission mode is ${mode}.`, []);
  }
  if (mode === "plan" || mode === "default" || mode === "dontAsk") {
    // `dontAsk` is the strictest interactive mode: instead of pausing for
    // user approval, it returns `deny` for any tool call that would normally
    // need permission (bundle: `ny8`, ~line 169407 -- `dontAsk -> deny`).
    // Pre-approved allow-rules still pass, so the *effective* authority
    // depends on the user's rules. Classifying it as `readOnly` is the safe
    // default; it correctly captures "no escalation possible" even though
    // a permissive allow-rule set could let writes through.
    return classification("readOnly", "Read-only", `Claude permission mode is ${mode}.`, []);
  }
  return classification(
    "unknown",
    "Unknown/custom",
    `Claude ${phase} args do not declare a recognized permission mode.`,
    ["Hydra cannot prove this Claude call is read-only or workspace-write from args alone."]
  );
}

// Generic path for agents with no vendor-specific sandbox/permission flags
// (gemini, custom heads). Hydra has no schema to read authority off of raw
// args for these, so it honestly reports "unknown" rather than guessing --
// the dangerousFlag gate above already caught the one signal that applies
// to every vendor (--dangerously-*).
function classifyGenericAuthority(phase: Phase, args: string[]): AuthorityClassification {
  return classification(
    "unknown",
    "Unknown/custom",
    `${phase} args do not declare a recognized authority for this agent; Hydra has no vendor-specific rules for it.`,
    ["Hydra cannot prove this call is read-only or workspace-write from args alone."]
  );
}

function hasReviewSubcommand(args: string[]): boolean {
  // Find the first non-flag positional. If it's "review", this is the
  // native codex review subcommand. Skips leading flags (those starting
  // with "-") and any value tokens that immediately follow value-taking
  // flags like --color, --cd, etc. (best-effort heuristic).
  const valueFlags = new Set(["--color", "--cd", "--config", "--profile", "--model"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith("-")) {
      const eq = arg.indexOf("=");
      if (eq < 0 && valueFlags.has(arg)) i++; // skip value
      continue;
    }
    return arg === "review";
  }
  return false;
}

function dangerousFlag(args: string[]): string | undefined {
  return args.find((arg) =>
    arg === "--dangerously-bypass-approvals-and-sandbox" ||
    arg === "--dangerously-skip-permissions" ||
    arg === "--bypass-permissions"
  );
}

function readLastFlagValue(args: string[], flag: string): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === flag && i + 1 < args.length) {
      value = args[i + 1];
      i++;
      continue;
    }
    if (arg.startsWith(`${flag}=`)) {
      value = arg.slice(flag.length + 1);
    }
  }
  return value;
}

function classification(
  level: AuthorityLevel,
  label: string,
  detail: string,
  warnings: string[]
): AuthorityClassification {
  return { level, label, detail, warnings };
}
