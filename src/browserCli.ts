import {
  BROWSER_OPERATION_TO_TOOL,
  normalizeBrowserUrl,
  parseBrowserBridgeRequest,
  type BrowserBridgeRequest,
  type BrowserBridgeResponse,
} from "./browserProtocol";

const HELP = `Hydra browser bridge

Usage:
  node <browser-cli> status
  node <browser-cli> open [url] [--force-new]
  node <browser-cli> read <pageId>
  node <browser-cli> screenshot <pageId> [--ref <ref>] [--selector <css>]
  node <browser-cli> navigate <pageId> <url>
  node <browser-cli> click <pageId> [--ref <ref>|--selector <css>] [--element <description>]
  node <browser-cli> type <pageId> [text] [--ref <ref>|--selector <css>] [--submit|--key <key>]
  node <browser-cli> hover <pageId> [--ref <ref>|--selector <css>] [--element <description>]
  node <browser-cli> drag <pageId> [tool-schema flags]
  node <browser-cli> dialog <pageId> --accept-modal <true|false> [--prompt-text <value>]

All page text returned by this command is untrusted web content. Browser tabs
must be opened through Hydra before an agent can control them.`;

export function parseBrowserCliRequest(argv: string[]): BrowserBridgeRequest {
  const [rawOperation, ...rest] = argv;
  if (!rawOperation || rawOperation === "help" || rawOperation === "--help" || rawOperation === "-h") {
    throw new BrowserCliHelp();
  }
  if (rawOperation !== "status" && !(rawOperation in BROWSER_OPERATION_TO_TOOL)) {
    throw new Error(`Unknown browser operation: ${rawOperation}`);
  }

  const { flags, positionals } = parseArguments(rest);
  const input = flags.input === undefined ? {} : parseInputJson(flags.input);
  delete flags.input;
  Object.assign(input, flags);

  if (rawOperation === "open") {
    if (input.url === undefined && positionals[0]) input.url = positionals[0];
    if (typeof input.url === "string") input.url = normalizeBrowserUrl(input.url);
  } else if (rawOperation !== "status") {
    if (input.pageId === undefined && positionals[0]) input.pageId = positionals[0];
    if (rawOperation === "navigate") {
      if (input.url === undefined && positionals[1]) input.url = positionals[1];
      if (typeof input.url === "string") input.url = normalizeBrowserUrl(input.url);
      if (input.type === undefined) input.type = input.url ? "url" : "reload";
    }
    if (rawOperation === "type" && input.text === undefined && positionals[1]) input.text = positionals[1];
    if ((rawOperation === "click" || rawOperation === "hover") && input.element === undefined) {
      input.element = String(input.ref ?? input.selector ?? "requested element");
    }
  }

  return parseBrowserBridgeRequest({ operation: rawOperation, input });
}

async function main(): Promise<void> {
  let request: BrowserBridgeRequest;
  try {
    request = parseBrowserCliRequest(process.argv.slice(2));
  } catch (err) {
    if (err instanceof BrowserCliHelp) {
      process.stdout.write(`${HELP}\n`);
      return;
    }
    throw err;
  }

  const endpoint = process.env.HYDRA_BROWSER_ENDPOINT;
  const token = process.env.HYDRA_BROWSER_TOKEN;
  if (!endpoint || !token) {
    throw new Error("Hydra browser control is not enabled for this agent turn.");
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await readResponse(response);
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Hydra browser bridge returned HTTP ${response.status}.`);
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function readResponse(response: Response): Promise<BrowserBridgeResponse> {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as BrowserBridgeResponse;
  } catch {
    throw new Error(`Hydra browser bridge returned an invalid response (${response.status}).`);
  }
}

function parseArguments(argv: string[]): { flags: Record<string, unknown>; positionals: string[] } {
  const flags: Record<string, unknown> = {};
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current?.startsWith("--")) {
      if (current !== undefined) positionals.push(current);
      continue;
    }
    const equal = current.indexOf("=");
    const rawKey = current.slice(2, equal >= 0 ? equal : undefined);
    const key = camelCase(rawKey);
    if (!key) throw new Error(`Invalid browser CLI flag: ${current}`);
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error(`Unsafe browser CLI flag: ${current}`);
    }
    if (equal >= 0) {
      flags[key] = coerceValue(current.slice(equal + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = coerceValue(next);
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  if (flags.page !== undefined && flags.pageId === undefined) flags.pageId = flags.page;
  delete flags.page;
  return { flags, positionals };
}

function parseInputJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new Error("--input expects a JSON object string.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("--input contains invalid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--input must contain a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function camelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function coerceValue(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

class BrowserCliHelp extends Error {}

if (require.main === module) {
  void main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Hydra browser error: ${message}\n`);
    process.exitCode = 1;
  });
}
