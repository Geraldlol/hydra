import { lookup as dnsLookup } from "node:dns/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { performance } from "node:perf_hooks";

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024;

export interface WebhookResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type WebhookResolver = (hostname: string) => Promise<readonly WebhookResolvedAddress[]>;
export type PublicHttpsResolver = WebhookResolver;

export type PinnedWebhookLookup = (
  hostname: string,
  options: object,
  callback: (error: NodeJS.ErrnoException | null, address: string, family: 4 | 6) => void,
) => void;
export type PinnedHttpsLookup = PinnedWebhookLookup;

export interface PinnedWebhookRequest {
  readonly url: URL;
  readonly hostname: string;
  readonly address: string;
  readonly family: 4 | 6;
  readonly lookup: PinnedWebhookLookup;
  readonly body: string;
  readonly timeoutMs: number;
  /** Absolute monotonic deadline shared by DNS resolution and HTTPS I/O. */
  readonly deadline: number;
  readonly maxResponseBytes: number;
}

export interface WebhookDispatchResponse {
  readonly ok: boolean;
  readonly status: number;
}

export type WebhookDispatcher = (request: PinnedWebhookRequest) => Promise<WebhookDispatchResponse>;

export type HttpsRequestFactory = (
  url: URL,
  options: https.RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

export interface WebhookDispatchOptions {
  readonly resolver?: WebhookResolver;
  readonly dispatcher?: WebhookDispatcher;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export class UnsafeHttpsDestinationError extends Error {
  constructor(message = "HTTPS destination must resolve only to public addresses.") {
    super(message);
    this.name = "UnsafeHttpsDestinationError";
  }
}

export { UnsafeHttpsDestinationError as UnsafeWebhookDestinationError };

export class WebhookDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookDispatchError";
  }
}

const BLOCKED_IPV4_CIDRS: readonly (readonly [number, number])[] = [
  [0x00000000, 8], // Current network, including the unspecified address.
  [0x0a000000, 8], // Private use.
  [0x64400000, 10], // Shared address space (CGNAT).
  [0x7f000000, 8], // Loopback.
  [0xa9fe0000, 16], // Link-local.
  [0xac100000, 12], // Private use.
  [0xc0000000, 24], // IETF protocol assignments and NAT64 discovery.
  [0xc0000200, 24], // TEST-NET-1.
  [0xc01fc400, 24], // AS112-v4.
  [0xc034c100, 24], // AMT.
  [0xc0586300, 24], // Deprecated 6to4 relay anycast.
  [0xc0a80000, 16], // Private use.
  [0xc0af3000, 24], // Direct Delegation AS112 service.
  [0xc6120000, 15], // Benchmarking.
  [0xc6336400, 24], // TEST-NET-2.
  [0xcb007100, 24], // TEST-NET-3.
  [0xe0000000, 4], // Multicast.
  [0xf0000000, 4], // Reserved, including limited broadcast.
];

function normalizeHostname(hostname: string): string {
  const lower = hostname.trim().toLowerCase();
  const unbracketed = lower.startsWith("[") && lower.endsWith("]")
    ? lower.slice(1, -1)
    : lower;
  return unbracketed.endsWith(".") ? unbracketed.slice(0, -1) : unbracketed;
}

function parseIpv4(address: string): readonly [number, number, number, number] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = parts.map((part) => (/^(?:0|[1-9][0-9]{0,2})$/u.test(part) ? Number(part) : -1));
  if (bytes.some((byte) => byte < 0 || byte > 255)) return undefined;
  return [bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!];
}

function ipv4Number(bytes: readonly [number, number, number, number]): number {
  return ((((bytes[0] * 256) + bytes[1]) * 256 + bytes[2]) * 256 + bytes[3]) >>> 0;
}

function ipv4InCidr(address: number, network: number, prefixLength: number): boolean {
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (address & mask) >>> 0 === (network & mask) >>> 0;
}

