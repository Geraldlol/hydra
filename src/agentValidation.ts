import type { AgentDefinition, AgentKind } from "./agentAdapter";
import { isAgentKind } from "./agentAdapter";
import { assignColorIndexes } from "./agentRegistry";

/** POSIX env-var identifier — an apiKeyEnv must be a NAME, never a key value. */
export function isEnvVarName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

// A `${env:NAME}` placeholder is explicitly NOT a secret (it's a reference).
const ENV_PLACEHOLDER = /^\$\{env:[^}]+\}$/;

/** Heuristic: does this literal look like an inlined credential? Conservative —
 *  only flags shapes that are clearly keys/tokens, never ordinary model ids. */
export function isSecretShaped(value: string): boolean {
  const v = value.trim();
  if (!v || ENV_PLACEHOLDER.test(v)) return false;
  if (/\bBearer\s+\S+/i.test(v)) return true;
  if (/\b(sk|rk|pk)-[A-Za-z0-9_-]{12,}/.test(v)) return true; // OpenAI-style
  if (/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/.test(v)) return true; // GitHub
  if (/\bxox[baprs]-[A-Za-z0-9-]{10,}/.test(v)) return true; // Slack
  if (/\bAKIA[0-9A-Z]{16}\b/.test(v)) return true; // AWS access key id
  if (/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(v)) return true; // JWT
  return false;
}

export function isLoopbackOrPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase(); // strip IPv6 brackets
  if (h === "localhost" || h === "::1" || h === "0.0.0.0") return true;
  if (h.endsWith(".local") || h.endsWith(".localhost")) return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // IPv6 ULA
  return false;
}

export function baseUrlAllowed(baseUrl: string): { ok: true } | { ok: false; message: string } {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, message: `baseUrl "${baseUrl}" is not a valid URL` };
  }
  if (url.protocol === "https:") return { ok: true };
  if (url.protocol === "http:") {
    if (isLoopbackOrPrivateHost(url.hostname)) return { ok: true };
    return { ok: false, message: `baseUrl must be https:// for non-local hosts (got http://${url.hostname})` };
  }
  return { ok: false, message: `baseUrl must use http(s); got ${url.protocol}` };
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Every string field that could carry an inlined secret. baseUrl is checked
// separately (it legitimately contains a host). apiKeyEnv is a NAME.
function scanForInlineSecret(def: Record<string, unknown>): string | undefined {
  const strings: string[] = [];
  for (const key of ["model", "command", "displayName"]) {
    const v = def[key];
    if (typeof v === "string") strings.push(v);
  }
  if (Array.isArray(def.argsTemplate)) for (const a of def.argsTemplate) if (typeof a === "string") strings.push(a);
  if (def.headers && typeof def.headers === "object") {
    for (const v of Object.values(def.headers as Record<string, unknown>)) if (typeof v === "string") strings.push(v);
  }
  return strings.find(isSecretShaped);
}

export function validateAgentDefinition(
  raw: unknown,
  takenIds: ReadonlySet<string>,
): { def?: AgentDefinition; error?: string } {
  if (!raw || typeof raw !== "object") return { error: "agent definition must be an object" };
  const d = raw as Record<string, unknown>;
  const id = typeof d.id === "string" ? d.id.trim() : "";
  if (!ID_RE.test(id)) return { error: `agent id "${String(d.id)}" must match ${ID_RE} (letters, digits, -, _)` };
  if (takenIds.has(id)) return { error: `duplicate agent id "${id}"` };
  const kind = typeof d.kind === "string" ? d.kind : "";
  if (!isAgentKind(kind)) return { error: `agent "${id}" has unknown kind "${kind}"` };
  const displayName = typeof d.displayName === "string" && d.displayName.trim() ? d.displayName.trim() : id;

  if (d.apiKeyEnv !== undefined && (typeof d.apiKeyEnv !== "string" || !isEnvVarName(d.apiKeyEnv))) {
    return { error: `agent "${id}" apiKeyEnv must be an environment-variable NAME (e.g. OPENAI_API_KEY), not a key value` };
  }
  const secret = scanForInlineSecret(d);
  if (secret) return { error: `agent "${id}" appears to inline a secret ("${secret.slice(0, 12)}…"); reference it via apiKeyEnv / \${env:NAME} instead` };

  if (kind === "openai-compatible") {
    if (typeof d.baseUrl !== "string" || !d.baseUrl.trim()) return { error: `openai-compatible agent "${id}" requires a baseUrl` };
    const allowed = baseUrlAllowed(d.baseUrl.trim());
    if (!allowed.ok) return { error: `agent "${id}": ${allowed.message}` };
  }
  if (kind === "cli-template") {
    if (typeof d.command !== "string" || !d.command.trim()) return { error: `cli-template agent "${id}" requires a command` };
    if (!Array.isArray(d.argsTemplate) || !d.argsTemplate.every((a) => typeof a === "string")) {
      return { error: `cli-template agent "${id}" requires a string[] argsTemplate` };
    }
  }

  const def: AgentDefinition = { id, displayName, kind: kind as AgentKind };
  if (typeof d.model === "string") def.model = d.model;
  if (typeof d.colorIndex === "number") def.colorIndex = d.colorIndex;
  if (typeof d.baseUrl === "string") def.baseUrl = d.baseUrl.trim();
  if (typeof d.apiKeyEnv === "string") def.apiKeyEnv = d.apiKeyEnv;
  if (d.headers && typeof d.headers === "object") def.headers = { ...(d.headers as Record<string, string>) };
  if (typeof d.command === "string") def.command = d.command;
  if (Array.isArray(d.argsTemplate)) def.argsTemplate = d.argsTemplate as string[];
  if (d.defaultAuthority === "read-only" || d.defaultAuthority === "workspace-write" || d.defaultAuthority === "full-native") {
    def.defaultAuthority = d.defaultAuthority;
  }
  if (d.pricing && typeof d.pricing === "object") def.pricing = d.pricing as AgentDefinition["pricing"];
  return { def };
}

export function mergeAgentDefinitions(
  builtins: AgentDefinition[],
  userRaw: unknown,
): { defs: AgentDefinition[]; warnings: string[] } {
  const defs: AgentDefinition[] = builtins.map((d) => ({ ...d }));
  const warnings: string[] = [];
  const entries = Array.isArray(userRaw) ? userRaw : [];
  const taken = new Set(defs.map((d) => d.id));
  for (const raw of entries) {
    const existingIdx = defs.findIndex((d) => typeof raw === "object" && raw && (raw as Record<string, unknown>).id === d.id);
    // Overriding a built-in: allow reusing its id (drop it from taken for this check).
    const takenForCheck = new Set(taken);
    if (existingIdx >= 0) takenForCheck.delete(defs[existingIdx]!.id);
    const { def, error } = validateAgentDefinition(raw, takenForCheck);
    if (!def) {
      warnings.push(error ?? "invalid agent definition");
      continue;
    }
    if (existingIdx >= 0) {
      defs[existingIdx] = { ...defs[existingIdx], ...def }; // merge override over built-in
    } else {
      defs.push(def);
      taken.add(def.id);
    }
  }
  return { defs: assignColorIndexes(defs), warnings };
}
