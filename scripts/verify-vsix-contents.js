const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { isDeepStrictEqual, TextDecoder } = require("node:util");
const { createInflateRaw } = require("node:zlib");

// VSIX files produced by this project are roughly 2 MiB compressed and 5 MiB
// expanded. These deliberately generous ceilings leave room for growth while
// making the verifier a useful boundary against corrupt or adversarial ZIPs.
const MAX_VSIX_BYTES = 128 * 1024 * 1024;
const MAX_ENTRY_COUNT = 2_048;
const MAX_CENTRAL_DIRECTORY_BYTES = 2 * 1024 * 1024;
const MAX_ENTRY_COMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ENTRY_NAME_BYTES = 512;
const MAX_WINDOWS_RELATIVE_PATH_CHARS = 240;
const MAX_ZIP_COMMENT_BYTES = 0xffff;

const END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ALLOWED_ZIP_FLAGS = ZIP_UTF8_FLAG | ZIP_DATA_DESCRIPTOR_FLAG;
const ZIP_METHOD_STORED = 0;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_HOST_UNIX = 3;
const UNIX_FILE_TYPE_MASK = 0xf000;
const UNIX_REGULAR_FILE = 0x8000;
const UNIX_PRIVILEGED_MODE_BITS = 0x0e00;

const ROOT_ARCHIVE_FILES = new Set([
  "[Content_Types].xml",
  "extension.vsixmanifest",
]);

const SOURCE_BACKED_EXACT_FILES = new Map([
  ["extension/LICENSE.txt", "LICENSE"],
  ["extension/SUPPORT.md", "SUPPORT.md"],
  ["extension/media/webview.js", "media/webview.js"],
]);

const SOURCE_BACKED_MEDIA_DIRECTORIES = Object.freeze([
  Object.freeze({
    archivePrefix: "extension/media/hydra-heads",
    relativeDirectory: "media/hydra-heads",
  }),
  Object.freeze({
    archivePrefix: "extension/media/screenshots",
    relativeDirectory: "media/screenshots",
  }),
]);

const EXTENSION_EXACT_FILES = new Set([
  "extension/package.json",
  // VSCE normalizes Marketplace Markdown during packaging. Presence is
  // mandatory here; the independent whole-VSIX rebuild proves exact output.
  "extension/readme.md",
  "extension/changelog.md",
  ...SOURCE_BACKED_EXACT_FILES.keys(),
]);

const CRITICAL_ASSETS = [
  "extension/media/webview.js",
  "extension/dist/src/panel.js",
  "extension/dist/src/webview.html.js",
  "extension/media/hydra-heads/guard.png",
  "extension/media/hydra-heads/codex.png",
  "extension/media/hydra-heads/claude.png",
  "extension/media/hydra-heads/system.png",
  "extension/media/hydra-heads/user.png",
];

const COLLECTED_MANIFESTS = new Set([
  "[Content_Types].xml",
  "extension.vsixmanifest",
  "extension/package.json",
]);

const DENIED_ROOT_DIRECTORIES = new Set([
  ".agents",
  ".claude",
  ".codex",
  ".config",
  ".gemini",
  ".git",
  ".github",
  ".hydra",
  ".mcp",
  ".npm-cache",
  ".pnpm-store",
  ".sf",
  ".sfdx",
  ".superpowers",
  ".vscode",
  ".vscode-test",
  "config",
  "configs",
  "docs",
  "mcp",
  "node_modules",
  "scripts",
  "skills",
  "src",
  "tasks",
  "test",
]);

const DENIED_DIRECTORY_SEGMENTS = new Set([
  ".agents",
  ".claude",
  ".codex",
  ".config",
  ".direnv",
  ".gemini",
  ".git",
  ".hydra",
  ".mcp",
  ".npm-cache",
  ".pnpm-store",
  ".sf",
  ".sfdx",
  ".superpowers",
  ".vscode-test",
  "config",
  "configs",
  "mcp",
  "node_modules",
]);

const DENIED_EXACT_FILES = new Set([
  ".envrc",
  ".mcp.json",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".yarnrc",
  "claude_desktop_config.json",
  "config.json",
  "credentials",
  "credentials.json",
  "debug.log",
  "id_dsa",
  "id_ed25519",
  "id_ecdsa",
  "id_rsa",
  "mcp-config.json",
  "mcp.json",
  "mcp_servers.json",
  "mcp-servers.json",
  "npm-debug.log",
  "secrets.json",
  "service-account.json",
  "settings.json",
  "settings.local.json",
  "yarn-error.log",
]);

const DENIED_FILE_EXTENSIONS = new Set([
  ".jks",
  ".key",
  ".kdbx",
  ".keystore",
  ".log",
  ".p12",
  ".pem",
  ".pfx",
  ".vsix",
]);

const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const WINDOWS_UNSAFE_CHARACTERS = /[<>:"\\|?*\u0000-\u001f]/;
const SAFE_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  CRC32_TABLE[index] = value >>> 0;
}

