import type { AgentDefinition, AgentKind } from "./agentAdapter";
import { isAgentKind } from "./agentAdapter";
import { assignColorIndexes } from "./agentRegistry";

/** POSIX env-var identifier — an apiKeyEnv must be a NAME, never a key value. */
export function isEnvVarName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

// A `${env:NAME}` placeholder is explicitly NOT a secret (it's a reference).
const ENV_PLACEHOLDER = /^\$\{env:[^}]+\}$/;
const ENV_PLACEHOLDER_GLOBAL = /\$\{env:[^}]+\}/g;

/** Heuristic: does this literal look like an inlined credential? Conservative —
 *  only flags shapes that are clearly keys/tokens, never ordinary model ids. */
export function isSecretShaped(value: string): boolean {
  const v = value.trim();
  if (!v || ENV_PLACEHOLDER.test(v)) return false;
  // Why: a documented pattern like `"Bearer ${env:MY_TOKEN}"` embeds a
  // legitimate env-var reference alongside a non-secret prefix. Strip
  // `${env:NAME}` occurrences before shape-checking so only a REAL inlined
  // secret in the remainder gets flagged.
  const stripped = v.replace(ENV_PLACEHOLDER_GLOBAL, "").trim();
  if (!stripped) return false;
  if (/\bBearer\s+\S+/i.test(stripped)) return true;
  if (/\b(sk|rk|pk)-[A-Za-z0-9_-]{12,}/.test(stripped)) return true; // OpenAI-style
  if (/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/.test(stripped)) return true; // GitHub
  if (/\bxox[baprs]-[A-Za-z0-9-]{10,}/.test(stripped)) return true; // Slack
  if (/\bAKIA[0-9A-Z]{16}\b/.test(stripped)) return true; // AWS access key id
  if (/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(stripped)) return true; // JWT
  return false;
}

// Strictly parses a dotted-quad IPv4 address; returns the 4 octets, or
// undefined if `host` isn't a fully-numeric IPv4 address. This is deliberately
// NOT a prefix/regex match against the raw string: a DNS name like
// "127.0.0.1.evil.test" or "192.168.evil.test" must never classify as private.
function parseIpv4(host: string): [number, number, number, number] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const octets: [number, number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return octets.every((n) => n >= 0 && n <= 255) ? octets : undefined;
}

export function isLoopbackOrPrivateHost(host: string): boolean {
  // Strip IPv6 brackets and a single trailing dot (e.g. "localhost.").
  const h = host.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h === "::1") return true;
  if (h.endsWith(".local") || h.endsWith(".localhost")) return true;
  // IPv6 Unique Local Address block fc00::/7 (fc00:: - fdff::). A colon can
  // never appear in a DNS hostname, so this can't be spoofed by a domain
  // like "fd00.evil.test" the way a bare numeric prefix match could be.
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true;
  const octets = parseIpv4(h);
  if (!octets) return false;
  const [a, b, c, d] = octets;
  // Why: 0.0.0.0 is a common Ollama/vLLM bind-all address; treat it as local
  // like the other reserved ranges below.
  if (a === 0 && b === 0 && c === 0 && d === 0) return true;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  // Why: 169.254.0.0/16 is link-local and includes the cloud-metadata
  // endpoint 169.254.169.254; acceptable only because baseUrl is a
  // trust-scoped, application-scoped user setting (not workspace-injectable).
  if (a === 169 && b === 254) return true;
  return false;
}

export function baseUrlAllowed(baseUrl: string): { ok: true } | { ok: false; message: string } {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, message: `baseUrl "${baseUrl}" is not a valid URL` };
  }
  // Why: a userinfo-bearing baseUrl (https://user:sk-live-x@host/v1) would
  // durably persist the credential into .hydra/agent-calls.jsonl, which logs
  // the invocation URL for every HTTP-transport call.
  if (url.username || url.password) {
    return { ok: false, message: `baseUrl must not contain inline credentials (user:pass@host); use apiKeyEnv instead` };
  }
  let pathAndQuery = `${url.pathname}${url.search}`;
  try {
    pathAndQuery = decodeURIComponent(pathAndQuery);
  } catch {
    // Malformed percent-encoding — fall back to scanning the raw (still-encoded) string.
  }
  if (isSecretShaped(pathAndQuery)) {
    return { ok: false, message: `baseUrl "${baseUrl}" appears to inline a secret in its path/query; use apiKeyEnv instead` };
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
  for (const key of ["id", "model", "command", "displayName"]) {
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
  // Scan (incl. id itself) for inlined secrets before the format check, so a
  // secret-shaped id is caught by the secrets rule rather than slipping
  // through ID_RE (many key/token shapes are valid ID_RE strings) and later
  // landing in displayName. Truncate the label - `id` may itself be the secret.
  const secret = scanForInlineSecret(d);
  if (secret) {
    const label = (id || "definition").slice(0, 12);
    return { error: `agent "${label}" appears to inline a secret ("${secret.slice(0, 12)}…"); reference it via apiKeyEnv / \${env:NAME} instead` };
  }
  if (!ID_RE.test(id)) return { error: `agent id "${String(d.id)}" must match ${ID_RE} (letters, digits, -, _)` };
  if (takenIds.has(id)) return { error: `duplicate agent id "${id}"` };
  const kind = typeof d.kind === "string" ? d.kind : "";
  if (!isAgentKind(kind)) return { error: `agent "${id}" has unknown kind "${kind}"` };
  const displayName = typeof d.displayName === "string" && d.displayName.trim() ? d.displayName.trim() : id;

  if (d.apiKeyEnv !== undefined && (typeof d.apiKeyEnv !== "string" || !isEnvVarName(d.apiKeyEnv))) {
    return { error: `agent "${id}" apiKeyEnv must be an environment-variable NAME (e.g. OPENAI_API_KEY), not a key value` };
  }
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
