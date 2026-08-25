import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TextDecoder } from "node:util";

const REQUEST_LIMIT_BYTES = 64 * 1024;
const CONTENT_LIMIT_BYTES = 32 * 1024;
const PATH_LIMIT_CHARS = 512;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface ArenaFakeHeadRequest {
  readonly schemaVersion: 1;
  readonly requestType: "arenaFakeHead";
  readonly runId: string;
  readonly contestantId: string;
  readonly traceId: string;
  readonly registrationSha256: string;
  readonly processGenerationId: string;
  readonly input: string;
  readonly inputSha256: string;
  readonly fixtureRelativePath: string;
  readonly fixtureContent: string;
  readonly untrackedRelativePath: string | null;
  readonly untrackedContent: string | null;
  readonly delayMs: number;
  readonly exitCode: number;
  readonly hang: boolean;
}

export interface ArenaFakeHeadResponse {
  readonly schemaVersion: 1;
  readonly resultType: "arenaFakeHeadResult";
  readonly runId: string;
  readonly contestantId: string;
  readonly traceId: string;
  readonly registrationSha256: string;
  readonly processGenerationId: string;
  readonly inputSha256: string;
  readonly fixtureRelativePath: string;
  readonly fixtureSha256: string;
  readonly untrackedRelativePath: string | null;
  readonly untrackedSha256: string | null;
}

export interface ArenaFakeHeadExecution {
  readonly response: ArenaFakeHeadResponse;
  readonly exitCode: number;
  readonly hang: boolean;
}

const REQUEST_KEYS = [
  "schemaVersion",
  "requestType",
  "runId",
  "contestantId",
  "traceId",
  "registrationSha256",
  "processGenerationId",
  "input",
  "inputSha256",
  "fixtureRelativePath",
  "fixtureContent",
  "untrackedRelativePath",
  "untrackedContent",
  "delayMs",
  "exitCode",
  "hang",
] as const;

export function parseArenaFakeHeadRequest(value: unknown): ArenaFakeHeadRequest {
  const row = exactRecord(value, REQUEST_KEYS, "request");
  if (row.schemaVersion !== 1 || row.requestType !== "arenaFakeHead") {
    throw new Error("request version/type is unsupported");
  }
  for (const key of [
    "runId",
    "contestantId",
    "traceId",
    "processGenerationId",
  ] as const) {
    if (typeof row[key] !== "string" || !IDENTIFIER_PATTERN.test(row[key])) {
      throw new Error(`request.${key} is not a valid Arena identifier`);
    }
  }
  if (typeof row.registrationSha256 !== "string"
    || !SHA256_PATTERN.test(row.registrationSha256)) {
    throw new Error("request.registrationSha256 is not a lowercase SHA-256 digest");
  }
  for (const key of ["input", "fixtureContent"] as const) {
    if (typeof row[key] !== "string"
      || Buffer.byteLength(row[key], "utf8") > CONTENT_LIMIT_BYTES) {
      throw new Error(`request.${key} must be a bounded string`);
    }
  }
  if (typeof row.inputSha256 !== "string"
    || !SHA256_PATTERN.test(row.inputSha256)
    || row.inputSha256 !== sha256Utf8(row.input as string)) {
    throw new Error("request.inputSha256 does not bind request.input");
  }
  assertSafeRelativePath(row.fixtureRelativePath, "request.fixtureRelativePath");
  if ((row.untrackedRelativePath === null)
    !== (row.untrackedContent === null)) {
    throw new Error("request untracked path and content must both be null or both be strings");
  }
  if (row.untrackedRelativePath !== null) {
    assertSafeRelativePath(
      row.untrackedRelativePath,
      "request.untrackedRelativePath",
    );
    if (row.untrackedRelativePath === row.fixtureRelativePath) {
      throw new Error("request fixture and untracked paths must be different");
    }
    if (typeof row.untrackedContent !== "string"
      || Buffer.byteLength(row.untrackedContent, "utf8") > CONTENT_LIMIT_BYTES) {
      throw new Error("request.untrackedContent must be a bounded string");
    }
  }
  if (!Number.isSafeInteger(row.delayMs)
    || (row.delayMs as number) < 0
    || (row.delayMs as number) > 10_000) {
    throw new Error("request.delayMs must be an integer from 0 through 10000");
  }
  if (!Number.isSafeInteger(row.exitCode)
    || (row.exitCode as number) < 0
    || (row.exitCode as number) > 125) {
    throw new Error("request.exitCode must be an integer from 0 through 125");
  }
  if (typeof row.hang !== "boolean") {
    throw new Error("request.hang must be boolean");
  }
  return Object.freeze({
    schemaVersion: 1,
    requestType: "arenaFakeHead",
    runId: row.runId as string,
    contestantId: row.contestantId as string,
    traceId: row.traceId as string,
    registrationSha256: row.registrationSha256,
    processGenerationId: row.processGenerationId as string,
    input: row.input as string,
    inputSha256: row.inputSha256,
    fixtureRelativePath: row.fixtureRelativePath,
    fixtureContent: row.fixtureContent as string,
    untrackedRelativePath: row.untrackedRelativePath as string | null,
    untrackedContent: row.untrackedContent as string | null,
    delayMs: row.delayMs as number,
    exitCode: row.exitCode as number,
    hang: row.hang,
  });
}