function findDeniedVsixEntries(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError("VSIX entries must be an array.");
  }

  return entries.filter((entry) => {
    const normalized = normalizeEntryName(entry);
    const relative = normalized.toLowerCase().startsWith("extension/")
      ? normalized.slice("extension/".length)
      : normalized;
    const segments = relative.toLowerCase().split("/").filter(Boolean);
    if (segments.length === 0) return false;

    const root = segments[0];
    if (DENIED_ROOT_DIRECTORIES.has(root)) return true;
    if (segments.slice(0, -1).some((segment) => DENIED_DIRECTORY_SEGMENTS.has(segment))) return true;

    const fileName = segments[segments.length - 1];
    if (fileName === ".env" || fileName.startsWith(".env.") || fileName.endsWith(".env")) return true;
    if (DENIED_EXACT_FILES.has(fileName)) return true;
    if (/^(?:mcp|mcp[-_.].*)\.(?:json|ya?ml|toml)$/i.test(fileName)) return true;
    if (/^(?:config|settings|secrets?)(?:\.[^.]+)*\.(?:json|ya?ml|toml)$/i.test(fileName)) return true;
    return DENIED_FILE_EXTENSIONS.has(path.posix.extname(fileName));
  });
}

async function readVsixEntryNames(vsixPath) {
  const archive = await inspectVsix(vsixPath, new Set());
  return archive.entries.map((entry) => entry.name);
}

async function verifyVsixContents(vsixPath, projectRoot = process.cwd()) {
  const localRuntimePayloads = await readLocalRuntimePayloads(projectRoot);
  const localStaticPayloads = await readLocalStaticPayloads(projectRoot);
  const collectedPayloads = new Set([
    ...COLLECTED_MANIFESTS,
    ...localRuntimePayloads.keys(),
    ...localStaticPayloads.keys(),
  ]);
  const archive = await inspectVsix(vsixPath, collectedPayloads);
  const entries = archive.entries.map((entry) => entry.name);
  const entryNames = new Set(entries);

  for (const required of COLLECTED_MANIFESTS) {
    if (!entryNames.has(required)) {
      throw new Error(`Invalid VSIX: required manifest entry ${required} is missing.`);
    }
  }
  for (const required of EXTENSION_EXACT_FILES) {
    if (!entryNames.has(required)) {
      throw new Error(`Invalid VSIX: required release entry ${required} is missing.`);
    }
  }

  const denied = findDeniedVsixEntries(entries);
  if (denied.length > 0) {
    throw new Error(`VSIX contains denied local/private content:\n${denied.map((entry) => `- ${entry}`).join("\n")}`);
  }

  const unexpected = entries.filter((entry) => !isAllowlistedEntry(entry));
  if (unexpected.length > 0) {
    throw new Error(`VSIX contains entries outside the release allowlist:\n${unexpected.map((entry) => `- ${entry}`).join("\n")}`);
  }

  const rootManifest = await readRootManifest(projectRoot);
  const embeddedManifest = parseJsonManifest(requiredPayload(archive.payloads, "extension/package.json"));
  const rootIdentity = validatePackageIdentity(rootManifest, "root package.json");
  const embeddedIdentity = validatePackageIdentity(embeddedManifest, "embedded extension/package.json");

  for (const field of ["name", "publisher", "version", "main", "icon"]) {
    if (embeddedIdentity[field] !== rootIdentity[field]) {
      throw new Error(`Invalid VSIX: embedded package.json ${field} does not match the root manifest (stale package).`);
    }
  }
  if (!isDeepStrictEqual(embeddedManifest, rootManifest)) {
    throw new Error("Invalid VSIX: embedded package.json does not match the complete root release manifest (stale package).");
  }

  validateContentTypes(requiredPayload(archive.payloads, "[Content_Types].xml"));
  validateVsixManifest(requiredPayload(archive.payloads, "extension.vsixmanifest"), rootIdentity);

  const declaredMain = manifestAssetEntry(rootIdentity.main, "main", ".js");
  const declaredIcon = manifestAssetEntry(rootIdentity.icon, "icon", ".png");
  for (const required of [declaredMain, declaredIcon, ...CRITICAL_ASSETS]) {
    if (!entryNames.has(required)) {
      const kind = required === declaredMain ? "declared main" : required === declaredIcon ? "declared icon" : "critical runtime asset";
      throw new Error(`Invalid VSIX: ${kind} ${required} is missing.`);
    }
  }

  validateRuntimePayloads(entries, archive.payloads, localRuntimePayloads);
  validateStaticPayloads(entries, archive.payloads, localStaticPayloads);

  return entries;
}

function defaultVsixPath(cwd = process.cwd()) {
  const manifest = readJsonFileSync(path.join(cwd, "package.json"), "package.json");
  const identity = validatePackageIdentity(manifest, "root package.json");
  return path.join(cwd, `${identity.name}-${identity.version}.vsix`);
}

async function inspectVsix(vsixPath, collectEntries) {
  if (typeof vsixPath !== "string" || vsixPath.trim() === "") {
    throw new TypeError("A VSIX path is required.");
  }
  if (!(collectEntries instanceof Set)) {
    throw new TypeError("Collected VSIX entries must be a Set.");
  }

  const before = await fsp.lstat(vsixPath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`VSIX path is not a regular file: ${vsixPath}`);
  }
  assertArchiveSize(before.size);

  const handle = await fsp.open(vsixPath, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileSnapshot(before, opened)) {
      throw new Error("Invalid VSIX: archive identity changed while it was opened.");
    }

    const entries = await readCentralDirectory(handle, opened.size);
    const payloads = new Map();
    for (const entry of entries) {
      const collect = collectEntries.has(entry.name);
      if (COLLECTED_MANIFESTS.has(entry.name) && entry.uncompressedSize > MAX_MANIFEST_BYTES) {
        throw new Error(`Invalid VSIX: manifest entry ${entry.name} exceeds the manifest size limit.`);
      }
      const payload = await validateEntryPayload(handle, vsixPath, entry, collect);
      if (collect) payloads.set(entry.name, payload);
    }

    const after = await handle.stat();
    if (!sameFileSnapshot(opened, after)) {
      throw new Error("Invalid VSIX: archive changed during verification.");
    }
    return { entries, payloads };
  } finally {
    await handle.close();
  }
}