function parseIpv6(address: string): Uint8Array | undefined {
  let source = normalizeHostname(address);
  if (!source || source.includes("%") || source.split("::").length > 2) return undefined;

  if (source.includes(".")) {
    const lastColon = source.lastIndexOf(":");
    if (lastColon < 0) return undefined;
    const embedded = parseIpv4(source.slice(lastColon + 1));
    if (!embedded) return undefined;
    const high = ((embedded[0] << 8) | embedded[1]).toString(16);
    const low = ((embedded[2] << 8) | embedded[3]).toString(16);
    source = `${source.slice(0, lastColon)}:${high}:${low}`;
  }

  const compressed = source.includes("::");
  const [leftSource = "", rightSource = ""] = source.split("::");
  const left = leftSource ? leftSource.split(":") : [];
  const right = compressed && rightSource ? rightSource.split(":") : [];
  if ((!compressed && left.length !== 8) || (compressed && left.length + right.length >= 8)) return undefined;

  const missing = compressed ? 8 - left.length - right.length : 0;
  const words = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/u.test(word))) return undefined;

  const bytes = new Uint8Array(16);
  for (let index = 0; index < words.length; index += 1) {
    const word = Number.parseInt(words[index]!, 16);
    bytes[index * 2] = word >>> 8;
    bytes[index * 2 + 1] = word & 0xff;
  }
  return bytes;
}

function hasIpv6Prefix(address: Uint8Array, prefix: Uint8Array, prefixLength: number): boolean {
  const fullBytes = Math.floor(prefixLength / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (address[index] !== prefix[index]) return false;
  }
  const remainingBits = prefixLength % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (address[fullBytes]! & mask) === (prefix[fullBytes]! & mask);
}

function ipv6Prefix(address: string): Uint8Array {
  const parsed = parseIpv6(address);
  if (!parsed) throw new Error(`Invalid built-in IPv6 prefix: ${address}`);
  return parsed;
}

const BLOCKED_IPV6_CIDRS: readonly (readonly [Uint8Array, number])[] = [
  [ipv6Prefix("2001::"), 23], // IETF protocol assignments and transition ranges.
  [ipv6Prefix("2001:db8::"), 32], // Documentation.
  [ipv6Prefix("2002::"), 16], // Deprecated 6to4.
  [ipv6Prefix("2620:4f:8000::"), 48], // Direct Delegation AS112 service.
  [ipv6Prefix("3fff::"), 20], // Documentation.
];

function isIpv4MappedIpv6(address: Uint8Array): boolean {
  for (let index = 0; index < 10; index += 1) {
    if (address[index] !== 0) return false;
  }
  return address[10] === 0xff && address[11] === 0xff;
}

export function isPublicWebhookAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);
  if (family === 4) {
    const bytes = parseIpv4(normalized);
    if (!bytes) return false;
    const value = ipv4Number(bytes);
    return !BLOCKED_IPV4_CIDRS.some(([network, prefixLength]) => ipv4InCidr(value, network, prefixLength));
  }
  if (family !== 6) return false;
  const bytes = parseIpv6(normalized);
  if (!bytes || isIpv4MappedIpv6(bytes)) return false;
  // Today's allocatable global-unicast space is 2000::/3. Rejecting addresses
  // outside it fails closed for unspecified, loopback, ULA, link-local,
  // multicast, discard-only, NAT64, and other reserved/special ranges.
  if ((bytes[0]! & 0xe0) !== 0x20) return false;
  return !BLOCKED_IPV6_CIDRS.some(([prefix, prefixLength]) => hasIpv6Prefix(bytes, prefix, prefixLength));
}

export function isBlockedWebhookHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (!host) return true;
  if (isIP(host) !== 0) return !isPublicWebhookAddress(host);
  return host === "localhost"
    || host.endsWith(".localhost")
    || host === "metadata"
    || host === "metadata.google.internal"
    || host === "internal"
    || host.endsWith(".internal")
    || host === "local"
    || host.endsWith(".local")
    || host === "home.arpa"
    || host.endsWith(".home.arpa");
}

const systemResolver: WebhookResolver = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => {
    if (family !== 4 && family !== 6) {
      throw new UnsafeHttpsDestinationError("HTTPS DNS returned an unsupported address family.");
    }
    return { address, family };
  });
};

