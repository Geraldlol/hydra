import { createHash } from "node:crypto";

export type PromptContextComponent = readonly [
  label: string,
  value: string | undefined,
];

/**
 * Commits to the exact dynamic strings supplied to a prompt builder without
 * retaining those strings. Fixed caller order, an explicit absent marker,
 * UTF-16 character counts, and per-component hashes make composition changes
 * visible while keeping the final root bounded.
 */
export function promptContextSha256(
  components: readonly PromptContextComponent[],
): string {
  const commitment = [
    "hydra.prompt-components.v1",
    ...components.map(([label, value]) => value === undefined
      ? [label, "absent", 0, null]
      : [label, "present", value.length, sha256Utf8(value)]),
  ];
  return sha256Utf8(JSON.stringify(commitment));
}

/**
 * Attaches an ephemeral private commitment to an otherwise persistable
 * envelope. JSON serialization and object spread deliberately omit it.
 */
export function withPrivateFlightContextCommitment<
  T extends object,
  K extends string = "flightContextSha256",
>(
  envelope: T,
  commitment: string,
  key = "flightContextSha256" as K,
): T & Readonly<Record<K, string>> {
  Object.defineProperty(envelope, key, {
    value: commitment,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return envelope as T & Readonly<Record<K, string>>;
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