async function readCentralDirectory(handle, archiveSize) {
  const tailSize = Math.min(archiveSize, END_OF_CENTRAL_DIRECTORY_BYTES + MAX_ZIP_COMMENT_BYTES);
  const tailOffset = archiveSize - tailSize;
  const tail = await readExact(handle, tailOffset, tailSize, "ZIP end-of-central-directory search");
  const relativeEndOffset = findEndOfCentralDirectory(tail, archiveSize, tailOffset);
  const endOffset = tailOffset + relativeEndOffset;
  const diskNumber = tail.readUInt16LE(relativeEndOffset + 4);
  const centralDirectoryDisk = tail.readUInt16LE(relativeEndOffset + 6);
  const entriesOnDisk = tail.readUInt16LE(relativeEndOffset + 8);
  const totalEntries = tail.readUInt16LE(relativeEndOffset + 10);
  const centralDirectorySize = tail.readUInt32LE(relativeEndOffset + 12);
  const centralDirectoryOffset = tail.readUInt32LE(relativeEndOffset + 16);
  const commentLength = tail.readUInt16LE(relativeEndOffset + 20);

  if (commentLength !== 0) {
    throw new Error("Invalid VSIX: archive comments are not allowed.");
  }
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new Error("Invalid VSIX: multi-disk ZIP archives are not supported.");
  }
  if (totalEntries === 0 || totalEntries === 0xffff) {
    throw new Error("Invalid VSIX: empty and ZIP64 archives are not supported.");
  }
  if (totalEntries > MAX_ENTRY_COUNT) {
    throw new Error(`Invalid VSIX: entry count ${totalEntries} exceeds the ${MAX_ENTRY_COUNT} entry limit.`);
  }
  if (centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error("Invalid VSIX: ZIP64 archives are not supported.");
  }
  if (centralDirectorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
    throw new Error("Invalid VSIX: central directory exceeds the size limit.");
  }
  if (centralDirectoryOffset + centralDirectorySize !== endOffset) {
    throw new Error("Invalid VSIX central directory bounds.");
  }

  const central = await readExact(
    handle,
    centralDirectoryOffset,
    centralDirectorySize,
    "ZIP central directory",
  );
  const entries = [];
  const seen = new Map();
  let totalUncompressedBytes = 0;
  let cursor = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`Invalid VSIX central directory entry ${index + 1}.`);
    }

    const versionMadeBy = central.readUInt16LE(cursor + 4);
    const versionNeeded = central.readUInt16LE(cursor + 6);
    const flags = central.readUInt16LE(cursor + 8);
    const method = central.readUInt16LE(cursor + 10);
    const crc32 = central.readUInt32LE(cursor + 16);
    const compressedSize = central.readUInt32LE(cursor + 20);
    const uncompressedSize = central.readUInt32LE(cursor + 24);
    const nameLength = central.readUInt16LE(cursor + 28);
    const extraLength = central.readUInt16LE(cursor + 30);
    const commentEntryLength = central.readUInt16LE(cursor + 32);
    const startingDisk = central.readUInt16LE(cursor + 34);
    const externalAttributes = central.readUInt32LE(cursor + 38);
    const localHeaderOffset = central.readUInt32LE(cursor + 42);
    const entryEnd = cursor + 46 + nameLength + extraLength + commentEntryLength;

    if (nameLength === 0 || nameLength > MAX_ENTRY_NAME_BYTES || entryEnd > central.length) {
      throw new Error(`Invalid VSIX central directory entry ${index + 1} bounds.`);
    }
    if (extraLength !== 0 || commentEntryLength !== 0) {
      throw new Error(`Invalid VSIX: entry ${index + 1} has unsupported ZIP metadata.`);
    }
    if (startingDisk !== 0 || versionNeeded > 20) {
      throw new Error(`Invalid VSIX: entry ${index + 1} requires an unsupported ZIP feature.`);
    }
    assertAllowedZipFlags(flags, index);
    assertSupportedCompression(method, index);
    assertRegularFileAttributes(versionMadeBy, externalAttributes, index);
    assertEntrySizes(method, compressedSize, uncompressedSize, index);

    totalUncompressedBytes += uncompressedSize;
    if (!Number.isSafeInteger(totalUncompressedBytes) || totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error(`Invalid VSIX: total uncompressed bytes exceed the ${MAX_TOTAL_UNCOMPRESSED_BYTES} byte limit.`);
    }

    const rawName = central.subarray(cursor + 46, cursor + 46 + nameLength);
    const entryName = decodeEntryName(rawName, flags);
    assertSafeEntryName(entryName);
    const collisionKey = windowsCollisionKey(entryName);
    const previous = seen.get(collisionKey);
    if (previous !== undefined) {
      throw new Error(`Invalid VSIX: duplicate or case-colliding entries ${previous} and ${entryName}.`);
    }
    seen.set(collisionKey, entryName);

    entries.push({
      name: entryName,
      rawName: Buffer.from(rawName),
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      dataOffset: 0,
      recordEnd: 0,
    });
    cursor = entryEnd;
  }

  if (cursor !== central.length) {
    throw new Error("Invalid VSIX: central directory entry count does not match its size.");
  }

  await validateLocalRecords(handle, entries, centralDirectoryOffset);
  return entries;
}

