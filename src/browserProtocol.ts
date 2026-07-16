export const BROWSER_OPERATION_TO_TOOL = {
  open: "open_browser_page",
  read: "read_page",
  screenshot: "screenshot_page",
  navigate: "navigate_page",
  click: "click_element",
  drag: "drag_element",
  hover: "hover_element",
  type: "type_in_page",
  dialog: "handle_dialog",
} as const;

export const HYDRA_BROWSER_MCP_SERVER_NAME = "hydra_vscode_browser";

export const BROWSER_OPERATION_INPUT_KEYS = {
  open: ["url", "forceNew"],
  read: ["pageId"],
  screenshot: ["pageId", "ref", "selector", "element", "scrollIntoViewIfNeeded"],
  navigate: ["pageId", "type", "url"],
  click: ["pageId", "ref", "selector", "element", "dblClick", "button"],
  drag: ["pageId", "fromRef", "fromSelector", "fromElement", "toRef", "toSelector", "toElement"],
  hover: ["pageId", "ref", "selector", "element"],
  type: ["pageId", "text", "submit", "key", "ref", "selector", "element"],
  dialog: ["pageId", "acceptModal", "promptText"],
} as const satisfies Record<keyof typeof BROWSER_OPERATION_TO_TOOL, readonly string[]>;

export type BrowserOperation = keyof typeof BROWSER_OPERATION_TO_TOOL;

export interface BrowserBridgeRequest {
  operation: BrowserOperation | "status";
  input: Record<string, unknown>;
}

export interface BrowserBridgeResponse {
  ok: boolean;
  operation?: BrowserOperation | "status";
  tool?: string;
  text?: string;
  pageId?: string;
  pages?: string[];
  availableOperations?: string[];
  files?: string[];
  truncated?: boolean;
  error?: string;
}

export interface TextStreamRedactor {
  push(value: string): string;
  flush(): string;
}

const OPERATIONS = new Set<string>(["status", ...Object.keys(BROWSER_OPERATION_TO_TOOL)]);
const MAX_INPUT_STRING_CHARS = 64_000;
const MAX_INPUT_DEPTH = 6;

export function parseBrowserBridgeRequest(value: unknown): BrowserBridgeRequest {
  if (!isRecord(value)) throw new Error("Browser request must be a JSON object.");
  const operation = value.operation;
  if (typeof operation !== "string" || !OPERATIONS.has(operation)) {
    throw new Error(`Unsupported browser operation: ${String(operation ?? "missing")}`);
  }
  const rawInput = value.input === undefined ? {} : value.input;
  if (!isRecord(rawInput)) throw new Error("Browser request input must be a JSON object.");
  validateJsonValue(rawInput, 0);
  const input: Record<string, unknown> = { ...rawInput };

  if (operation === "dialog" && input.selectFiles !== undefined) {
    throw new Error("Hydra browser control does not allow agents to select or upload local files.");
  }
  if (operation === "status" && Object.keys(input).length > 0) {
    throw new Error("Browser status does not accept input fields.");
  }
  if (operation !== "status") validateOperationInput(operation as BrowserOperation, input);

  if (operation !== "open" && operation !== "status") {
    const pageId = input.pageId;
    if (typeof pageId !== "string" || !pageId.trim() || pageId.length > 256) {
      throw new Error(`Browser operation "${operation}" requires a valid pageId.`);
    }
  }
  if (operation === "open") {
    input.url = input.url === undefined ? "about:blank" : input.url;
    input.forceNew = true;
    validateBrowserUrl(input.url);
  }
  if (operation === "navigate" && input.url !== undefined) validateBrowserUrl(input.url);
  return { operation: operation as BrowserBridgeRequest["operation"], input };
}

export function browserToolName(operation: BrowserOperation): string {
  return BROWSER_OPERATION_TO_TOOL[operation];
}

export function parseBrowserPageId(text: string): string | undefined {
  const match = /(?:^|\n)Page ID:\s*([^\s]+)/i.exec(text);
  return match?.[1]?.trim() || undefined;
}

