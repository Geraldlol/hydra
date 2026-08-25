const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const {
  verifyVsixContents,
} = require("./verify-vsix-contents");
const {
  buildSpdxDocument,
  packageIdentity,
  rejectUnmodeledRuntimeDependencies,
} = require("./write-vsix-sbom");

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_CHECKSUM_BYTES = 4096;
const MAX_SBOM_BYTES = 16 * 1024 * 1024;
const MAX_VSIX_BYTES = 128 * 1024 * 1024;

async function verifyVsixReleaseHandoff(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const handoffDirectory = options.handoffDirectory;
  const sourceDateEpoch = options.sourceDateEpoch ?? process.env.SOURCE_DATE_EPOCH;
  const verify = options.verify ?? verifyVsixContents;
  if (typeof projectRoot !== "string"
    || !path.isAbsolute(projectRoot)
    || typeof handoffDirectory !== "string"
    || !path.isAbsolute(handoffDirectory)
    || typeof verify !== "function") {
    throw new TypeError(
      "Release handoff verification requires absolute project/handoff paths and an archive verifier.",
    );
  }

  const handoffStats = await fs.lstat(handoffDirectory);
  if (!handoffStats.isDirectory() || handoffStats.isSymbolicLink()) {
    throw new Error("Release handoff path must be an unlinked directory.");
  }

  const manifest = parseJson(
    await readStableFile(
      path.join(projectRoot, "package.json"),
      "trusted package.json",
      MAX_MANIFEST_BYTES,
    ),
    "trusted package.json",
  );
  const identity = packageIdentity(manifest);
  rejectUnmodeledRuntimeDependencies(manifest);
  const packageName = `${identity.name}-${identity.version}.vsix`;
  const sbomName = `${identity.name}-${identity.version}.spdx.json`;
  const expectedNames = ["SHA256SUMS.txt", packageName, sbomName].sort();
  const packagePath = path.join(handoffDirectory, packageName);
  const referencePackagePath = path.join(projectRoot, packageName);
  const checksumPath = path.join(handoffDirectory, "SHA256SUMS.txt");
  const sbomPath = path.join(handoffDirectory, sbomName);

  await requireExactEntries(handoffDirectory, expectedNames);
  const checksumBytes = await readStableFile(
    checksumPath,
    "release SHA256SUMS.txt",
    MAX_CHECKSUM_BYTES,
  );
  const checksumText = decodeUtf8(checksumBytes, "release SHA256SUMS.txt");
  const checksumMatch = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*\.vsix)\n$/.exec(
    checksumText,
  );
  if (!checksumMatch || checksumMatch[2] !== packageName) {
    throw new Error(
      `SHA256SUMS.txt must contain one newline-terminated checksum for the exact release VSIX ${packageName}.`,
    );
  }
  const expectedSha256 = checksumMatch[1];

  const beforeVerification = await readStableFile(
    packagePath,
    "release VSIX before archive verification",
    MAX_VSIX_BYTES,
  );
  if (sha256(beforeVerification) !== expectedSha256) {
    throw new Error("Release VSIX digest does not match SHA256SUMS.txt.");
  }
  const independentlyRebuilt = await readStableFile(
    referencePackagePath,
    "independently rebuilt release VSIX",
    MAX_VSIX_BYTES,
  );
  if (!beforeVerification.equals(independentlyRebuilt)) {
    throw new Error(
      "Release VSIX differs from the independently rebuilt package for this source revision.",
    );
  }

  await verify(packagePath, projectRoot);
  const afterVerification = await readStableFile(
    packagePath,
    "release VSIX after archive verification",
    MAX_VSIX_BYTES,
  );
  if (!afterVerification.equals(beforeVerification)
    || sha256(afterVerification) !== expectedSha256) {
    throw new Error("Release VSIX changed while its archive contents were verified.");
  }

  const expectedDocument = buildSpdxDocument(
    identity,
    expectedSha256,
    sourceDateEpoch,
  );
  const expectedSbom = Buffer.from(
    `${JSON.stringify(expectedDocument, null, 2)}\n`,
    "utf8",
  );
  const actualSbom = await readStableFile(
    sbomPath,
    "release SPDX document",
    MAX_SBOM_BYTES,
  );
  if (!actualSbom.equals(expectedSbom)) {
    throw new Error(
      "Release SPDX document is not the exact canonical source-, license-, namespace-, and digest-bound document.",
    );
  }

  await requireExactEntries(handoffDirectory, expectedNames);
  const finalPackage = await readStableFile(
    packagePath,
    "final release VSIX",
    MAX_VSIX_BYTES,
  );
  const finalChecksum = await readStableFile(
    checksumPath,
    "final release SHA256SUMS.txt",
    MAX_CHECKSUM_BYTES,
  );
  const finalSbom = await readStableFile(
    sbomPath,
    "final release SPDX document",
    MAX_SBOM_BYTES,
  );
  const finalIndependentlyRebuilt = await readStableFile(
    referencePackagePath,
    "final independently rebuilt release VSIX",
    MAX_VSIX_BYTES,
  );
  if (!finalPackage.equals(afterVerification)
    || !finalChecksum.equals(checksumBytes)
    || !finalSbom.equals(actualSbom)
    || !finalIndependentlyRebuilt.equals(independentlyRebuilt)) {
    throw new Error("Release handoff changed while its files were validated.");
  }

  return Object.freeze({
    packagePath,
    checksumPath,
    sbomPath,
    sha256: expectedSha256,
  });
}