async function validateLocalRecords(handle, entries, centralDirectoryOffset) {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.localHeaderOffset + 30 > centralDirectoryOffset) {
      throw new Error(`Invalid VSIX local file header for entry ${index + 1}.`);
    }
    const local = await readExact(handle, entry.localHeaderOffset, 30, `local header for ${entry.name}`);
    if (local.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw new Error(`Invalid VSIX local file header for entry ${index + 1}.`);
    }

    const localVersionNeeded = local.readUInt16LE(4);
    const localFlags = local.readUInt16LE(6);
    const localMethod = local.readUInt16LE(8);
    const localCrc32 = local.readUInt32LE(14);
    const localCompressedSize = local.readUInt32LE(18);
    const localUncompressedSize = local.readUInt32LE(22);
    const localNameLength = local.readUInt16LE(26);
    const localExtraLength = local.readUInt16LE(28);
    if (
      localVersionNeeded > 20
      || localFlags !== entry.flags
      || localMethod !== entry.method
      || localNameLength !== entry.rawName.length
      || localExtraLength !== 0
    ) {
      throw new Error(`Invalid VSIX: local metadata differs for entry ${entry.name}.`);
    }

    const localName = await readExact(
      handle,
      entry.localHeaderOffset + 30,
      localNameLength,
      `local name for ${entry.name}`,
    );
    if (!localName.equals(entry.rawName)) {
      throw new Error(`Invalid VSIX: local and central entry names differ for ${entry.name}.`);
    }

    const usesDescriptor = (entry.flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0;
    if (usesDescriptor) {
      if (
        !zeroOrEqual(localCrc32, entry.crc32)
        || !zeroOrEqual(localCompressedSize, entry.compressedSize)
        || !zeroOrEqual(localUncompressedSize, entry.uncompressedSize)
      ) {
        throw new Error(`Invalid VSIX: local sizes differ for entry ${entry.name}.`);
      }
    } else if (
      localCrc32 !== entry.crc32
      || localCompressedSize !== entry.compressedSize
      || localUncompressedSize !== entry.uncompressedSize
    ) {
      throw new Error(`Invalid VSIX: local sizes differ for entry ${entry.name}.`);
    }

    entry.dataOffset = entry.localHeaderOffset + 30 + localNameLength;
    const dataEnd = entry.dataOffset + entry.compressedSize;
    if (dataEnd > centralDirectoryOffset) {
      throw new Error(`Invalid VSIX compressed data bounds for entry ${entry.name}.`);
    }

    if (usesDescriptor) {
      const descriptor = await readExact(handle, dataEnd, 16, `data descriptor for ${entry.name}`);
      if (
        descriptor.readUInt32LE(0) !== DATA_DESCRIPTOR_SIGNATURE
        || descriptor.readUInt32LE(4) !== entry.crc32
        || descriptor.readUInt32LE(8) !== entry.compressedSize
        || descriptor.readUInt32LE(12) !== entry.uncompressedSize
      ) {
        throw new Error(`Invalid VSIX data descriptor for entry ${entry.name}.`);
      }
      entry.recordEnd = dataEnd + 16;
    } else {
      entry.recordEnd = dataEnd;
    }
  }

  const localOrder = [...entries].sort((left, right) => left.localHeaderOffset - right.localHeaderOffset);
  let expectedOffset = 0;
  for (const entry of localOrder) {
    if (entry.localHeaderOffset !== expectedOffset) {
      throw new Error(`Invalid VSIX: local records overlap or contain unreferenced data before ${entry.name}.`);
    }
    expectedOffset = entry.recordEnd;
  }
  if (expectedOffset !== centralDirectoryOffset) {
    throw new Error("Invalid VSIX: unreferenced data exists before the central directory.");
  }
}