function pinnedLookup(hostname: string, address: string, family: 4 | 6): PinnedWebhookLookup {
  return (requestedHostname, _options, callback) => {
    if (normalizeHostname(requestedHostname) !== hostname) {
      const error = new Error("Pinned webhook lookup received an unexpected hostname.") as NodeJS.ErrnoException;
      error.code = "ENOTFOUND";
      callback(error, "", family);
      return;
    }
    callback(null, address, family);
  };
}

export interface PublicHttpsDestination {
  readonly hostname: string;
  readonly address: string;
  readonly family: 4 | 6;
  readonly lookup: PinnedHttpsLookup;
}

export async function resolvePublicHttpsDestination(
  url: URL,
  resolver: PublicHttpsResolver = systemResolver,
): Promise<PublicHttpsDestination> {
  if (url.protocol !== "https:") {
    throw new UnsafeHttpsDestinationError("Destination must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new UnsafeHttpsDestinationError("HTTPS destination must not contain URL credentials.");
  }
  const hostname = normalizeHostname(url.hostname);
  if (isBlockedWebhookHost(hostname)) throw new UnsafeHttpsDestinationError();

  const literalFamily = isIP(hostname);
  const answers: readonly WebhookResolvedAddress[] = literalFamily === 4 || literalFamily === 6
    ? [{ address: hostname, family: literalFamily }]
    : await resolver(hostname);
  if (answers.length === 0) {
    throw new UnsafeHttpsDestinationError("HTTPS destination did not resolve to an address.");
  }

  const normalizedAnswers: WebhookResolvedAddress[] = answers.map((answer) => {
    const address = normalizeHostname(answer.address);
    const detectedFamily = isIP(address);
    if ((detectedFamily !== 4 && detectedFamily !== 6) || detectedFamily !== answer.family) {
      throw new UnsafeHttpsDestinationError("HTTPS DNS returned an invalid address.");
    }
    if (!isPublicWebhookAddress(address)) throw new UnsafeHttpsDestinationError();
    return { address, family: detectedFamily === 4 ? 4 : 6 };
  });
  const selected = normalizedAnswers[0]!;
  return {
    hostname,
    address: selected.address,
    family: selected.family,
    lookup: pinnedLookup(hostname, selected.address, selected.family),
  };
}

const systemRequest: HttpsRequestFactory = (url, options, onResponse) => https.request(url, options, onResponse);

export async function dispatchPinnedHttpsWebhook(
  request: PinnedWebhookRequest,
  requestFactory: HttpsRequestFactory = systemRequest,
): Promise<WebhookDispatchResponse> {
  timeRemainingMs(request.deadline, "Webhook HTTPS request timed out.");
  const hostname = normalizeHostname(request.hostname);
  const address = normalizeHostname(request.address);
  if (request.url.protocol !== "https:" || normalizeHostname(request.url.hostname) !== hostname) {
    throw new UnsafeHttpsDestinationError("Pinned webhook authority does not match its HTTPS URL.");
  }
  if (!isPublicWebhookAddress(address) || isIP(address) !== request.family) {
    throw new UnsafeHttpsDestinationError();
  }
  const validatedLookup = pinnedLookup(hostname, address, request.family);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let response: IncomingMessage | undefined;
    let clientRequest: ClientRequest | undefined;

    const finish = (result: WebhookDispatchResponse): void => {
      if (settled) return;
      if (performance.now() >= request.deadline) {
        const error = new WebhookDispatchError("Webhook HTTPS request timed out.");
        clientRequest?.destroy(error);
        fail(error);
        return;
      }
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      response?.destroy();
      reject(error instanceof Error ? error : new WebhookDispatchError(String(error)));
    };

    try {
      clientRequest = requestFactory(request.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(request.body),
        },
        lookup: validatedLookup as unknown as LookupFunction,
        family: request.family,
        agent: false,
        servername: isIP(hostname) === 0 ? hostname : undefined,
        rejectUnauthorized: true,
      }, (incoming) => {
        response = incoming;
        let receivedBytes = 0;
        const declaredLength = incoming.headers["content-length"];
        if (typeof declaredLength === "string"
          && /^[0-9]+$/u.test(declaredLength)
          && Number(declaredLength) > request.maxResponseBytes) {
          clientRequest?.destroy();
          fail(new WebhookDispatchError("Webhook response body exceeded the configured limit."));
          return;
        }
        incoming.on("data", (chunk: Buffer | string) => {
          receivedBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
          if (receivedBytes > request.maxResponseBytes) {
            clientRequest?.destroy();
            fail(new WebhookDispatchError("Webhook response body exceeded the configured limit."));
          }
        });
        incoming.once("aborted", () => fail(new WebhookDispatchError("Webhook response was aborted.")));
        incoming.once("error", fail);
        incoming.once("end", () => {
          const status = incoming.statusCode ?? 0;
          finish({ status, ok: status >= 200 && status < 300 });
        });
        incoming.resume();
      });
    } catch (error) {
      fail(error);
      return;
    }

    clientRequest.once("error", fail);
    let requestTimeRemaining: number;
    try {
      requestTimeRemaining = timeRemainingMs(request.deadline, "Webhook HTTPS request timed out.");
    } catch (error) {
      clientRequest.destroy(error instanceof Error ? error : undefined);
      fail(error);
      return;
    }
    timeout = setTimeout(() => {
      const error = new WebhookDispatchError("Webhook HTTPS request timed out.");
      clientRequest?.destroy(error);
      fail(error);
    }, requestTimeRemaining);
    timeout.unref();
    try {
      clientRequest.end(request.body);
    } catch (error) {
      clientRequest.destroy();
      fail(error);
    }
  });
}

