import type { AgentId } from "./phases";

export type NativeCommandCatalogMode = "command" | "rawLine";

export interface NativeCommandCatalogItem {
  agent: AgentId;
  label: string;
  description: string;
  detail: string;
  mode: NativeCommandCatalogMode;
  line: string;
}

export const NATIVE_COMMAND_CATALOG: NativeCommandCatalogItem[] = [
  codex("Codex Help", "command", "--help", "Show top-level Codex CLI help."),
  codex("Codex Exec Help", "command", "exec --help", "Inspect native non-interactive `codex exec` flags (sandbox, --json, --ephemeral, --output-schema)."),
  codex("Codex Review Help", "command", "review --help", "Inspect native `codex review` non-interactive code-review options."),
  codex("Codex Version", "command", "--version", "Print the configured Codex CLI version."),
  codex("Codex MCP Help", "command", "mcp --help", "Inspect native MCP server management commands."),
  codex("Codex MCP List JSON", "command", "mcp list --json", "List configured Codex MCP servers as JSON."),
  codex("Codex MCP Add Help", "command", "mcp add --help", "Inspect native Codex MCP add options."),
  codex("Codex MCP Login Help", "command", "mcp login --help", "Inspect native Codex MCP OAuth login options."),
  codex("Codex Plugin Help", "command", "plugin --help", "Inspect native Codex plugin commands."),
  codex("Codex Plugin Marketplace Help", "command", "plugin marketplace --help", "Inspect native Codex plugin marketplace commands."),
  codex("Codex Features List", "command", "features list", "List native Codex feature flags and effective state."),
  codex("Codex Debug Help", "command", "debug --help", "Inspect native Codex debugging tools."),
  codex("Codex Debug Models", "command", "debug models", "Render the native Codex model catalog as JSON."),
  codex("Codex Sandbox Help", "command", "sandbox --help", "Inspect Codex sandbox command support."),
  codex("Codex Apply Help", "command", "apply --help", "Inspect native Codex apply options for cloud/task diffs."),
  codex("Codex Cloud Help", "command", "cloud --help", "Inspect native Codex Cloud commands."),
  codex("Codex App Server Help", "command", "app-server --help", "Inspect native Codex app-server options."),
  codex("Codex Exec Server Help", "command", "exec-server --help", "Inspect native Codex exec-server options."),
  codex("Codex MCP Server Help", "command", "mcp-server --help", "Inspect native Codex MCP server mode."),
  codex("Codex Completion Help", "command", "completion --help", "Inspect native shell-completion generation."),
  codex("Codex Login Status", "command", "login status", "Show native Codex login status."),
  codex("Codex Login", "rawLine", "codex login", "Run the interactive native login flow."),
  codex("Codex Logout", "rawLine", "codex logout", "Run native Codex logout interactively."),
  codex("Codex Resume", "rawLine", "codex resume", "Open the native interactive session resume picker."),
  codex("Codex Resume Last", "rawLine", "codex resume --last", "Continue the most recent native Codex session without picker."),
  codex("Codex Fork", "rawLine", "codex fork", "Open the native interactive session fork picker."),
  codex("Codex Fork Last", "rawLine", "codex fork --last", "Fork the most recent native Codex session without picker."),
  codex("Codex App", "rawLine", "codex app", "Launch the native Codex desktop app flow."),
  codex("Codex Cloud", "rawLine", "codex cloud", "Browse native Codex Cloud tasks interactively."),
  codex("Codex Remote Control", "rawLine", "codex remote-control", "Start native Codex remote-control flow."),
  codex("Codex Update", "rawLine", "codex update", "Run the native Codex updater interactively."),

  claude("Claude Help", "command", "--help", "Show top-level Claude Code CLI help."),
  claude("Claude Version", "command", "--version", "Print the configured Claude Code CLI version."),
  claude("Claude Doctor", "command", "doctor", "Run the native Claude Code health check."),
  claude("Claude MCP Help", "command", "mcp --help", "Inspect native MCP configuration commands."),
  claude("Claude MCP List", "command", "mcp list", "List configured Claude MCP servers."),
  claude("Claude MCP Add Help", "command", "mcp add --help", "Inspect native Claude MCP add options."),
  claude("Claude MCP Serve Help", "command", "mcp serve --help", "Inspect native Claude MCP server mode."),
  claude("Claude Plugin Help", "command", "plugin --help", "Inspect native Claude Code plugin commands."),
  claude("Claude Plugin List JSON", "command", "plugin list --json", "List installed Claude plugins as JSON."),
  claude("Claude Plugin Marketplace Help", "command", "plugin marketplace --help", "Inspect native Claude plugin marketplace commands."),
  claude("Claude Plugin Install Help", "command", "plugin install --help", "Inspect native Claude plugin install options."),
  claude("Claude Plugin Validate Help", "command", "plugin validate --help", "Inspect native Claude plugin validation options."),
  claude("Claude Agents Help", "command", "agents --help", "Inspect native background/configured agent commands."),
  claude("Claude Project Help", "command", "project --help", "Inspect native project-state commands."),
  claude("Claude Project Purge Dry Run Help", "command", "project purge --help", "Inspect native project-state purge options."),
  claude("Claude Auto Mode Help", "command", "auto-mode --help", "Inspect native auto-mode classifier configuration."),
  claude("Claude Auto Mode Defaults", "command", "auto-mode defaults", "Print native auto-mode defaults as JSON."),
  claude("Claude Ultrareview Help", "command", "ultrareview --help", "Inspect native cloud-hosted multi-agent review options."),
  claude("Claude Auth Status", "command", "auth status", "Show native Claude authentication status."),
  claude("Claude Install Help", "command", "install --help", "Inspect native Claude installer options."),
  claude("Claude Setup Token Help", "command", "setup-token --help", "Inspect native Claude setup-token flow."),
  claude("Claude Auth Login", "rawLine", "claude auth login", "Run the interactive native authentication flow."),
  claude("Claude Auth Logout", "rawLine", "claude auth logout", "Run native Claude logout interactively."),
  claude("Claude Resume", "rawLine", "claude --resume", "Open the native interactive session resume picker."),
  claude("Claude Continue", "rawLine", "claude --continue", "Continue the most recent native conversation."),
  claude("Claude Worktree", "rawLine", "claude --worktree", "Create a native Claude Code worktree session."),
  claude("Claude Remote Control", "rawLine", "claude --remote-control", "Start native Claude Code Remote Control."),
  claude("Claude Update", "rawLine", "claude update", "Run the native Claude Code updater interactively."),
  claude("Claude Install Stable", "rawLine", "claude install stable", "Run the native Claude stable installer interactively."),
  claude("Claude Setup Token", "rawLine", "claude setup-token", "Run the native long-lived token setup flow."),
];

function codex(
  label: string,
  mode: NativeCommandCatalogMode,
  line: string,
  detail: string
): NativeCommandCatalogItem {
  return { agent: "codex", label, mode, line, detail, description: modeLabel(mode) };
}

function claude(
  label: string,
  mode: NativeCommandCatalogMode,
  line: string,
  detail: string
): NativeCommandCatalogItem {
  return { agent: "claude", label, mode, line, detail, description: modeLabel(mode) };
}

function modeLabel(mode: NativeCommandCatalogMode): string {
  return mode === "command" ? "Capture output" : "Interactive terminal";
}