async function validateEntryPayload(handle, vsixPath, entry, collect) {
  let actualBytes = 0;
  let crc = 0xffffffff;
  const chunks = collect ? [] : undefined;

  const sink = new Writable({
    write(chunk, _encoding, callback) {
      try {
        actualBytes += chunk.length;
        if (actualBytes > entry.uncompressedSize || actualBytes > MAX_ENTRY_UNCOMPRESSED_BYTES) {
          throw new Error(`Invalid VSIX: expanded data exceeds the declared size for ${entry.name}.`);
        }
        crc = updateCrc32(crc, chunk);
        if (chunks !== undefined) chunks.push(Buffer.from(chunk));
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });

  if (entry.compressedSize > 0) {
    const source = fs.createReadStream(vsixPath, {
      fd: handle.fd,
      autoClose: false,
      start: entry.dataOffset,
      end: entry.dataOffset + entry.compressedSize - 1,
      highWaterMark: 64 * 1024,
    });
    if (entry.method === ZIP_METHOD_DEFLATE) {
      const inflater = createInflateRaw();
      await pipeline(source, inflater, sink);
      if (inflater.bytesWritten !== entry.compressedSize) {
        throw new Error(`Invalid VSIX: compressed stream has trailing data for ${entry.name}.`);
      }
    } else {
      await pipeline(source, sink);
    }
  } else {
    await new Promise((resolve, reject) => {
      sink.once("finish", resolve);
      sink.once("error", reject);
      sink.end();
    });
  }

  const calculatedCrc32 = (crc ^ 0xffffffff) >>> 0;
  if (actualBytes !== entry.uncompressedSize) {
    throw new Error(`Invalid VSIX: uncompressed size mismatch for ${entry.name}.`);
  }
  if (calculatedCrc32 !== entry.crc32) {
    throw new Error(`Invalid VSIX: CRC integrity check failed for ${entry.name}.`);
  }
  return chunks === undefined ? undefined : Buffer.concat(chunks, actualBytes);
}

function assertArchiveSize(size) {
  if (!Number.isSafeInteger(size) || size < END_OF_CENTRAL_DIRECTORY_BYTES || size > MAX_VSIX_BYTES) {
    throw new Error(`Invalid VSIX size: ${size} bytes.`);
  }
}

function assertAllowedZipFlags(flags, index) {
  if ((flags & ~ALLOWED_ZIP_FLAGS) !== 0) {
    throw new Error(`Invalid VSIX: entry ${index + 1} uses unsupported or encrypted ZIP flags.`);
  }
}

function assertSupportedCompression(method, index) {
  if (method !== ZIP_METHOD_STORED && method !== ZIP_METHOD_DEFLATE) {
    throw new Error(`Invalid VSIX: entry ${index + 1} uses unsupported compression method ${method}.`);
  }
}

function assertRegularFileAttributes(versionMadeBy, externalAttributes, index) {
  const host = versionMadeBy >>> 8;
  if (host !== ZIP_HOST_UNIX) {
    throw new Error(`Invalid VSIX: entry ${index + 1} has unsupported external attributes.`);
  }
  const unixMode = externalAttributes >>> 16;
  if ((unixMode & UNIX_FILE_TYPE_MASK) !== UNIX_REGULAR_FILE) {
    throw new Error(`Invalid VSIX: entry ${index + 1} is a link or non-regular file.`);
  }
  if ((unixMode & UNIX_PRIVILEGED_MODE_BITS) !== 0) {
    throw new Error(`Invalid VSIX: entry ${index + 1} has privileged external attributes.`);
  }
}

function assertEntrySizes(method, compressedSize, uncompressedSize, index) {
  if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
    throw new Error("Invalid VSIX: ZIP64 entries are not supported.");
  }
  if (compressedSize > MAX_ENTRY_COMPRESSED_BYTES) {
    throw new Error(`Invalid VSIX: compressed entry size exceeds the limit for entry ${index + 1}.`);
  }
  if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
    throw new Error(`Invalid VSIX: uncompressed entry size exceeds the limit for entry ${index + 1}.`);
  }
  if (uncompressedSize > 0 && compressedSize === 0) {
    throw new Error(`Invalid VSIX: entry ${index + 1} has impossible compressed size metadata.`);
  }
  if (method === ZIP_METHOD_STORED && compressedSize !== uncompressedSize) {
    throw new Error(`Invalid VSIX: stored entry ${index + 1} has inconsistent sizes.`);
  }
  if (method === ZIP_METHOD_DEFLATE && compressedSize === 0) {
    throw new Error(`Invalid VSIX: deflated entry ${index + 1} has no compressed stream.`);
  }
  if (uncompressedSize > compressedSize * MAX_COMPRESSION_RATIO) {
    throw new Error(`Invalid VSIX: compression ratio exceeds the ${MAX_COMPRESSION_RATIO}:1 limit for entry ${index + 1}.`);
  }
}

function findEndOfCentralDirectory(tail, archiveSize, tailOffset) {
  for (let offset = tail.length - END_OF_CENTRAL_DIRECTORY_BYTES; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (tailOffset + offset + END_OF_CENTRAL_DIRECTORY_BYTES + commentLength === archiveSize) return offset;
  }
  throw new Error("Invalid VSIX: ZIP end-of-central-directory record was not found.");
}

function decodeEntryName(rawName, flags) {
  if ((flags & ZIP_UTF8_FLAG) !== 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(rawName);
    } catch {
      throw new Error("Invalid VSIX: an entry name is not valid UTF-8.");
    }
  }
  if (rawName.some((byte) => byte > 0x7f)) {
    throw new Error("Invalid VSIX: non-ASCII entry names must declare UTF-8 encoding.");
  }
  return rawName.toString("ascii");
}

