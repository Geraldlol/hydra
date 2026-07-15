const HTTP_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface ConfiguredHeadersResult {
  headers?: Record<string, string>;
  error?: string;
}

export function isSafeHttpHeaderName(name: string): boolean {
  return HTTP_HEADER_NAME_RE.test(name) && !PROTOTYPE_KEYS.has(name.toLowerCase());
}

export function isSafeHttpHeaderValue(value: string): boolean {
  return !/[\0\r\n]/.test(value);
}

/** Validate untyped settings before they enter fetch's header dictionary. */
export function validateConfiguredHeaders(raw: unknown): ConfiguredHeadersResult {
  if (raw === undefined) return { headers: undefined };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "headers must be an object whose values are strings" };
  }

  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSafeHttpHeaderName(name)) {
      return { error: `header name "${name}" is invalid` };
    }
    if (typeof value !== "string") {
      return { error: `header "${name}" must have a string value` };
    }
    if (!isSafeHttpHeaderValue(value)) {
      return { error: `header "${name}" must not contain NUL or newline characters` };
    }
    headers[name] = value;
  }
  return { headers };
}