export async function executeArenaFakeHeadRequest(
  request: ArenaFakeHeadRequest,
  cwd: string,
): Promise<ArenaFakeHeadExecution> {
  const root = await exactRealDirectory(cwd);
  const rootStat = await fs.lstat(root);
  const fixture = await validateExistingFixture(
    root,
    request.fixtureRelativePath,
  );
  const untracked = request.untrackedRelativePath === null
    ? null
    : await validateNewFile(root, request.untrackedRelativePath);

  await assertDirectoryIdentity(root, rootStat);
  const fixtureHandle = await fs.open(
    fixture.path,
    fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
  );
  let fixtureSha256 = "";
  try {
    const opened = await fixtureHandle.stat();
    if (!sameIdentity(opened, fixture.stat)
      || !opened.isFile()
      || opened.nlink !== 1) {
      throw new Error("fixture identity changed before the edit");
    }
    await fixtureHandle.truncate(0);
    await fixtureHandle.writeFile(request.fixtureContent, "utf8");
    await fixtureHandle.sync();
    fixtureSha256 = sha256Bytes(await readAuthenticatedFile(
      fixtureHandle,
      CONTENT_LIMIT_BYTES,
    ));
    await assertOpenPathIdentity(root, rootStat, fixture.path, opened);
  } finally {
    await fixtureHandle.close();
  }

  let untrackedSha256: string | null = null;
  if (untracked !== null && request.untrackedContent !== null) {
    await assertDirectoryIdentity(root, rootStat);
    const untrackedHandle = await fs.open(
      untracked,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      const opened = await untrackedHandle.stat();
      if (!opened.isFile() || opened.nlink !== 1) {
        throw new Error("untracked target did not open as one regular file");
      }
      await untrackedHandle.writeFile(request.untrackedContent, "utf8");
      await untrackedHandle.sync();
      untrackedSha256 = sha256Bytes(await readAuthenticatedPath(
        untracked,
        opened,
      ));
      await assertOpenPathIdentity(root, rootStat, untracked, opened);
    } finally {
      await untrackedHandle.close();
    }
  }

  if (request.delayMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, request.delayMs));
  }

  return Object.freeze({
    response: Object.freeze({
      schemaVersion: 1,
      resultType: "arenaFakeHeadResult",
      runId: request.runId,
      contestantId: request.contestantId,
      traceId: request.traceId,
      registrationSha256: request.registrationSha256,
      processGenerationId: request.processGenerationId,
      inputSha256: request.inputSha256,
      fixtureRelativePath: request.fixtureRelativePath,
      fixtureSha256,
      untrackedRelativePath: request.untrackedRelativePath,
      untrackedSha256,
    }),
    exitCode: request.exitCode,
    hang: request.hang,
  });
}

export function serializeArenaFakeHeadResponse(
  response: ArenaFakeHeadResponse,
): string {
  return `${canonicalJson(response)}\n`;
}

async function main(): Promise<void> {
  try {
    const raw = await readBoundedStdin();
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    const parsed = JSON.parse(decoded) as unknown;
    const request = parseArenaFakeHeadRequest(parsed);
    const execution = await executeArenaFakeHeadRequest(request, process.cwd());
    process.stdout.write(serializeArenaFakeHeadResponse(execution.response));
    process.exitCode = execution.exitCode;
    if (execution.hang) {
      const keepAlive = setInterval(() => {}, 1_000);
      await new Promise<void>(() => {});
      clearInterval(keepAlive);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    process.stderr.write(
      `Arena fake head rejected request: ${sanitizeDiagnostic(message)}\n`,
    );
    process.exitCode = 2;
  }
}

async function readBoundedStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.length;
    if (bytes > REQUEST_LIMIT_BYTES) {
      throw new Error(`stdin exceeds ${REQUEST_LIMIT_BYTES} bytes`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, bytes);
}

async function exactRealDirectory(value: string): Promise<string> {
  if (!path.isAbsolute(value) || value !== path.resolve(value)) {
    throw new Error("cwd must be an exact normalized absolute path");
  }
  const stat = await fs.lstat(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("cwd must be a real directory");
  }
  const real = await fs.realpath(value);
  const realStat = await fs.lstat(real);
  if (!realStat.isDirectory()
    || realStat.isSymbolicLink()
    || !sameIdentity(stat, realStat)) {
    throw new Error("cwd changed identity while resolving its canonical path");
  }
  return path.resolve(real);
}

async function validateExistingFixture(
  root: string,
  relativePath: string,
): Promise<{
  readonly path: string;
  readonly stat: Awaited<ReturnType<typeof fs.lstat>>;
}> {
  const target = resolveBeneath(root, relativePath);
  await assertRealParent(root, target);
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("fixture must be one real, singly-linked regular file");
  }
  const real = await fs.realpath(target);
  if (!samePath(real, target)) {
    throw new Error("fixture path must contain no linked components");
  }
  return { path: target, stat };
}

