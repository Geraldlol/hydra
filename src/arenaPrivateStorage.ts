import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { serializePerFileAcrossProcesses } from "./fileQueue";

export interface ArenaPrivateStorageBoundary {
  readonly privateWorkspaceRoot: string;
  readonly realPrivateWorkspaceRoot: string;
  readonly privateWorkspaceIdentity: ArenaDirectoryIdentity;
  readonly logicalRoot: string;
  readonly realRoot: string;
  readonly rootIdentity: ArenaDirectoryIdentity;
  readonly logicalLockRoot: string;
  readonly realLockRoot: string;
  readonly lockRootIdentity: ArenaDirectoryIdentity;
}

export interface ArenaDirectoryIdentity {
  readonly dev: string;
  readonly ino: string;
}

const FIXED_ARENA_DIRECTORIES = Object.freeze([
  "runs",
  "artifacts",
  "worktrees",
  "registrations",
  "support",
] as const);
const MAX_PRIVATE_DIRECTORY_ENTRIES = 4_096;
const PRIVATE_TEMP_UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * Establish the extension-private Arena root without accepting linked parents.
 * The caller still decides which workspace this private root belongs to.
 */
export async function prepareArenaPrivateStorage(
  privateWorkspaceRoot: string,
): Promise<ArenaPrivateStorageBoundary> {
  const logicalPrivateRoot = path.resolve(privateWorkspaceRoot);
  await fs.mkdir(logicalPrivateRoot, { recursive: true, mode: 0o700 });
  const privateStat = await fs.lstat(logicalPrivateRoot);
  if (!privateStat.isDirectory() || privateStat.isSymbolicLink()) {
    throw new Error("Arena private workspace root must be a real directory.");
  }
  const realPrivateRoot = await fs.realpath(logicalPrivateRoot);
  const logicalRoot = path.join(logicalPrivateRoot, "arena");
  await fs.mkdir(logicalRoot, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const rootStat = await fs.lstat(logicalRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Arena private storage root must be a real directory.");
  }
  const realRoot = await fs.realpath(logicalRoot);
  if (!isPathWithin(realPrivateRoot, realRoot)
    || samePath(realPrivateRoot, realRoot)) {
    throw new Error("Arena private storage root escapes its workspace storage.");
  }
  await fs.chmod(logicalRoot, 0o700).catch(() => undefined);

  for (const directory of FIXED_ARENA_DIRECTORIES) {
    await createCheckedPrivateDirectory(realRoot, path.join(logicalRoot, directory));
  }
  const logicalLockRoot = path.join(logicalRoot, "support", "locks");
  await createCheckedPrivateDirectory(realRoot, logicalLockRoot);
  const [privateIdentityStat, rootIdentityStat, lockIdentityStat] =
    await Promise.all([
      fs.lstat(logicalPrivateRoot),
      fs.lstat(logicalRoot),
      fs.lstat(logicalLockRoot),
    ]);
  const boundary: ArenaPrivateStorageBoundary = Object.freeze({
    privateWorkspaceRoot: logicalPrivateRoot,
    realPrivateWorkspaceRoot: realPrivateRoot,
    privateWorkspaceIdentity: directoryIdentity(privateIdentityStat),
    logicalRoot,
    realRoot,
    rootIdentity: directoryIdentity(rootIdentityStat),
    logicalLockRoot,
    realLockRoot: await fs.realpath(logicalLockRoot),
    lockRootIdentity: directoryIdentity(lockIdentityStat),
  });
  await assertArenaPrivateBoundary(boundary);
  return boundary;
}

export async function ensureArenaPrivateDirectory(
  boundary: ArenaPrivateStorageBoundary,
  segments: readonly string[],
): Promise<string> {
  await assertArenaPrivateBoundary(boundary);
  if (segments.length === 0) return boundary.logicalRoot;
  let current = boundary.logicalRoot;
  for (const segment of segments) {
    assertPrivateSegment(segment);
    const candidate = path.join(current, segment);
    assertLexicalContainment(boundary.logicalRoot, candidate);
    await fs.mkdir(candidate, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const stat = await fs.lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Arena private directory is linked or invalid: ${candidate}`);
    }
    const realCandidate = await fs.realpath(candidate);
    if (!isPathWithin(boundary.realRoot, realCandidate)
      || samePath(boundary.realRoot, realCandidate)) {
      throw new Error(`Arena private directory escapes storage root: ${candidate}`);
    }
    await fs.chmod(candidate, 0o700).catch(() => undefined);
    current = candidate;
  }
  await assertArenaPrivateDirectory(current, boundary);
  return current;
}

export async function assertArenaPrivateDirectory(
  directory: string,
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  await assertArenaPrivateBoundary(boundary);
  const absolute = path.resolve(directory);
  assertLexicalContainment(boundary.logicalRoot, absolute);
  if (samePath(absolute, boundary.logicalRoot)) return;
  const relative = path.relative(boundary.logicalRoot, absolute);
  let current = boundary.logicalRoot;
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    const component = await fs.lstat(current);
    if (!component.isDirectory() || component.isSymbolicLink()) {
      throw new Error(
        `Arena private directory component is linked or invalid: ${current}`,
      );
    }
  }
  const realDirectory = await fs.realpath(absolute);
  if (!isPathWithin(boundary.realRoot, realDirectory)
    || samePath(boundary.realRoot, realDirectory)) {
    throw new Error(`Arena private directory escapes storage root: ${directory}`);
  }
}

export async function assertArenaPrivateBoundary(
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  const [privateStat, rootStat, lockStat] = await Promise.all([
    fs.lstat(boundary.privateWorkspaceRoot),
    fs.lstat(boundary.logicalRoot),
    fs.lstat(boundary.logicalLockRoot),
  ]);
  if (!privateStat.isDirectory()
    || privateStat.isSymbolicLink()
    || !rootStat.isDirectory()
    || rootStat.isSymbolicLink()
    || !lockStat.isDirectory()
    || lockStat.isSymbolicLink()) {
    throw new Error("Arena private storage boundary became linked or invalid.");
  }
  const [realPrivate, realRoot, realLockRoot] = await Promise.all([
    fs.realpath(boundary.privateWorkspaceRoot),
    fs.realpath(boundary.logicalRoot),
    fs.realpath(boundary.logicalLockRoot),
  ]);
  if (!samePath(realPrivate, boundary.realPrivateWorkspaceRoot)
    || !samePath(realRoot, boundary.realRoot)
    || !samePath(realLockRoot, boundary.realLockRoot)
    || !sameDirectoryIdentity(
      directoryIdentity(privateStat),
      boundary.privateWorkspaceIdentity,
    )
    || !sameDirectoryIdentity(
      directoryIdentity(rootStat),
      boundary.rootIdentity,
    )
    || !sameDirectoryIdentity(
      directoryIdentity(lockStat),
      boundary.lockRootIdentity,
    )) {
    throw new Error("Arena private storage boundary changed identity.");
  }
}

export async function serializeArenaPrivateWork<T>(
  boundary: ArenaPrivateStorageBoundary,
  identity: string,
  work: () => Promise<T>,
): Promise<T> {
  await assertArenaPrivateBoundary(boundary);
  const lockName = createHash("sha256")
    .update("hydra.arena.private-lock.v1\u0000", "utf8")
    .update(identity, "utf8")
    .digest("hex");
  const lockPath = path.join(boundary.realLockRoot, `${lockName}.v1`);
  return serializePerFileAcrossProcesses(lockPath, async () => {
    await assertArenaPrivateBoundary(boundary);
    try {
      return await work();
    } finally {
      await assertArenaPrivateBoundary(boundary);
    }
  });
}

async function createCheckedPrivateDirectory(
  realRoot: string,
  candidate: string,
): Promise<void> {
  await fs.mkdir(candidate, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const stat = await fs.lstat(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Arena private directory is linked or invalid: ${candidate}`);
  }
  const realCandidate = await fs.realpath(candidate);
  if (!isPathWithin(realRoot, realCandidate)
    || samePath(realRoot, realCandidate)) {
    throw new Error(`Arena private directory escapes storage root: ${candidate}`);
  }
  await fs.chmod(candidate, 0o700).catch(() => undefined);
}

function directoryIdentity(stat: Stats): ArenaDirectoryIdentity {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
  });
}