export function normalizeBrowserUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "about:blank";
  if (trimmed === "about:blank") return trimmed;
  const hasExplicitScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed);
  const isLocal = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::|\/|$)/i.test(trimmed);
  const candidate = hasExplicitScheme ? trimmed : `${isLocal ? "http" : "https"}://${trimmed}`;
  validateBrowserUrl(candidate);
  return candidate;
}

export function withBrowserMcpArgs(agent: string, args: string[], mcpUrl: string): string[] {
  if (agent === "codex") {
    const values = [
      `mcp_servers.${HYDRA_BROWSER_MCP_SERVER_NAME}.url=${JSON.stringify(mcpUrl)}`,
      `mcp_servers.${HYDRA_BROWSER_MCP_SERVER_NAME}.bearer_token_env_var=\"HYDRA_BROWSER_TOKEN\"`,
      `mcp_servers.${HYDRA_BROWSER_MCP_SERVER_NAME}.required=true`,
    ];
    const insertion = values.flatMap((value) => args.includes(value) ? [] : ["-c", value]);
    return insertion.length === 0 ? args : insertBeforeStdinDash(args, insertion);
  }
  if (agent === "claude") {
    const allowedTool = `mcp__${HYDRA_BROWSER_MCP_SERVER_NAME}__*`;
    const config = JSON.stringify({
      mcpServers: {
        [HYDRA_BROWSER_MCP_SERVER_NAME]: {
          type: "http",
          url: mcpUrl,
          headers: { Authorization: "Bearer ${HYDRA_BROWSER_TOKEN}" },
        },
      },
    });
    // Claude's acceptEdits permission mode does not grant MCP tools in print
    // mode. Scope the non-interactive allowlist to Hydra's server namespace,
    // and keep the variadic --mcp-config option last.
    const hasAllowedTool = args.includes(allowedTool);
    const hasHydraConfig = args.some((arg) =>
      arg.includes(`\"${HYDRA_BROWSER_MCP_SERVER_NAME}\"`)
      && arg.includes(mcpUrl)
      && arg.includes("${HYDRA_BROWSER_TOKEN}"));
    if (hasAllowedTool && hasHydraConfig) return args;
    if (hasHydraConfig) {
      const configIndex = args.lastIndexOf("--mcp-config");
      if (configIndex >= 0) {
        const next = [...args];
        next.splice(configIndex, 0, "--allowedTools", allowedTool);
        return next;
      }
    }
    const insertion = [
      ...(hasAllowedTool ? [] : ["--allowedTools", allowedTool]),
      "--mcp-config",
      config,
    ];
    return [...args, ...insertion];
  }
  return args;
}

/**
 * Redacts secrets without leaking values split across adjacent process-output
 * chunks. The overlap is intentionally retained until the next chunk (or
 * flush), because child-process chunk boundaries are arbitrary.
 */
export function createSecretStreamRedactor(
  getSecrets: () => Iterable<string>,
  replacement = "[redacted-hydra-browser-token]",
): TextStreamRedactor {
  let pending = "";

  const redact = (value: string): { value: string; overlap: number } => {
    let redacted = value;
    let longest = 0;
    const secrets = [...new Set(getSecrets())]
      .filter((secret) => secret.length > 0)
      .sort((a, b) => b.length - a.length);
    for (const secret of secrets) {
      longest = Math.max(longest, secret.length);
      redacted = redacted.split(secret).join(replacement);
    }
    return { value: redacted, overlap: Math.max(0, longest - 1) };
  };

  return {
    push(value: string): string {
      pending += value;
      const result = redact(pending);
      pending = result.value;
      const emitChars = Math.max(0, pending.length - result.overlap);
      const emitted = pending.slice(0, emitChars);
      pending = pending.slice(emitChars);
      return emitted;
    },
    flush(): string {
      const emitted = redact(pending).value;
      pending = "";
      return emitted;
    },
  };
}