function normalizeEntryName(entryName) {
  if (typeof entryName !== "string") {
    throw new TypeError("Every VSIX entry name must be a string.");
  }
  return entryName.replace(/\\/g, "/").replace(/^\.\//, "");
}

function assertSafeEntryName(entryName) {
  const normalized = normalizeEntryName(entryName);
  const segments = entryName.split("/");
  if (
    normalized !== entryName
    || entryName.length > MAX_WINDOWS_RELATIVE_PATH_CHARS
    || entryName.startsWith("/")
    || /^[A-Za-z]:\//.test(entryName)
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
    || segments.some((segment) => segment.endsWith(".") || segment.endsWith(" "))
    || segments.some((segment) => WINDOWS_RESERVED_BASENAME.test(segment))
    || segments.some((segment) => WINDOWS_UNSAFE_CHARACTERS.test(segment))
  ) {
    throw new Error(`Invalid or Windows-unsafe VSIX entry path: ${JSON.stringify(entryName)}.`);
  }
}

function windowsCollisionKey(entryName) {
  return entryName.normalize("NFC").toLowerCase();
}

function isPackagedRuntimeEntry(entryName) {
  return /^extension\/dist\/src\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(entryName);
}

function isPackagedStaticEntry(entryName) {
  if (SOURCE_BACKED_EXACT_FILES.has(entryName)) return true;
  return /^extension\/media\/(?:hydra-heads|screenshots)\/[A-Za-z0-9][A-Za-z0-9._-]*\.png$/.test(entryName);
}

function isAllowlistedEntry(entryName) {
  if (ROOT_ARCHIVE_FILES.has(entryName) || EXTENSION_EXACT_FILES.has(entryName)) return true;
  if (isPackagedRuntimeEntry(entryName)) return true;
  if (isPackagedStaticEntry(entryName)) return true;
  return false;
}

async function readLocalStaticPayloads(projectRoot) {
  const payloads = new Map();
  const collisionNames = new Map();

  for (const [archiveName, relativePath] of SOURCE_BACKED_EXACT_FILES) {
    const collisionKey = windowsCollisionKey(archiveName);
    collisionNames.set(collisionKey, archiveName);
    payloads.set(
      archiveName,
      await readStableLocalSourceFile(
        path.join(projectRoot, relativePath),
        `Local release asset ${relativePath}`,
      ),
    );
  }

  for (const { archivePrefix, relativeDirectory } of SOURCE_BACKED_MEDIA_DIRECTORIES) {
    const directoryPath = path.join(projectRoot, relativeDirectory);
    const directoryBefore = await fsp.lstat(directoryPath);
    assertLocalRuntimeDirectory(directoryBefore, relativeDirectory);
    const children = await fsp.readdir(directoryPath, { withFileTypes: true });
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      const relativePath = `${relativeDirectory}/${child.name}`;
      const localPath = path.join(directoryPath, child.name);
      if (child.isSymbolicLink()
        || !child.isFile()
        || path.posix.extname(child.name).toLowerCase() !== ".png") {
        throw new Error(`Local release asset ${relativePath} is linked or unsupported.`);
      }
      const archiveName = `${archivePrefix}/${child.name}`;
      assertSafeEntryName(archiveName);
      if (!isPackagedStaticEntry(archiveName)) {
        throw new Error(`Local release asset is outside the release allowlist: ${relativePath}.`);
      }
      const collisionKey = windowsCollisionKey(archiveName);
      const previous = collisionNames.get(collisionKey);
      if (previous !== undefined) {
        throw new Error(`Local release assets collide on Windows: ${previous} and ${archiveName}.`);
      }
      collisionNames.set(collisionKey, archiveName);
      payloads.set(
        archiveName,
        await readStableLocalSourceFile(localPath, `Local release asset ${relativePath}`),
      );
    }
    const directoryAfter = await fsp.lstat(directoryPath);
    if (!sameFileSnapshot(directoryBefore, directoryAfter)) {
      throw new Error(`Local release asset directory ${relativeDirectory} changed while it was read.`);
    }
  }

  return payloads;
}

async function readLocalRuntimePayloads(projectRoot) {
  const runtimeRoot = path.join(projectRoot, "dist", "src");
  const rootBefore = await fsp.lstat(runtimeRoot);
  assertLocalRuntimeDirectory(rootBefore, "dist/src");
  const payloads = new Map();
  const collisionNames = new Map();

  async function visit(directoryPath, relativeDirectory) {
    const children = await fsp.readdir(directoryPath, { withFileTypes: true });
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      const relativePath = relativeDirectory === ""
        ? child.name
        : `${relativeDirectory}/${child.name}`;
      const localPath = path.join(directoryPath, child.name);
      if (child.isSymbolicLink()) {
        throw new Error(`Local runtime artifact dist/src/${relativePath} must not be a symbolic link.`);
      }
      if (child.isDirectory()) {
        const stats = await fsp.lstat(localPath);
        assertLocalRuntimeDirectory(stats, `dist/src/${relativePath}`);
        await visit(localPath, relativePath);
        continue;
      }
      if (!child.isFile()) {
        throw new Error(`Local runtime artifact dist/src/${relativePath} is not a regular file.`);
      }
      if (relativePath.endsWith(".js.map")) continue;
      if (!relativePath.endsWith(".js")) {
        throw new Error(`Local dist/src contains an unsupported runtime artifact: ${relativePath}.`);
      }

      const archiveName = `extension/dist/src/${relativePath}`;
      assertSafeEntryName(archiveName);
      if (!isPackagedRuntimeEntry(archiveName)) {
        throw new Error(`Local runtime artifact is outside the release allowlist: ${relativePath}.`);
      }
      const collisionKey = windowsCollisionKey(archiveName);
      const previous = collisionNames.get(collisionKey);
      if (previous !== undefined) {
        throw new Error(`Local runtime artifacts collide on Windows: ${previous} and ${archiveName}.`);
      }
      collisionNames.set(collisionKey, archiveName);
      payloads.set(
        archiveName,
        await readStableLocalSourceFile(
          localPath,
          `Local runtime artifact dist/src/${relativePath}`,
        ),
      );
    }
  }

  await visit(runtimeRoot, "");
  if (payloads.size === 0) {
    throw new Error("Local dist/src contains no JavaScript runtime artifacts to package.");
  }
  const rootAfter = await fsp.lstat(runtimeRoot);
  if (!sameFileSnapshot(rootBefore, rootAfter)) {
    throw new Error("Local dist/src changed while its runtime inventory was read.");
  }
  return payloads;
}