function sameDirectoryIdentity(
  left: ArenaDirectoryIdentity,
  right: ArenaDirectoryIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function assertArenaPrivateParent(
  filePath: string,
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  const absolute = path.resolve(filePath);
  assertLexicalContainment(boundary.logicalRoot, absolute);
  if (samePath(absolute, boundary.logicalRoot)) {
    throw new Error("Arena private files cannot replace the storage root.");
  }
  await assertArenaPrivateDirectory(path.dirname(absolute), boundary);
}

export async function createArenaPrivateFile(
  filePath: string,
  content: Buffer | string,
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  const absoluteFilePath = path.resolve(filePath);
  await assertArenaPrivateParent(absoluteFilePath, boundary);
  const parentPath = path.dirname(absoluteFilePath);
  const parentIdentity = await capturePrivateDirectoryIdentity(
    parentPath,
    boundary,
  );
  const tmpPath = path.join(
    parentPath,
    `.${path.basename(absoluteFilePath)}.${process.pid}-${randomUUID()}.tmp`,
  );
  const expectedBytes = Buffer.isBuffer(content)
    ? content.byteLength
    : Buffer.byteLength(content, "utf8");
  let handle: fs.FileHandle | undefined;
  let temporaryIdentity: Stats | undefined;
  let primaryError: unknown;
  try {
    handle = await fs.open(tmpPath, "wx", 0o600);
    await assertExpectedPrivateDirectory(
      parentPath,
      parentIdentity,
      boundary,
    );
    const [opened, entry] = await Promise.all([
      handle.stat(),
      fs.lstat(tmpPath),
    ]);
    assertSafePrivateFile(opened, tmpPath);
    assertSafePrivateFile(entry, tmpPath);
    if (!sameFileIdentity(opened, entry)) {
      throw new Error(
        `Arena private temporary file changed while opening: ${tmpPath}`,
      );
    }
    temporaryIdentity = opened;
    await handle.writeFile(content);
    await handle.chmod(0o600).catch(() => undefined);
    await handle.sync();

    const sealed = await handle.stat();
    const sealedEntry = await fs.lstat(tmpPath);
    assertSafePrivateFile(sealed, tmpPath);
    assertSafePrivateFile(sealedEntry, tmpPath);
    if (!sameFileIdentity(opened, sealed)
      || !sameFileIdentity(sealed, sealedEntry)
      || sealed.size !== expectedBytes) {
      throw new Error(
        `Arena private temporary file changed before publication: ${tmpPath}`,
      );
    }
    await assertExpectedPrivateDirectory(
      parentPath,
      parentIdentity,
      boundary,
    );

    // Hard-linking is the portable no-replace commit primitive available in
    // Node on both Windows and POSIX. The final entry is created atomically
    // only after the same-directory temporary file is complete and fsynced.
    // Unlike rename(), link() never replaces an existing destination.
    await fs.link(tmpPath, absoluteFilePath);

    const [openedAfterLink, temporaryAfterLink, published] =
      await Promise.all([
        handle.stat(),
        fs.lstat(tmpPath),
        fs.lstat(absoluteFilePath),
      ]);
    assertPrivatePublicationLink(openedAfterLink, tmpPath);
    assertPrivatePublicationLink(temporaryAfterLink, tmpPath);
    assertPrivatePublicationLink(published, absoluteFilePath);
    if (!sameFileIdentity(temporaryIdentity, openedAfterLink)
      || !sameFileIdentity(openedAfterLink, temporaryAfterLink)
      || !sameFileIdentity(temporaryAfterLink, published)
      || openedAfterLink.size !== expectedBytes
      || published.size !== expectedBytes) {
      throw new Error(
        `Arena private file changed during publication: ${absoluteFilePath}`,
      );
    }
    await assertExpectedPrivateDirectory(
      parentPath,
      parentIdentity,
      boundary,
    );
    await syncPrivateDirectory(parentPath, parentIdentity, boundary);

    await removeExpectedPrivateFile(
      tmpPath,
      temporaryIdentity,
      parentPath,
      parentIdentity,
      boundary,
    );
    const [openedAfterCleanup, finalEntry] = await Promise.all([
      handle.stat(),
      fs.lstat(absoluteFilePath),
    ]);
    assertSafePrivateFile(openedAfterCleanup, absoluteFilePath);
    assertSafePrivateFile(finalEntry, absoluteFilePath);
    if (!sameFileIdentity(temporaryIdentity, openedAfterCleanup)
      || !sameFileIdentity(openedAfterCleanup, finalEntry)
      || openedAfterCleanup.size !== expectedBytes
      || finalEntry.size !== expectedBytes) {
      throw new Error(
        `Arena private file changed after publication: ${absoluteFilePath}`,
      );
    }
    await assertExpectedPrivateDirectory(
      parentPath,
      parentIdentity,
      boundary,
    );
    await syncPrivateDirectory(parentPath, parentIdentity, boundary);
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown;
  if (temporaryIdentity) {
    try {
      await removeExpectedPrivateFile(
        tmpPath,
        temporaryIdentity,
        parentPath,
        parentIdentity,
        boundary,
      );
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    await handle?.close();
  } catch (error) {
    cleanupError ??= error;
  }
  if (primaryError
    && (primaryError as NodeJS.ErrnoException).code === "EEXIST"
    && !cleanupError) {
    try {
      // A prior process may have died after the atomic link commit but before
      // removing its temporary name. Normalize only an exact, dead-publisher
      // pair; a live or ambiguous publisher remains fail-closed.
      await recoverInterruptedPrivatePublication(
        absoluteFilePath,
        boundary,
      );
    } catch (error) {
      cleanupError = error;
    }
  }
  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      `Arena private file publication and cleanup failed: ${absoluteFilePath}`,
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}

async function capturePrivateDirectoryIdentity(
  directory: string,
  boundary: ArenaPrivateStorageBoundary,
): Promise<ArenaDirectoryIdentity> {
  await assertArenaPrivateDirectory(directory, boundary);
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Arena private directory is linked or invalid: ${directory}`);
  }
  return directoryIdentity(stat);
}

async function assertExpectedPrivateDirectory(
  directory: string,
  expected: ArenaDirectoryIdentity,
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  await assertArenaPrivateDirectory(directory, boundary);
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory()
    || stat.isSymbolicLink()
    || !sameDirectoryIdentity(directoryIdentity(stat), expected)) {
    throw new Error(`Arena private directory changed identity: ${directory}`);
  }
}

function assertPrivatePublicationLink(stat: Stats, filePath: string): void {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 2) {
    throw new Error(
      `Arena private publication link is linked or invalid: ${filePath}`,
    );
  }
}

async function removeExpectedPrivateFile(
  filePath: string,
  expected: Stats,
  parentPath: string,
  parentIdentity: ArenaDirectoryIdentity,
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  await assertExpectedPrivateDirectory(
    parentPath,
    parentIdentity,
    boundary,
  );
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()
      || !stat.isFile()
      || !sameFileIdentity(stat, expected)) {
      throw new Error(
        `Arena private temporary file changed before cleanup: ${filePath}`,
      );
    }
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function syncPrivateDirectory(
  directory: string,
  expected: ArenaDirectoryIdentity,
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  await assertExpectedPrivateDirectory(directory, expected, boundary);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY);
  } catch (error) {
    // Windows does not expose a portable directory FlushFileBuffers handle
    // through Node. The file itself is fsynced before publication and the
    // no-replace hard-link commit remains atomic there. Some POSIX file
    // systems likewise report directory fsync as unsupported.
    if (isUnsupportedDirectorySyncError(error)) return;
    throw error;
  }
  try {
    const opened = await handle.stat();
    const entry = await fs.lstat(directory);
    if (!opened.isDirectory()
      || opened.isSymbolicLink()
      || !entry.isDirectory()
      || entry.isSymbolicLink()
      || !sameFileIdentity(opened, entry)
      || !sameDirectoryIdentity(directoryIdentity(opened), expected)) {
      throw new Error(
        `Arena private directory changed while syncing: ${directory}`,
      );
    }
    try {
      await handle.sync();
    } catch (error) {
      if (!isUnsupportedDirectorySyncError(error)) throw error;
    }
  } finally {
    await handle.close();
  }
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return process.platform === "win32"
    && (code === "EACCES"
      || code === "EBADF"
      || code === "EINVAL"
      || code === "EISDIR"
      || code === "ENOSYS"
      || code === "ENOTSUP"
      || code === "EPERM");
}

async function recoverInterruptedPrivatePublication(
  filePath: string,
  boundary: ArenaPrivateStorageBoundary,
): Promise<boolean> {
  const absoluteFilePath = path.resolve(filePath);
  await assertArenaPrivateParent(absoluteFilePath, boundary);
  let finalEntry: Stats;
  try {
    finalEntry = await fs.lstat(absoluteFilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!finalEntry.isSymbolicLink()
    && finalEntry.isFile()
    && finalEntry.nlink === 1) {
    return false;
  }
  if (finalEntry.isSymbolicLink()
    || !finalEntry.isFile()
    || finalEntry.nlink !== 2) {
    throw new Error(
      `Arena private file is linked or invalid: ${absoluteFilePath}`,
    );
  }

  const parentPath = path.dirname(absoluteFilePath);
  const parentIdentity = await capturePrivateDirectoryIdentity(
    parentPath,
    boundary,
  );
  const tempPattern = privateTemporaryNamePattern(
    path.basename(absoluteFilePath),
  );
  const matching: Array<{
    readonly path: string;
    readonly publisherPid: number;
    readonly stat: Stats;
  }> = [];
  const directory = await fs.opendir(parentPath);
  let seen = 0;
  try {
    for await (const entry of directory) {
      seen += 1;
      if (seen > MAX_PRIVATE_DIRECTORY_ENTRIES) {
        throw new Error(
          `Arena private directory exceeds its recovery scan limit: ${parentPath}`,
        );
      }
      const match = tempPattern.exec(entry.name);
      if (!match) continue;
      const publisherPid = Number(match[1]);
      if (!Number.isSafeInteger(publisherPid)
        || publisherPid <= 0
        || publisherPid > 0x7fff_ffff) {
        throw new Error(
          `Arena private temporary file has an invalid publisher: ${entry.name}`,
        );
      }
      const candidatePath = path.join(parentPath, entry.name);
      let candidate: Stats;
      try {
        candidate = await fs.lstat(candidatePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (candidate.isSymbolicLink() || !candidate.isFile()) {
        throw new Error(
          `Arena private temporary file is linked or invalid: ${candidatePath}`,
        );
      }
      if (sameFileIdentity(candidate, finalEntry)) {
        matching.push({
          path: candidatePath,
          publisherPid,
          stat: candidate,
        });
      }
    }
  } finally {
    await directory.close().catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") {
        throw error;
      }
    });
  }
  if (matching.length !== 1) {
    try {
      const currentFinal = await fs.lstat(absoluteFilePath);
      if (!currentFinal.isSymbolicLink()
        && currentFinal.isFile()
        && currentFinal.nlink === 1
        && sameFileIdentity(finalEntry, currentFinal)) {
        return false;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    throw new Error(
      `Arena private file is linked or invalid; interrupted publication is ambiguous: ${absoluteFilePath}`,
    );
  }
  const candidate = matching[0];
  if (!candidate || !isProcessDefinitelyGone(candidate.publisherPid)) {
    return false;
  }

  await assertExpectedPrivateDirectory(
    parentPath,
    parentIdentity,
    boundary,
  );
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0;
  const handle = await fs.open(
    absoluteFilePath,
    fsConstants.O_RDONLY | noFollow,
  );
  try {
    const [opened, currentFinal, currentTemporary] = await Promise.all([
      handle.stat(),
      fs.lstat(absoluteFilePath),
      fs.lstat(candidate.path),
    ]);
    assertPrivatePublicationLink(opened, absoluteFilePath);
    assertPrivatePublicationLink(currentFinal, absoluteFilePath);
    assertPrivatePublicationLink(currentTemporary, candidate.path);
    if (!sameFileIdentity(finalEntry, opened)
      || !sameFileIdentity(opened, currentFinal)
      || !sameFileIdentity(currentFinal, currentTemporary)
      || currentFinal.size !== currentTemporary.size) {
      throw new Error(
        `Arena private interrupted publication changed during recovery: ${absoluteFilePath}`,
      );
    }
    await removeExpectedPrivateFile(
      candidate.path,
      currentTemporary,
      parentPath,
      parentIdentity,
      boundary,
    );
    const [after, recovered] = await Promise.all([
      handle.stat(),
      fs.lstat(absoluteFilePath),
    ]);
    assertSafePrivateFile(after, absoluteFilePath);
    assertSafePrivateFile(recovered, absoluteFilePath);
    if (!sameFileIdentity(opened, after)
      || !sameFileIdentity(after, recovered)
      || after.size !== opened.size) {
      throw new Error(
        `Arena private file changed after recovery: ${absoluteFilePath}`,
      );
    }
    await syncPrivateDirectory(parentPath, parentIdentity, boundary);
    return true;
  } finally {
    await handle.close();
  }
}

function privateTemporaryNamePattern(fileName: string): RegExp {
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^\\.${escaped}\\.([1-9][0-9]*)-${PRIVATE_TEMP_UUID_PATTERN}\\.tmp$`,
    process.platform === "win32" ? "i" : "",
  );
}

function isProcessDefinitelyGone(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export async function appendArenaPrivateFile(
  filePath: string,
  content: Buffer | string,
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  await assertArenaPrivateParent(filePath, boundary);
  await recoverInterruptedPrivatePublication(filePath, boundary);
  const before = await fs.lstat(filePath);
  assertSafePrivateFile(before, filePath);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0;
  const handle = await fs.open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_APPEND | noFollow,
  );
  try {
    const opened = await handle.stat();
    assertSafePrivateFile(opened, filePath);
    if (!sameFileIdentity(before, opened)) {
      throw new Error(`Arena private file changed while opening: ${filePath}`);
    }
    await assertArenaPrivateParent(filePath, boundary);
    const entry = await fs.lstat(filePath);
    assertSafePrivateFile(entry, filePath);
    if (!sameFileIdentity(opened, entry)) {
      throw new Error(`Arena private file changed before append: ${filePath}`);
    }
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readArenaPrivateFile(
  filePath: string,
  maxBytes: number,
  boundary: ArenaPrivateStorageBoundary,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Arena private read limit must be a positive safe integer.");
  }
  await assertArenaPrivateParent(filePath, boundary);
  await recoverInterruptedPrivatePublication(filePath, boundary);
  const before = await fs.lstat(filePath);
  assertSafePrivateFile(before, filePath);
  if (before.size > maxBytes) {
    throw new Error(`Arena private file exceeds its read limit: ${filePath}`);
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    assertSafePrivateFile(opened, filePath);
    if (!sameFileIdentity(before, opened) || opened.size > maxBytes) {
      throw new Error(`Arena private file changed while opening: ${filePath}`);
    }
    await assertArenaPrivateParent(filePath, boundary);
    const entry = await fs.lstat(filePath);
    assertSafePrivateFile(entry, filePath);
    if (!sameFileIdentity(opened, entry)) {
      throw new Error(`Arena private file changed before read: ${filePath}`);
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) {
        throw new Error(`Arena private file was truncated during read: ${filePath}`);
      }
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (!sameFileIdentity(opened, after) || after.size !== opened.size) {
      throw new Error(`Arena private file changed during read: ${filePath}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function writeArenaPrivateFileAtomically(
  filePath: string,
  content: Buffer | string,
  boundary: ArenaPrivateStorageBoundary,
): Promise<void> {
  await assertArenaPrivateParent(filePath, boundary);
  await recoverInterruptedPrivatePublication(filePath, boundary);
  const tmpPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  let destinationExists = false;
  try {
    const destination = await fs.lstat(filePath);
    assertSafePrivateFile(destination, filePath);
    destinationExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const handle = await fs.open(tmpPath, "wx", 0o600);
  try {
    await assertArenaPrivateParent(tmpPath, boundary);
    const [opened, entry] = await Promise.all([
      handle.stat(),
      fs.lstat(tmpPath),
    ]);
    assertSafePrivateFile(opened, tmpPath);
    assertSafePrivateFile(entry, tmpPath);
    if (!sameFileIdentity(opened, entry)) {
      throw new Error(`Arena private temporary file changed while opening: ${tmpPath}`);
    }
    await handle.writeFile(content);
    await handle.sync();
    await handle.chmod(0o600).catch(() => undefined);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await removeRegularPrivateFile(tmpPath).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await assertArenaPrivateParent(filePath, boundary);
    if (destinationExists) {
      const destination = await fs.lstat(filePath);
      assertSafePrivateFile(destination, filePath);
    }
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await removeRegularPrivateFile(tmpPath).catch(() => undefined);
    throw error;
  }
}

export function isArenaPathWithin(root: string, candidate: string): boolean {
  return isPathWithin(path.resolve(root), path.resolve(candidate));
}

export function sameArenaPath(left: string, right: string): boolean {
  return samePath(path.resolve(left), path.resolve(right));
}

function assertPrivateSegment(segment: string): void {
  if (!segment
    || segment === "."
    || segment === ".."
    || path.isAbsolute(segment)
    || segment.includes("/")
    || segment.includes("\\")
    || segment.includes("\0")) {
    throw new Error(`Invalid Arena private directory segment: ${segment}`);
  }
}

function assertLexicalContainment(root: string, candidate: string): void {
  if (!isPathWithin(root, candidate)) {
    throw new Error(`Arena private path escapes storage root: ${candidate}`);
  }
}

function assertSafePrivateFile(stat: Stats, filePath: string): void {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(`Arena private file is linked or invalid: ${filePath}`);
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function removeRegularPrivateFile(filePath: string): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) {
      await fs.unlink(filePath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isPathWithin(root: string, candidate: string): boolean {
  const normalizedRoot = process.platform === "win32"
    ? root.toLowerCase()
    : root;
  const normalizedCandidate = process.platform === "win32"
    ? candidate.toLowerCase()
    : candidate;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === ""
    || (relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}
