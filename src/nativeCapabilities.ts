import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentId } from "./phases";
import { displayNameFor } from "./agentRegistry";

export interface NativeCapabilityProbe {
  agent: AgentId;
  label: string;
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

export interface NativeCapabilitySnapshot {
  generatedAt: string;
  workspaceRoot: string;
  probes: NativeCapabilityProbe[];
}

export function nativeCapabilitiesPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".hydra", "native-capabilities.md");
}

export async function writeNativeCapabilities(filePath: string, markdown: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, markdown, "utf8");
}

export async function readNativeIntegrationSummary(filePath: string, maxChars = 3000): Promise<string> {
  let markdown: string;
  try {
    markdown = await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
  const summary = extractNativeIntegrationSummary(markdown);
  return summary.length > maxChars ? `${summary.slice(0, Math.max(0, maxChars - 32)).trimEnd()}\n[truncated]` : summary;
}

export function extractNativeIntegrationSummary(markdown: string): string {
  const match = markdown.match(/^## Integration Probe Summary\s*\r?\n([\s\S]*?)(?=^## |\z)/m);
  return match?.[1]?.trim() ?? "";
}

export function shouldIncludeNativeIntegrationSummary(...values: Array<string | undefined>): boolean {
  const text = values.filter(Boolean).join("\n").toLowerCase();
  return /\b(mcp|plugin|plugins|auth|authenticate|authentication|login|logout|feature flag|feature flags|features|integration|integrations|connected tool|connected tools|tool server|tool servers|marketplace|marketplaces)\b/.test(text);
}

export function renderNativeCapabilitySnapshot(snapshot: NativeCapabilitySnapshot): string {
  const lines: string[] = [
    "# Hydra Native Capability Snapshot",
    "",
    `Generated: ${snapshot.generatedAt}`,
    `Workspace: ${snapshot.workspaceRoot}`,
    "",
    "## Integration Probe Summary",
    "",
    ...renderIntegrationSummary(snapshot.probes),
    "",
    ...snapshot.probes.flatMap(renderProbe),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderIntegrationSummary(probes: NativeCapabilityProbe[]): string[] {
  const integrationProbes = probes.filter((probe) =>
    /\b(mcp|plugin|auth|login|features?)\b/i.test(probe.label)
  );
  if (integrationProbes.length === 0) return ["No integration probes captured."];
  return integrationProbes.map((probe) => {
    const status = probe.timedOut
      ? "timed out"
      : probe.exitCode === 0
      ? "ok"
      : `exit ${probe.exitCode ?? "unknown"}`;
    const detail = integrationDetail(probe);
    return `- ${labelAgent(probe.agent)} ${singleLine(probe.label)}: ${status}, output=${trimOutput(probe.output).length} chars${detail ? `, ${detail}` : ""}`;
  });
}

function integrationDetail(probe: NativeCapabilityProbe): string {
  const output = trimOutput(probe.output);
  if (!output) return "";
  const parsed = parseJson(output);
  if (parsed !== undefined) {
    const jsonDetail = jsonIntegrationDetail(probe.label, parsed);
    if (jsonDetail) return jsonDetail;
  }
  const firstLine = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine ? `first="${singleLine(firstLine)}"` : "";
}

function jsonIntegrationDetail(label: string, value: unknown): string {
  const lower = label.toLowerCase();
  if (lower.includes("plugin")) {
    const plugins = namedItems(value, "plugins");
    return `plugins=${plugins.count}${plugins.names.length ? ` [${plugins.names.join(", ")}]` : ""}`;
  }
  if (lower.includes("mcp")) {
    const servers = namedItems(value, "servers", "mcpServers");
    return `servers=${servers.count}${servers.names.length ? ` [${servers.names.join(", ")}]` : ""}`;
  }
  if (lower.includes("auth") || lower.includes("login")) {
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const status = stringValue(record.status) ?? stringValue(record.state) ?? stringValue(record.account);
      const authenticated = typeof record.authenticated === "boolean" ? record.authenticated : undefined;
      return [
        status ? `status=${singleLine(status)}` : "",
        authenticated !== undefined ? `authenticated=${authenticated ? "yes" : "no"}` : "",
      ].filter(Boolean).join(", ");
    }
  }
  return "";
}

function namedItems(value: unknown, ...preferredKeys: string[]): { count: number; names: string[] } {
  const items = extractNamedCollection(value, preferredKeys);
  return {
    count: items.length,
    names: items.slice(0, 8).map(itemName).filter((name): name is string => !!name).sort(),
  };
}

function extractNamedCollection(value: unknown, preferredKeys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of preferredKeys) {
    const child = record[key];
    if (Array.isArray(child)) return child;
    if (child && typeof child === "object") return Object.entries(child as Record<string, unknown>).map(([name, item]) =>
      item && typeof item === "object" ? { name, ...(item as Record<string, unknown>) } : { name, value: item }
    );
  }
  return Object.entries(record).map(([name, item]) =>
    item && typeof item === "object" ? { name, ...(item as Record<string, unknown>) } : { name, value: item }
  );
}

function itemName(value: unknown): string | undefined {
  if (typeof value === "string") return singleLine(value);
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return stringValue(record.name) ?? stringValue(record.id) ?? stringValue(record.key) ?? stringValue(record.command);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function renderProbe(probe: NativeCapabilityProbe): string[] {
  return [
    `## ${labelAgent(probe.agent)} ${probe.label}`,
    "",
    `Command: ${singleLine(probe.command)}`,
    `Args: ${probe.args.length ? probe.args.map(singleLine).join(" ") : "none"}`,
    `CWD: ${singleLine(probe.cwd)}`,
    `Exit code: ${probe.exitCode ?? "none"}`,
    `Timed out: ${probe.timedOut}`,
    `Duration: ${probe.durationMs}ms`,
    "",
    "```text",
    trimOutput(probe.output) || "[no output]",
    "```",
    "",
  ];
}

function labelAgent(agent: AgentId): string {
  return displayNameFor(agent);
}

function singleLine(value: string): string {
  const compacted = value.trim().replace(/\s+/g, " ");
  return compacted.length > 240 ? `${compacted.slice(0, 237)}...` : compacted;
}

function trimOutput(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 12000 ? `${trimmed.slice(0, 11960)}\n\n[truncated ${trimmed.length - 11960} chars]` : trimmed;
}