async function validateNewFile(
  root: string,
  relativePath: string,
): Promise<string> {
  const target = resolveBeneath(root, relativePath);
  await assertRealParent(root, target);
  try {
    await fs.lstat(target);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return target;
    throw error;
  }
  throw new Error("untracked target must not already exist");
}

async function assertRealParent(root: string, target: string): Promise<void> {
  const parent = path.dirname(target);
  const stat = await fs.lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("target parent must be a real directory");
  }
  const realParent = await fs.realpath(parent);
  if (!isPathAtOrBelow(root, realParent) || !samePath(realParent, parent)) {
    throw new Error("target parent escapes through a linked component");
  }
}

function resolveBeneath(root: string, relativePath: string): string {
  assertSafeRelativePath(relativePath, "relativePath");
  const target = path.resolve(root, relativePath);
  if (!isPathAtOrBelow(root, target) || samePath(root, target)) {
    throw new Error("target path escapes cwd");
  }
  return target;
}

function assertSafeRelativePath(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string"
    || value.length < 1
    || value.length > PATH_LIMIT_CHARS
    || value.includes("\u0000")
    || path.isAbsolute(value)) {
    throw new Error(`${label} must be a bounded relative path`);
  }
  const normalized = path.normalize(value);
  if (normalized === "."
    || normalized === ".."
    || normalized.startsWith(`..${path.sep}`)
    || normalized !== value) {
    throw new Error(`${label} must be an exact normalized relative path`);
  }
  if (path.dirname(normalized) !== ".") {
    throw new Error(
      `${label} must name a direct child of the authenticated fake-head cwd`,
    );
  }
}

async function assertDirectoryIdentity(
  directory: string,
  expected: Awaited<ReturnType<typeof fs.lstat>>,
): Promise<void> {
  const current = await fs.lstat(directory);
  if (!current.isDirectory()
    || current.isSymbolicLink()
    || !sameIdentity(current, expected)
    || !samePath(await fs.realpath(directory), directory)) {
    throw new Error("fake-head cwd identity changed during the edit");
  }
}

async function assertOpenPathIdentity(
  root: string,
  rootStat: Awaited<ReturnType<typeof fs.lstat>>,
  target: string,
  opened: Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>["stat"]>>,
): Promise<void> {
  await assertDirectoryIdentity(root, rootStat);
  const current = await fs.lstat(target);
  if (!current.isFile()
    || current.isSymbolicLink()
    || current.nlink !== 1
    || !sameIdentity(current, opened)
    || !samePath(await fs.realpath(target), target)
    || !isPathAtOrBelow(root, target)) {
    throw new Error("fake-head target identity changed during the edit");
  }
}

async function readAuthenticatedFile(
  handle: Awaited<ReturnType<typeof fs.open>>,
  maxBytes: number,
): Promise<Buffer> {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size > maxBytes) {
    throw new Error("fake-head written file exceeds its bounded read-back");
  }
  const output = Buffer.alloc(stat.size);
  let offset = 0;
  while (offset < output.length) {
    const read = await handle.read(
      output,
      offset,
      output.length - offset,
      offset,
    );
    if (read.bytesRead < 1) {
      throw new Error("fake-head written file ended during read-back");
    }
    offset += read.bytesRead;
  }
  return output;
}

async function readAuthenticatedPath(
  target: string,
  expected: Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>["stat"]>>,
): Promise<Buffer> {
  const handle = await fs.open(
    target,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (!sameIdentity(opened, expected)
      || !opened.isFile()
      || opened.nlink !== 1) {
      throw new Error("fake-head untracked identity changed before read-back");
    }
    return await readAuthenticatedFile(handle, CONTENT_LIMIT_BYTES);
  } finally {
    await handle.close();
  }
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  const row = value as Record<string, unknown>;
  const actual = Object.keys(row).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly the supported keys`);
  }
  return row;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error("fake-head JSON rejects non-finite numbers and negative zero");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (!value
    || typeof value !== "object"
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("fake-head JSON requires plain JSON values");
  }
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => {
    const entry = row[key];
    if (entry === undefined) {
      throw new Error("fake-head JSON rejects undefined values");
    }
    return `${JSON.stringify(key)}:${canonicalJson(entry)}`;
  }).join(",")}}`;
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/(?:system|assistant|user)\s*:/gi, "[role]:")
    .slice(0, 300);
}

function sameIdentity(
  left: { readonly dev: number | bigint; readonly ino: number | bigint },
  right: { readonly dev: number | bigint; readonly ino: number | bigint },
): boolean {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino);
}

function isPathAtOrBelow(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

if (require.main === module) {
  void main();
}