function validateBrowserUrl(value: unknown): void {
  if (typeof value !== "string" || value.length > 8_192) {
    throw new Error("Browser URL must be a string no longer than 8192 characters.");
  }
  if (value === "about:blank") return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid browser URL: ${value}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Hydra browser URLs must use http or https.");
  }
  // Why: userinfo in the authority is a credential-leak/phishing vector and is
  // never needed to reach a dev server; reject it rather than silently sending it.
  if (parsed.username || parsed.password) {
    throw new Error("Hydra browser URLs must not embed credentials (user:pass@host).");
  }
  // Why: link-local space (169.254.0.0/16, incl. the 169.254.169.254 cloud
  // instance-metadata endpoint, and IPv6 fe80::/10) is never a legitimate browse
  // target but is the classic SSRF-to-credentials sink. Loopback/localhost and
  // RFC1918 stay allowed on purpose: browsing a local/LAN dev server is the point.
  if (isLinkLocalHost(parsed.hostname)) {
    throw new Error("Hydra browser URLs may not target link-local or cloud-metadata addresses.");
  }
}

function isLinkLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // IPv6 link-local fe80::/10 (fe80..febf) and the fd00:ec2::254 metadata form.
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  // WHATWG URL canonicalizes ::ffff:169.254.x.x to ::ffff:a9fe:xxxx.
  // Block both mapped and deprecated compatible spellings of the same IPv4 sink.
  if (/^(?:::ffff:|::)a9fe:/.test(host)) return true;
  if (host === "fd00:ec2::254") return true;
  return false;
}

function validateJsonValue(value: unknown, depth: number): void {
  if (depth > MAX_INPUT_DEPTH) throw new Error("Browser input is nested too deeply.");
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value === "string") {
    if (value.length > MAX_INPUT_STRING_CHARS) throw new Error("A browser input string is too large.");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error("Browser input contains too many array items.");
    for (const item of value) validateJsonValue(item, depth + 1);
    return;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > 100) throw new Error("Browser input contains too many fields.");
    for (const [key, item] of entries) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new Error("Browser input contains an unsafe object key.");
      }
      validateJsonValue(item, depth + 1);
    }
    return;
  }
  throw new Error("Browser input must contain only JSON values.");
}

function validateOperationInput(operation: BrowserOperation, input: Record<string, unknown>): void {
  const allowed = new Set<string>(BROWSER_OPERATION_INPUT_KEYS[operation]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`Unsupported input field for browser ${operation}: ${key}`);
  }

  const booleanKeys = new Set(["forceNew", "scrollIntoViewIfNeeded", "dblClick", "submit", "acceptModal"]);
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (booleanKeys.has(key)) {
      if (typeof value !== "boolean") throw new Error(`Browser input ${key} must be a boolean.`);
      continue;
    }
    if (typeof value !== "string") throw new Error(`Browser input ${key} must be a string.`);
  }

  if (input.type !== undefined && !["url", "back", "forward", "reload"].includes(input.type as string)) {
    throw new Error("Browser navigate type must be url, back, forward, or reload.");
  }
  if (input.button !== undefined && !["left", "middle", "right"].includes(input.button as string)) {
    throw new Error("Browser click button must be left, middle, or right.");
  }

  const rejectConflictingLocators = (refKey: string, selectorKey: string): void => {
    if (input[refKey] !== undefined && input[selectorKey] !== undefined) {
      throw new Error(`Browser ${operation} input must use either ${refKey} or ${selectorKey}, not both.`);
    }
  };
  if (["screenshot", "click", "hover", "type"].includes(operation)) {
    rejectConflictingLocators("ref", "selector");
  } else if (operation === "drag") {
    rejectConflictingLocators("fromRef", "fromSelector");
    rejectConflictingLocators("toRef", "toSelector");
  }
  if (operation === "type" && input.text !== undefined && input.key !== undefined) {
    throw new Error("Browser type input must provide text or key, not both.");
  }
  if (operation === "type" && input.key !== undefined && input.submit !== undefined) {
    throw new Error("Browser type submit is only valid with text input.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function insertBeforeStdinDash(args: string[], insertion: string[]): string[] {
  const next = [...args];
  const dash = next.lastIndexOf("-");
  if (dash >= 0) next.splice(dash, 0, ...insertion);
  else next.push(...insertion);
  return next;
}