function timeRemainingMs(deadline: number, message: string): number {
  if (!Number.isFinite(deadline)) throw new WebhookDispatchError(message);
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining <= 0) throw new WebhookDispatchError(message);
  return remaining;
}

function settleBeforeDeadline<T>(operation: Promise<T>, deadline: number, message: string): Promise<T> {
  let remaining: number;
  try {
    remaining = timeRemainingMs(deadline, message);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new WebhookDispatchError(message));
    }, remaining);
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    operation.then(
      (value) => finish(() => {
        if (performance.now() >= deadline) reject(new WebhookDispatchError(message));
        else resolve(value);
      }),
      (error: unknown) => finish(() => {
        if (performance.now() >= deadline) reject(new WebhookDispatchError(message));
        else reject(error);
      }),
    );
  });
}

export async function dispatchWebhookJson(
  url: URL,
  payload: unknown,
  options: WebhookDispatchOptions = {},
): Promise<WebhookDispatchResponse> {
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? WEBHOOK_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new WebhookDispatchError("Invalid webhook timeout.");
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new WebhookDispatchError("Invalid webhook response-body limit.");
  }
  const deadline = performance.now() + timeoutMs;
  const body = JSON.stringify(payload);
  if (body === undefined) throw new WebhookDispatchError("Webhook payload is not JSON-serializable.");

  const destination = await settleBeforeDeadline(
    resolvePublicHttpsDestination(url, options.resolver),
    deadline,
    "Webhook DNS resolution timed out.",
  );
  const dispatch = options.dispatcher ?? dispatchPinnedHttpsWebhook;
  const requestTimeoutMs = timeRemainingMs(deadline, "Webhook dispatch timed out.");
  let dispatchOperation: Promise<WebhookDispatchResponse>;
  try {
    dispatchOperation = Promise.resolve(dispatch({
      url,
      hostname: destination.hostname,
      address: destination.address,
      family: destination.family,
      lookup: destination.lookup,
      body,
      timeoutMs: requestTimeoutMs,
      deadline,
      maxResponseBytes,
    }));
  } catch (error) {
    throw error instanceof Error ? error : new WebhookDispatchError(String(error));
  }
  const response = await settleBeforeDeadline(dispatchOperation, deadline, "Webhook dispatch timed out.");
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    throw new WebhookDispatchError("Webhook dispatcher returned an invalid HTTP status.");
  }
  if (response.status >= 300 && response.status < 400) {
    throw new WebhookDispatchError("Webhook redirect responses are not allowed.");
  }
  return { status: response.status, ok: response.status >= 200 && response.status < 300 };
}