function assertLocalRuntimeDirectory(stats, label) {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Local runtime directory ${label} is missing or linked.`);
  }
}

async function readStableLocalSourceFile(filePath, label) {
  const before = await fsp.lstat(filePath);
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.size < 1
    || before.size > MAX_ENTRY_UNCOMPRESSED_BYTES
  ) {
    throw new Error(`${label} is linked, empty, invalid, or too large.`);
  }
  const handle = await fsp.open(filePath, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileSnapshot(before, opened)) {
      throw new Error(`${label} changed while it was opened.`);
    }
    const contents = await readExact(handle, 0, opened.size, label);
    if (!sameFileSnapshot(opened, await handle.stat())) {
      throw new Error(`${label} changed while it was read.`);
    }
    return contents;
  } finally {
    await handle.close();
  }
}

function validateRuntimePayloads(entries, archivePayloads, localRuntimePayloads) {
  const packagedRuntimeNames = entries
    .filter((entry) => isPackagedRuntimeEntry(entry))
    .sort();
  const localRuntimeNames = [...localRuntimePayloads.keys()].sort();
  const packagedSet = new Set(packagedRuntimeNames);
  const localSet = new Set(localRuntimeNames);
  const missing = localRuntimeNames.filter((entry) => !packagedSet.has(entry));
  const extra = packagedRuntimeNames.filter((entry) => !localSet.has(entry));
  if (missing.length > 0 || extra.length > 0) {
    const details = [
      ...missing.map((entry) => `- missing ${entry}`),
      ...extra.map((entry) => `- extra ${entry}`),
    ];
    throw new Error(`Invalid VSIX: packaged runtime inventory does not match local dist/src:\n${details.join("\n")}`);
  }

  for (const entryName of localRuntimeNames) {
    const packaged = archivePayloads.get(entryName);
    const local = localRuntimePayloads.get(entryName);
    if (!Buffer.isBuffer(packaged) || !packaged.equals(local)) {
      throw new Error(`Invalid VSIX: packaged runtime bytes are stale for ${entryName}.`);
    }
  }
}

function validateStaticPayloads(entries, archivePayloads, localStaticPayloads) {
  const packagedStaticNames = entries
    .filter((entry) => isPackagedStaticEntry(entry))
    .sort();
  const localStaticNames = [...localStaticPayloads.keys()].sort();
  const packagedSet = new Set(packagedStaticNames);
  const localSet = new Set(localStaticNames);
  const missing = localStaticNames.filter((entry) => !packagedSet.has(entry));
  const extra = packagedStaticNames.filter((entry) => !localSet.has(entry));
  if (missing.length > 0 || extra.length > 0) {
    const details = [
      ...missing.map((entry) => `- missing ${entry}`),
      ...extra.map((entry) => `- extra ${entry}`),
    ];
    throw new Error(
      `Invalid VSIX: packaged static asset inventory does not match checked-out source:\n${details.join("\n")}`,
    );
  }

  for (const entryName of localStaticNames) {
    const packaged = archivePayloads.get(entryName);
    const local = localStaticPayloads.get(entryName);
    if (!Buffer.isBuffer(packaged) || !packaged.equals(local)) {
      throw new Error(`Invalid VSIX: packaged static asset bytes are stale for ${entryName}.`);
    }
  }
}

async function readRootManifest(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.trim() === "") {
    throw new TypeError("A project root is required for VSIX manifest verification.");
  }
  const manifestPath = path.join(projectRoot, "package.json");
  const before = await fsp.lstat(manifestPath);
  assertManifestFileStats(before, "Root package.json");
  const handle = await fsp.open(manifestPath, "r");
  try {
    const opened = await handle.stat();
    assertManifestFileStats(opened, "Root package.json");
    if (!sameFileSnapshot(before, opened)) {
      throw new Error("Root package.json changed while it was opened.");
    }
    const contents = await readExact(handle, 0, opened.size, "root package.json");
    if (!sameFileSnapshot(opened, await handle.stat())) {
      throw new Error("Root package.json changed during verification.");
    }
    return parseJsonManifest(contents, "root package.json");
  } finally {
    await handle.close();
  }
}

function readJsonFileSync(filePath, label) {
  const before = fs.lstatSync(filePath);
  assertManifestFileStats(before, label);
  const descriptor = fs.openSync(filePath, "r");
  try {
    const opened = fs.fstatSync(descriptor);
    assertManifestFileStats(opened, label);
    if (!sameFileSnapshot(before, opened)) throw new Error(`${label} changed while it was opened.`);
    const contents = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < contents.length) {
      const bytesRead = fs.readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (bytesRead === 0) throw new Error(`${label} was truncated while it was read.`);
      offset += bytesRead;
    }
    if (!sameFileSnapshot(opened, fs.fstatSync(descriptor))) {
      throw new Error(`${label} changed while it was read.`);
    }
    return parseJsonManifest(contents, label);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertManifestFileStats(stats, label) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0 || stats.size > MAX_MANIFEST_BYTES) {
    throw new Error(`${label} is missing, empty, linked, or too large.`);
  }
}

function parseJsonManifest(buffer, label = "embedded extension/package.json") {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_MANIFEST_BYTES) {
    throw new Error(`Invalid VSIX: ${label} is empty or exceeds the manifest size limit.`);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`Invalid VSIX: ${label} is not valid UTF-8.`);
  }
  if (text.trim() === "") {
    throw new Error(`Invalid VSIX: ${label} is empty.`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Invalid VSIX: ${label} is not valid JSON.`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid VSIX: ${label} must contain a JSON object.`);
  }
  return value;
}

function validatePackageIdentity(manifest, label) {
  const identity = {};
  for (const field of ["name", "publisher", "version", "main", "icon"]) {
    const value = manifest[field];
    if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
      throw new Error(`${label} has an empty or invalid ${field}.`);
    }
    identity[field] = value;
  }
  if (!SAFE_BASENAME.test(identity.name) || !SAFE_BASENAME.test(identity.publisher)) {
    throw new Error(`${label} has an invalid name or publisher.`);
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(identity.version)) {
    throw new Error(`${label} has an invalid version.`);
  }
  manifestAssetEntry(identity.main, `${label} main`, ".js");
  manifestAssetEntry(identity.icon, `${label} icon`, ".png");
  return identity;
}

function manifestAssetEntry(value, label, requiredExtension) {
  if (typeof value !== "string" || value === "" || value !== value.trim() || value.includes("\\")) {
    throw new Error(`Invalid VSIX: ${label} path is empty or unsafe.`);
  }
  const relative = value.startsWith("./") ? value.slice(2) : value;
  if (relative === "" || path.posix.extname(relative).toLowerCase() !== requiredExtension) {
    throw new Error(`Invalid VSIX: ${label} must declare a ${requiredExtension} file.`);
  }
  const entryName = `extension/${relative}`;
  assertSafeEntryName(entryName);
  if (!isAllowlistedEntry(entryName)) {
    throw new Error(`Invalid VSIX: ${label} path is outside the release allowlist.`);
  }
  return entryName;
}

function validateContentTypes(buffer) {
  const text = decodeNonEmptyManifest(buffer, "[Content_Types].xml");
  if (!/<Types(?:\s|\/?>)/i.test(text)) {
    throw new Error("Invalid VSIX: [Content_Types].xml is empty or malformed.");
  }
}

function validateVsixManifest(buffer, expected) {
  const text = decodeNonEmptyManifest(buffer, "extension.vsixmanifest");
  const matches = [...text.matchAll(/<Identity\b([^>]*)\/?\s*>/gi)];
  if (matches.length !== 1) {
    throw new Error("Invalid VSIX: extension.vsixmanifest must contain exactly one Identity element.");
  }
  const attributesText = matches[0][1];
  const attributes = new Map();
  for (const match of attributesText.matchAll(/\b(Id|Version|Publisher)\s*=\s*(["'])(.*?)\2/gi)) {
    const key = match[1].toLowerCase();
    if (attributes.has(key)) {
      throw new Error(`Invalid VSIX: extension.vsixmanifest has duplicate ${match[1]} attributes.`);
    }
    attributes.set(key, match[3]);
  }
  for (const [attribute, expectedValue] of [
    ["id", expected.name],
    ["publisher", expected.publisher],
    ["version", expected.version],
  ]) {
    if (attributes.get(attribute) !== expectedValue) {
      throw new Error(`Invalid VSIX: VSIX manifest ${attribute} does not match the root package manifest.`);
    }
  }
}

function decodeNonEmptyManifest(buffer, label) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_MANIFEST_BYTES) {
    throw new Error(`Invalid VSIX: ${label} is empty or exceeds the manifest size limit.`);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`Invalid VSIX: ${label} is not valid UTF-8.`);
  }
  if (text.trim() === "") throw new Error(`Invalid VSIX: ${label} is empty.`);
  return text;
}

function requiredPayload(payloads, entryName) {
  const payload = payloads.get(entryName);
  if (!Buffer.isBuffer(payload)) {
    throw new Error(`Invalid VSIX: required manifest entry ${entryName} is missing.`);
  }
  return payload;
}

async function readExact(handle, position, length, label) {
  if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0) {
    throw new Error(`Invalid VSIX ${label} bounds.`);
  }
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error(`Invalid VSIX: truncated ${label}.`);
    offset += bytesRead;
  }
  return buffer;
}

function sameFileIdentity(left, right) {
  if (left.dev !== right.dev) return false;
  return left.ino !== 0 && right.ino !== 0 && left.ino === right.ino;
}

function sameFileSnapshot(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function zeroOrEqual(value, expected) {
  return value === 0 || value === expected;
}

function updateCrc32(crc, buffer) {
  let value = crc;
  for (const byte of buffer) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

async function main() {
  if (process.argv.length > 3) {
    throw new Error("Usage: node scripts/verify-vsix-contents.js [path-to-vsix]");
  }
  const vsixPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : defaultVsixPath();
  const entries = await verifyVsixContents(vsixPath);
  console.log(`Verified VSIX contents: ${vsixPath} (${entries.length} allowlisted entries).`);
}

module.exports = {
  defaultVsixPath,
  findDeniedVsixEntries,
  readVsixEntryNames,
  verifyVsixContents,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
