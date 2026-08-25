const fs = require("node:fs/promises");
const path = require("node:path");
const { createVSIX } = require("@vscode/vsce");
const { defaultVsixPath, verifyVsixContents } = require("./verify-vsix-contents");

// VSCE sorts entries and fixes ZIP mtimes when SOURCE_DATE_EPOCH is present.
// A stable, DOS-ZIP-compatible default makes identical source builds
// byte-for-byte reproducible while allowing CI to supply its own epoch.
const DEFAULT_SOURCE_DATE_EPOCH = "946684800"; // 2000-01-01T00:00:00Z

function ensureReproducibleEpoch() {
  const configured = process.env.SOURCE_DATE_EPOCH;
  if (configured !== undefined) {
    const epoch = Number(configured);
    if (!/^[1-9][0-9]{0,9}$/.test(configured)
      || !Number.isSafeInteger(epoch)
      || epoch < 315_532_800
      || epoch > 4_354_819_199) {
      throw new Error(
        "SOURCE_DATE_EPOCH must be a whole Unix timestamp representable by DOS ZIP metadata (1980 through 2107).",
      );
    }
  }
  process.env.SOURCE_DATE_EPOCH = configured ?? DEFAULT_SOURCE_DATE_EPOCH;
}

async function buildVsixOnce(options = {}) {
  ensureReproducibleEpoch();
  const packagePath = options.packagePath ?? defaultVsixPath();
  if (typeof packagePath !== "string"
    || !path.isAbsolute(packagePath)
    || path.extname(packagePath).toLowerCase() !== ".vsix") {
    throw new TypeError("VSIX output path must be an absolute .vsix path.");
  }
  try {
    await createVSIX({
      cwd: process.cwd(),
      packagePath,
      dependencies: false,
      preRelease: options.preRelease === true,
    });
    const entries = await verifyVsixContents(packagePath);
    console.log(`Release gate passed: ${packagePath} contains ${entries.length} safe entries.`);
    return entries;
  } catch (error) {
    await fs.unlink(packagePath).catch(() => undefined);
    throw error;
  }
}

async function main() {
  await buildVsixOnce(parsePackageArguments(process.argv.slice(2)));
}

function parsePackageArguments(args) {
  if (!Array.isArray(args)) {
    throw new TypeError("Package arguments must be an array.");
  }
  let preRelease = false;
  let packagePath;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--pre-release") {
      if (preRelease) throw new Error("Duplicate --pre-release argument.");
      preRelease = true;
      continue;
    }
    if (argument === "--output") {
      if (packagePath !== undefined) throw new Error("Duplicate --output argument.");
      const value = args[index + 1];
      if (typeof value !== "string" || value.startsWith("--")) {
        throw new Error("--output requires an absolute .vsix path.");
      }
      packagePath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unexpected package argument: ${String(argument)}`);
  }
  if (packagePath !== undefined
    && (!path.isAbsolute(packagePath)
      || path.extname(packagePath).toLowerCase() !== ".vsix")) {
    throw new Error("--output requires an absolute .vsix path.");
  }
  return Object.freeze({
    preRelease,
    ...(packagePath === undefined ? {} : { packagePath }),
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  buildVsixOnce,
  parsePackageArguments,
};
