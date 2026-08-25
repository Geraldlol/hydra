const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  defaultVsixPath,
  verifyVsixContents,
} = require("./verify-vsix-contents");
const { withPackageLock } = require("./vsix-package-lock");

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_CHECKSUM_BYTES = 4096;
const MAX_VSIX_BYTES = 128 * 1024 * 1024;
const RUNTIME_DEPENDENCY_FIELDS = Object.freeze([
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundledDependencies",
  "bundleDependencies",
]);
const KNOWN_LICENSE_EXPRESSIONS = new Set([
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "GPL-2.0-only",
  "GPL-3.0-only",
  "ISC",
  "LGPL-2.1-only",
  "LGPL-3.0-only",
  "MIT",
  "MPL-2.0",
  "NONE",
  "NOASSERTION",
  "Unlicense",
]);

async function writeVsixSbom(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const verify = options.verify ?? verifyVsixContents;
  const sourceDateEpoch = options.sourceDateEpoch ?? process.env.SOURCE_DATE_EPOCH;
  if (typeof projectRoot !== "string"
    || !path.isAbsolute(projectRoot)
    || typeof verify !== "function") {
    throw new TypeError(
      "VSIX SBOM generation requires an absolute project root and archive verifier.",
    );
  }

  const manifest = await readJsonFile(
    path.join(projectRoot, "package.json"),
    "package.json",
    MAX_MANIFEST_BYTES,
  );
  const identity = packageIdentity(manifest);
  const expectedName = `${identity.name}-${identity.version}.vsix`;
  const packagePath = path.join(projectRoot, expectedName);
  const sbomPath = path.join(
    projectRoot,
    `${identity.name}-${identity.version}.spdx.json`,
  );
  const checksumPath = path.join(projectRoot, "SHA256SUMS.txt");
  await removeFileIfPresent(sbomPath);

  try {
    rejectUnmodeledRuntimeDependencies(manifest);
    await requireExactRootVsix(projectRoot, expectedName);
    const checksumText = await readStableText(
      checksumPath,
      "SHA256SUMS.txt",
      MAX_CHECKSUM_BYTES,
    );
    const expectedSha256 = parseReleaseChecksum(checksumText, expectedName);
    await verify(packagePath, projectRoot);
    await requireExactRootVsix(projectRoot, expectedName);
    const sha256 = await hashStableFile(packagePath, "release VSIX");
    if (sha256 !== expectedSha256) {
      throw new Error(
        `Release VSIX digest does not match SHA256SUMS.txt for ${expectedName}.`,
      );
    }

    const document = buildSpdxDocument(identity, sha256, sourceDateEpoch);
    await publishFile(sbomPath, `${JSON.stringify(document, null, 2)}\n`);
    return Object.freeze({ packagePath, sbomPath, sha256 });
  } catch (error) {
    await rethrowAfterCleanup(error, sbomPath);
  }
}

function packageIdentity(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("package.json must contain a JSON object.");
  }
  const name = manifest.name;
  const version = manifest.version;
  if (typeof name !== "string"
    || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(name)) {
    throw new Error("package.json has an invalid extension package name.");
  }
  if (typeof version !== "string"
    || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("package.json has an invalid extension version.");
  }
  const declaredLicense = manifest.license;
  const license = typeof declaredLicense === "string"
      && KNOWN_LICENSE_EXPRESSIONS.has(declaredLicense)
    ? declaredLicense
    : "NOASSERTION";
  return Object.freeze({ name, version, license });
}

function rejectUnmodeledRuntimeDependencies(manifest) {
  const found = [];
  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    const value = manifest[field];
    if (Array.isArray(value)) {
      for (const dependency of value) {
        if (typeof dependency === "string" && dependency.trim() !== "") {
          found.push(`${field}:${dependency}`);
        }
      }
      continue;
    }
    if (value && typeof value === "object") {
      for (const dependency of Object.keys(value)) {
        found.push(`${field}:${dependency}`);
      }
    }
  }
  if (found.length > 0) {
    throw new Error(
      `Runtime dependencies require explicit SBOM component modeling before release: ${found.sort().join(", ")}.`,
    );
  }
}

async function requireExactRootVsix(projectRoot, expectedName) {
  const entries = await fs.readdir(projectRoot, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.name.toLowerCase().endsWith(".vsix"))
    .map((entry) => entry.name)
    .sort();
  if (names.length !== 1 || names[0] !== expectedName) {
    throw new Error(
      `SBOM generation requires exactly one root VSIX named ${expectedName}; found ${
        names.length === 0 ? "none" : names.join(", ")
      }.`,
    );
  }
}

function parseReleaseChecksum(contents, expectedName) {
  const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*\.vsix)\n$/.exec(contents);
  if (!match) {
    throw new Error(
      "SHA256SUMS.txt must contain exactly one lowercase SHA-256 checksum line.",
    );
  }
  if (match[2] !== expectedName) {
    throw new Error(
      `SHA256SUMS.txt artifact name must be exactly ${expectedName}.`,
    );
  }
  return match[1];
}