async function requireExactEntries(directoryPath, expectedNames) {
  const actualNames = (await fs.readdir(directoryPath, { withFileTypes: true }))
    .map((entry) => entry.name)
    .sort();
  if (actualNames.length !== expectedNames.length
    || actualNames.some((name, index) => name !== expectedNames[index])) {
    throw new Error(
      `Release handoff must contain exactly ${expectedNames.join(", ")}; found ${
        actualNames.length === 0 ? "nothing" : actualNames.join(", ")
      }.`,
    );
  }
}

async function readStableFile(filePath, label, maxBytes) {
  const before = await fs.lstat(filePath);
  if (!before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.size < 1
    || before.size > maxBytes) {
    throw new Error(`${label} is not a bounded regular file with link count one.`);
  }

  const handle = await fs.open(filePath, "r");
  let primaryError;
  try {
    const opened = await handle.stat();
    if (!sameFileSnapshot(before, opened)) {
      throw new Error(`${label} changed while it was opened.`);
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) throw new Error(`${label} was truncated while read.`);
      offset += bytesRead;
    }
    if (!sameFileSnapshot(opened, await handle.stat())) {
      throw new Error(`${label} changed while it was read.`);
    }
    return bytes;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (closeError) {
      if (primaryError !== undefined) {
        throw new AggregateError(
          [primaryError, closeError],
          `${label} validation and file-handle cleanup both failed.`,
        );
      }
      throw closeError;
    }
  }
}

function parseJson(bytes, label) {
  const text = decodeUtf8(bytes, label);
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} must contain a JSON object.`);
    }
    return value;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON.`);
    throw error;
  }
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameFileSnapshot(left, right) {
  return left.isFile()
    && right.isFile()
    && left.nlink === 1
    && right.nlink === 1
    && String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function main() {
  if (process.argv.length !== 3) {
    throw new Error(
      "Usage: node scripts/verify-vsix-release-handoff.js <handoff-directory>",
    );
  }
  const projectRoot = process.cwd();
  const handoffDirectory = path.resolve(process.argv[2]);
  const result = await verifyVsixReleaseHandoff({
    projectRoot,
    handoffDirectory,
  });
  console.log(
    `Verified canonical release handoff for ${path.basename(result.packagePath)} (${result.sha256}).`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  verifyVsixReleaseHandoff,
};
