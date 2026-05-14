import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentId } from "./phases";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  createdAt: string;
  summary: string;
  checks: DoctorCheck[];
}

export interface TerminalBridgeDoctorResult {
  ok: boolean;
  message: string;
}

// One row per (agent, profile) combination the user can configure (e.g.
// codex/discussion, claude/build, ...). When validateNativeArgs reports
// warnings for any of them, Doctor surfaces a single consolidated check.
// When the field is omitted entirely, Doctor skips the check (preserves
// the contract for older callers; tests stay tight).
export interface DoctorArgsValidation {
  agent: AgentId;
  profile: string;
  warnings: string[];
}

export interface DoctorInput {
  workspaceRoot?: string;
  gitAvailable: boolean;
  codexCommand: string;
  // Pass the absolute path when the CLI was found, or undefined when the
  // extension host could not resolve it. Passing the bare command name
  // back as "resolved" is treated as not-found (the prior contract was
  // ambiguous and produced both false-positive and false-negative
  // Doctor results depending on the resolver's behavior).
  codexResolvedCommand: string | undefined;
  claudeCommand: string;
  claudeResolvedCommand: string | undefined;
  trustWarnings: string[];
  terminalBridge?: TerminalBridgeDoctorResult;
  argsValidation?: DoctorArgsValidation[];
}

export interface TrustedSettingInspection {
  key: string;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

export const TRUST_SCOPED_SETTINGS = [
  "codexCommand",
  "claudeCommand",
  "codexExecArgsDiscussion",
  "codexExecArgsBuild",
  "codexExecArgsReview",
  "claudeExecArgsDiscussion",
  "claudeExecArgsBuild",
  "claudeExecArgsReview",
  "codexTerminalCommand",
  "claudeTerminalCommand",
] as const;

export async function runHydraDoctor(input: DoctorInput): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const workspaceRoot = input.workspaceRoot?.trim();

  checks.push({
    id: "workspace",
    label: "Workspace folder",
    status: workspaceRoot ? "pass" : "fail",
    detail: workspaceRoot || "No workspace folder is available.",
  });

  if (workspaceRoot) {
    checks.push(await checkHydraWritable(workspaceRoot));
  } else {
    checks.push({
      id: "hydra-writable",
      label: ".hydra writable",
      status: "fail",
      detail: "Open a project folder so Hydra can create `.hydra` state files.",
    });
  }

  checks.push(await commandCheck("codex-command", "Codex CLI", input.codexCommand, input.codexResolvedCommand));
  checks.push(await commandCheck("claude-command", "Claude CLI", input.claudeCommand, input.claudeResolvedCommand));
  checks.push({
    id: "git",
    label: "Git workspace",
    status: input.gitAvailable ? "pass" : "warn",
    detail: input.gitAvailable
      ? "Hydra Review can capture tracked and untracked diffs."
      : "This folder is not a git worktree; Hydra Review will be limited.",
  });

  if (input.trustWarnings.length) {
    checks.push({
      id: "trust-scope",
      label: "Workspace trust scope",
      status: "warn",
      detail: input.trustWarnings.join("\n"),
    });
  } else {
    checks.push({
      id: "trust-scope",
      label: "Workspace trust scope",
      status: "pass",
      detail: "Sensitive CLI command and arg settings are not overridden by this workspace.",
    });
  }

  if (input.terminalBridge) {
    checks.push({
      id: "terminal-bridge",
      label: "Terminal bridge self-test",
      status: input.terminalBridge.ok ? "pass" : "fail",
      detail: input.terminalBridge.message,
    });
  }

  if (input.argsValidation) {
    checks.push(buildArgsValidationCheck(input.argsValidation));
  }

  const failed = checks.filter((check) => check.status === "fail").length;
  const warned = checks.filter((check) => check.status === "warn").length;
  const summary =
    failed > 0
      ? `Hydra Doctor found ${failed} failing check${failed === 1 ? "" : "s"}${warned ? ` and ${warned} warning${warned === 1 ? "" : "s"}` : ""}.`
      : warned > 0
        ? `Hydra Doctor passed with ${warned} warning${warned === 1 ? "" : "s"}.`
        : "Hydra Doctor passed.";

