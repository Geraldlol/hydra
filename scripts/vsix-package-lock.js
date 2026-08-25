const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function withPackageLock(packagePath, operation) {
  if (typeof packagePath !== "string"
    || !path.isAbsolute(packagePath)
    || typeof operation !== "function") {
    throw new TypeError(
      "An absolute package path and lock operation are required.",
    );
  }
  const realParent = await fs.realpath(path.dirname(packagePath));
  const resolvedIdentity = path.join(realParent, path.basename(packagePath));
  const identity = process.platform === "win32"
    ? resolvedIdentity.toLowerCase()
    : resolvedIdentity;
  const digest = createHash("sha256")
    .update(identity, "utf8")
    .digest("hex");
  const lockPath = path.join(
    os.tmpdir(),
    `hydra-vsix-package-${digest.slice(0, 32)}.lock`,
  );
  let handle;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(
        `Another VSIX package run is already running or left an exclusive package lock at ${lockPath}.`,
      );
    }
    throw error;
  }
  let result;
  let primaryError;
  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, packagePath, startedAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    await handle.sync();
    result = await operation();
  } catch (error) {
    primaryError = error;
  }
  await finishPackageLockCleanup(primaryError, lockPath, handle);
  return result;
}

async function finishPackageLockCleanup(
  primaryError,
  lockPath,
  handle,
  remove = (filePath) => fs.unlink(filePath),
) {
  const errors = [];
  if (primaryError !== undefined) errors.push(primaryError);
  try {
    await handle.close();
  } catch (closeError) {
    errors.push(closeError);
  }
  try {
    await remove(lockPath);
  } catch (removeError) {
    errors.push(removeError);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "VSIX package operation failed and exclusive-lock cleanup also failed.",
    );
  }
}

module.exports = {
  finishPackageLockCleanup,
  withPackageLock,
};