function buildSpdxDocument(identity, sha256, sourceDateEpoch) {
  const packageId = "SPDXRef-Package-Hydra";
  const name = `${identity.name}-${identity.version}-vsix`;
  const creationInfo = {
    created: reproducibleTimestamp(sourceDateEpoch),
    creators: ["Tool: hydra-vsix-sbom-1.0.0"],
    comment:
      "Reproducible creation time is the release source revision's declared SOURCE_DATE_EPOCH.",
  };
  const documentDescribes = [packageId];
  const packages = [{
    name: identity.name,
    SPDXID: packageId,
    versionInfo: identity.version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseDeclared: identity.license,
    licenseConcluded: "NOASSERTION",
    copyrightText: "NOASSERTION",
    checksums: [{ algorithm: "SHA256", checksumValue: sha256 }],
  }];
  const relationships = [{
    spdxElementId: "SPDXRef-DOCUMENT",
    relationshipType: "DESCRIBES",
    relatedSpdxElement: packageId,
  }];
  const semanticDocument = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name,
    creationInfo,
    documentDescribes,
    packages,
    relationships,
  };
  const semanticSha256 = createHash("sha256")
    .update(JSON.stringify(semanticDocument), "utf8")
    .digest("hex");
  return {
    spdxVersion: semanticDocument.spdxVersion,
    dataLicense: semanticDocument.dataLicense,
    SPDXID: semanticDocument.SPDXID,
    name,
    documentNamespace: `https://spdx.org/spdxdocs/${encodeURIComponent(identity.name)}-${encodeURIComponent(identity.version)}-${sha256}-${semanticSha256}`,
    creationInfo,
    documentDescribes,
    packages,
    relationships,
  };
}

function reproducibleTimestamp(configured) {
  if (configured === undefined) {
    throw new Error(
      "SOURCE_DATE_EPOCH is required for a deterministic, source-bound SPDX creation time.",
    );
  }
  if (typeof configured !== "string") {
    throw new Error("SOURCE_DATE_EPOCH must be supplied as a Unix timestamp string.");
  }
  const epoch = Number(configured);
  if (!/^[1-9][0-9]{0,9}$/.test(configured)
    || !Number.isSafeInteger(epoch)
    || epoch < 315_532_800
    || epoch > 4_354_819_199) {
    throw new Error(
      "SOURCE_DATE_EPOCH must be a whole Unix timestamp from 1980 through 2107.",
    );
  }
  return new Date(epoch * 1000).toISOString().replace(".000Z", "Z");
}

async function readJsonFile(filePath, label, maxBytes) {
  const contents = await readStableText(filePath, label, maxBytes);
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

async function readStableText(filePath, label, maxBytes) {
  const before = await fs.lstat(filePath);
  if (!before.isFile()
    || before.isSymbolicLink()
    || before.size < 1
    || before.size > maxBytes) {
    throw new Error(`${label} is not a bounded regular file.`);
  }
  const handle = await fs.open(filePath, "r");
  let failed = false;
  try {
    const opened = await handle.stat();
    if (!sameFileSnapshot(before, opened)) {
      throw new Error(`${label} changed while it was opened.`);
    }
    const contents = await handle.readFile("utf8");
    if (Buffer.byteLength(contents, "utf8") !== opened.size
      || !sameFileSnapshot(opened, await handle.stat())) {
      throw new Error(`${label} changed while it was read.`);
    }
    return contents;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (!failed) throw error;
    }
  }
}

async function hashStableFile(filePath, label) {
  const before = await fs.lstat(filePath);
  if (!before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || before.size < 1
    || before.size > MAX_VSIX_BYTES) {
    throw new Error(`${label} is not a bounded regular file.`);
  }
  const handle = await fs.open(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let failed = false;
  try {
    const opened = await handle.stat();
    if (!sameFileSnapshot(before, opened)) {
      throw new Error(`${label} changed while it was opened.`);
    }
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < opened.size) {
      const length = Math.min(buffer.length, opened.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) throw new Error(`${label} was truncated while read.`);
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (!sameFileSnapshot(opened, await handle.stat())) {
      throw new Error(`${label} changed while it was read.`);
    }
    return hash.digest("hex");
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    buffer.fill(0);
    try {
      await handle.close();
    } catch (error) {
      if (!failed) throw error;
    }
  }
}

async function publishFile(filePath, contents) {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  let primaryError;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o644);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    primaryError = error;
  }
  await finishPublishCleanup(primaryError, temporaryPath, handle);
}

async function finishPublishCleanup(
  primaryError,
  temporaryPath,
  handle,
  remove = removeFileIfPresent,
) {
  const errors = [];
  if (primaryError !== undefined) errors.push(primaryError);
  if (handle) {
    try {
      await handle.close();
    } catch (closeError) {
      errors.push(closeError);
    }
  }
  try {
    await remove(temporaryPath);
  } catch (removeError) {
    errors.push(removeError);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "VSIX SBOM publish failed and temporary-resource cleanup also failed.",
    );
  }
}

async function removeFileIfPresent(filePath) {
  await fs.unlink(filePath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
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

async function rethrowAfterCleanup(
  primaryError,
  sbomPath,
  remove = removeFileIfPresent,
) {
  try {
    await remove(sbomPath);
  } catch (cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "VSIX SBOM generation failed and stale-output cleanup also failed.",
    );
  }
  throw primaryError;
}

async function main() {
  if (process.argv.length !== 2) {
    throw new Error("Usage: node scripts/write-vsix-sbom.js");
  }
  const packagePath = defaultVsixPath();
  const result = await withPackageLock(
    packagePath,
    () => writeVsixSbom(),
  );
  console.log(
    `Recorded SPDX SBOM for ${path.basename(result.packagePath)} at ${result.sbomPath}.`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  buildSpdxDocument,
  finishPublishCleanup,
  packageIdentity,
  rejectUnmodeledRuntimeDependencies,
  rethrowAfterCleanup,
  writeVsixSbom,
};
