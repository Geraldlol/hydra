const cp = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  defaultVsixPath,
  verifyVsixContents,
} = require("./verify-vsix-contents");
const {
  finishPackageLockCleanup,
  withPackageLock,
} = require("./vsix-package-lock");

const MAX_VSIX_BYTES = 128 * 1024 * 1024;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function buildReproducibleVsix(options) {
  if (!options
    || typeof options.packagePath !== "string"
    || !path.isAbsolute(options.packagePath)
    || typeof options.buildOnce !== "function"
    || typeof options.verify !== "function") {
    throw new TypeError(
      "VSIX reproducibility requires an absolute package path, builder, and verifier.",
    );
  }

  let temporaryRoot;
  let result;
  let primaryError;
  try {
    await removeFileIfPresent(options.packagePath);
    temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "hydra-vsix-repro-"),
    );
    const firstPath = path.join(temporaryRoot, "first.vsix");
    const secondPath = path.join(temporaryRoot, "second.vsix");

    await options.buildOnce(firstPath);
    const first = await readStableVsix(firstPath, "first VSIX package pass");
    const firstSha256 = sha256(first);

    await options.buildOnce(secondPath);
    const second = await readStableVsix(secondPath, "second VSIX package pass");
    const secondSha256 = sha256(second);

    if (!first.equals(second)) {
      throw new Error(
        `VSIX build is not reproducible: first SHA-256 ${firstSha256}, second SHA-256 ${secondSha256}.`,
      );
    }

    const entries = await options.verify(secondPath);
    const verified = await readStableVsix(
      secondPath,
      "verified second VSIX package pass",
    );
    if (!second.equals(verified)) {
      throw new Error(
        "The second VSIX artifact changed while its contents were verified.",
      );
    }

    await publishExactVsix(options.packagePath, second);
    const retained = await readStableVsix(
      options.packagePath,
      "retained reproducible VSIX",
    );
    if (!second.equals(retained)) {
      throw new Error(
        "The retained VSIX does not match the verified reproducible artifact.",
      );
    }
    result = Object.freeze({
      sha256: secondSha256,
      entries: entries.length,
    });
  } catch (error) {
    primaryError = error;
  }
  await finishReproducibilityCleanup(
    primaryError,
    options.packagePath,
    temporaryRoot,
  );
  return result;
}

function runPackageOnce(outputPath, preRelease) {
  const args = [
    path.join(__dirname, "package-vsix.js"),
    "--output",
    outputPath,
    ...(preRelease ? ["--pre-release"] : []),
  ];
  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) {
        resolve();
        return;
      }
      reject(new Error(
        `VSIX package pass failed${
          signal ? ` with signal ${signal}` : ` with exit code ${String(code)}`
        }.`,
      ));
    });
  });
}

async function readStableVsix(filePath, label) {
  let before;
  try {
    before = await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} did not create its isolated VSIX output.`);
    }
    throw error;
  }
  if (!before.isFile()
    || before.isSymbolicLink()
    || before.size < 1
    || before.size > MAX_VSIX_BYTES) {
    throw new Error(`${label} is not a bounded regular VSIX file.`);
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

async function publishExactVsix(packagePath, bytes) {
  const temporaryPath = path.join(
    path.dirname(packagePath),
    `.${path.basename(packagePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  let primaryError;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o644);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, packagePath);
  } catch (error) {
    primaryError = error;
  }
  await finishReproducibilityPublishCleanup(
    primaryError,
    temporaryPath,
    handle,
  );
}

async function removeFileIfPresent(filePath) {
  await fs.unlink(filePath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function finishReproducibilityCleanup(
  primaryError,
  packagePath,
  temporaryRoot,
  removeFile = removeFileIfPresent,
  removeDirectory = removeTemporaryRoot,
) {
  const errors = [];
  if (primaryError !== undefined) errors.push(primaryError);
  if (primaryError !== undefined) {
    try {
      await removeFile(packagePath);
    } catch (removeError) {
      errors.push(removeError);
    }
  }

  let temporaryCleanupFailed = false;
  if (temporaryRoot !== undefined) {
    try {
      await removeDirectory(temporaryRoot);
    } catch (removeError) {
      temporaryCleanupFailed = true;
      errors.push(removeError);
    }
  }

  if (primaryError === undefined && temporaryCleanupFailed) {
    try {
      await removeFile(packagePath);
    } catch (removeError) {
      errors.push(removeError);
    }
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "VSIX reproducibility operation failed and output cleanup also failed.",
    );
  }
}

async function finishReproducibilityPublishCleanup(
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
      "VSIX publication failed and temporary-resource cleanup also failed.",
    );
  }
}

async function removeTemporaryRoot(temporaryRoot) {
  await fs.rm(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
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

function parseReproducibilityArguments(args) {
  if (!Array.isArray(args)) {
    throw new TypeError("Reproducibility arguments must be an array.");
  }
  if (args.length === 0) return Object.freeze({ preRelease: false });
  if (args.length === 1 && args[0] === "--pre-release") {
    return Object.freeze({ preRelease: true });
  }
  throw new Error(
    `Unexpected or duplicate reproducibility arguments: ${args.join(" ")}`,
  );
}

async function main() {
  const { preRelease } = parseReproducibilityArguments(process.argv.slice(2));

  const packagePath = defaultVsixPath();
  const result = await withPackageLock(packagePath, () =>
    buildReproducibleVsix({
      packagePath,
      buildOnce: (outputPath) => runPackageOnce(outputPath, preRelease),
      verify: verifyVsixContents,
    })
  );
  console.log(
    `Reproducibility gate passed: ${packagePath} matched across two builds (${result.entries} safe entries, SHA-256 ${result.sha256}).`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  buildReproducibleVsix,
  finishPackageLockCleanup,
  finishReproducibilityCleanup,
  finishReproducibilityPublishCleanup,
  parseReproducibilityArguments,
  withPackageLock,
};
