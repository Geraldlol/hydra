const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  defaultVsixPath,
  verifyVsixContents,
} = require("./verify-vsix-contents");
const { withPackageLock } = require("./vsix-package-lock");

const MAX_VSIX_BYTES = 128 * 1024 * 1024;

async function writeVsixDigest(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const verify = options.verify ?? verifyVsixContents;
  if (typeof projectRoot !== "string"
    || !path.isAbsolute(projectRoot)
    || typeof verify !== "function") {
    throw new TypeError(
      "VSIX digest generation requires an absolute project root and verifier.",
    );
  }

  const packagePath = defaultVsixPath(projectRoot);
  const expectedName = path.basename(packagePath);
  const digestPath = path.join(projectRoot, "SHA256SUMS.txt");
  await removeFileIfPresent(digestPath);

  try {
    const rootEntries = await fs.readdir(projectRoot, { withFileTypes: true });
    const vsixEntries = rootEntries
      .filter((entry) => entry.name.toLowerCase().endsWith(".vsix"))
      .map((entry) => entry.name)
      .sort();
    if (vsixEntries.length !== 1 || vsixEntries[0] !== expectedName) {
      throw new Error(
        `Release digest requires exactly one root VSIX named ${expectedName}; found ${
          vsixEntries.length === 0 ? "none" : vsixEntries.join(", ")
        }.`,
      );
    }

    const beforeVerification = await readStableVsix(
      packagePath,
      "release VSIX before digest verification",
    );
    await verify(packagePath, projectRoot);
    const afterVerification = await readStableVsix(
      packagePath,
      "release VSIX after digest verification",
    );
    if (!beforeVerification.equals(afterVerification)) {
      throw new Error(
        "Release VSIX changed while its digest contents were verified.",
      );
    }

    const sha256 = createHash("sha256")
      .update(afterVerification)
      .digest("hex");
    await publishDigest(
      digestPath,
      `${sha256}  ${expectedName}\n`,
    );
    return Object.freeze({ packagePath, digestPath, sha256 });
  } catch (error) {
    await rethrowAfterDigestCleanup(error, digestPath);
  }
}

async function readStableVsix(filePath, label) {
  const before = await fs.lstat(filePath);
  if (!before.isFile()
    || before.isSymbolicLink()
    || before.size < 1
    || before.size > MAX_VSIX_BYTES) {
    throw new Error(`${label} is not a bounded regular file.`);
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

async function publishDigest(digestPath, contents) {
  const temporaryPath = path.join(
    path.dirname(digestPath),
    `.${path.basename(digestPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  let primaryError;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o644);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, digestPath);
  } catch (error) {
    primaryError = error;
  }
  await finishDigestPublishCleanup(primaryError, temporaryPath, handle);
}

async function finishDigestPublishCleanup(
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
      "VSIX digest publish failed and temporary-resource cleanup also failed.",
    );
  }
}

async function removeFileIfPresent(filePath) {
  await fs.unlink(filePath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function rethrowAfterDigestCleanup(
  primaryError,
  digestPath,
  remove = removeFileIfPresent,
) {
  try {
    await remove(digestPath);
  } catch (cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "VSIX digest generation failed and stale-output cleanup also failed.",
    );
  }
  throw primaryError;
}

function sameFileSnapshot(left, right) {
  return left.isFile()
    && right.isFile()
    && String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function main() {
  if (process.argv.length !== 2) {
    throw new Error("Usage: node scripts/write-vsix-digest.js");
  }
  const packagePath = defaultVsixPath();
  const result = await withPackageLock(
    packagePath,
    () => writeVsixDigest(),
  );
  console.log(
    `Recorded ${result.sha256}  ${path.basename(result.packagePath)} in ${result.digestPath}.`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  finishDigestPublishCleanup,
  rethrowAfterDigestCleanup,
  writeVsixDigest,
};