  return {
    ok: failed === 0,
    createdAt: new Date().toISOString(),
    summary,
    checks,
  };
}

export function trustScopeWarnings(inspections: TrustedSettingInspection[]): string[] {
  return inspections.flatMap((inspection) => {
    const scopes: string[] = [];
    if (inspection.workspaceValue !== undefined) scopes.push("workspace");
    if (inspection.workspaceFolderValue !== undefined) scopes.push("workspace-folder");
    if (!scopes.length) return [];
    return [
      `${inspection.key} is set at ${scopes.join(" and ")} scope. Prefer User/Machine settings for executable paths and raw CLI authority.`,
    ];
  });
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [`Hydra Doctor: ${report.summary}`];
  for (const check of report.checks) {
    const mark = check.status.toUpperCase();
    lines.push(`- ${mark}: ${check.label} — ${check.detail}`);
  }
  return lines.join("\n");
}

function buildArgsValidationCheck(rows: DoctorArgsValidation[]): DoctorCheck {
  const offending = rows.filter((row) => row.warnings.length > 0);
  if (offending.length === 0) {
    return {
      id: "args-validation",
      label: "Native CLI args",
      status: "pass",
      detail: "Configured Codex / Claude args pass all known-bad-combination checks.",
    };
  }
  const lines = offending.flatMap((row) =>
    row.warnings.map((w) => `- ${row.agent}/${row.profile}: ${w}`)
  );
  return {
    id: "args-validation",
    label: "Native CLI args",
    status: "warn",
    detail: lines.join("\n"),
  };
}

async function checkHydraWritable(workspaceRoot: string): Promise<DoctorCheck> {
  const hydraDir = path.join(workspaceRoot, ".hydra");
  const probe = path.join(hydraDir, `.doctor-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await fs.mkdir(hydraDir, { recursive: true });
    await fs.writeFile(probe, "ok", "utf8");
    await fs.unlink(probe);
    return {
      id: "hydra-writable",
      label: ".hydra writable",
      status: "pass",
      detail: `${hydraDir} is writable.`,
    };
  } catch (err) {
    return {
      id: "hydra-writable",
      label: ".hydra writable",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function commandCheck(id: string, label: string, configured: string, resolved: string | undefined): Promise<DoctorCheck> {
  const command = configured || label.toLowerCase();
  const settingKey = id.startsWith("codex") ? "codexCommand" : "claudeCommand";

  // undefined ⇒ caller couldn't resolve. Definite fail.
  if (resolved === undefined || resolved === "") {
    return {
      id,
      label,
      status: "fail",
      detail: `${command} was not found from the VS Code extension host. Set hydraRoom.${settingKey} to a full path.`,
    };
  }

  // Resolved as a path (absolute or contains a separator): only "pass" if
  // that path actually exists on disk. Catches stale cached paths and
  // misconfigured full-path settings.
  if (hasPathSeparator(resolved) || path.isAbsolute(resolved)) {
    if (await fileExists(resolved)) {
      return { id, label, status: "pass", detail: `${command} -> ${resolved}` };
    }
    return {
      id,
      label,
      status: "fail",
      detail: `${resolved} does not exist. Set hydraRoom.${settingKey} to an installed CLI path.`,
    };
  }

  // Resolved as a bare name. Treat resolution-equals-input as "not found"
  // (the resolver gave up and echoed the input back). Otherwise the
  // resolver reported a different bare name — unusual but acceptable.
  if (resolved === command) {
    return {
      id,
      label,
      status: "fail",
      detail: `${command} was not found from the VS Code extension host. Set hydraRoom.${settingKey} to a full path.`,
    };
  }
  return { id, label, status: "pass", detail: `${command} -> ${resolved}` };
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

async function fileExists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}
