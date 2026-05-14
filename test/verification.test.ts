import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendVerification,
  ensureVerificationFile,
  inferVerificationCommand,
  readVerifications,
  verificationAsReviewContext,
  verificationPassed,
  verificationSummary,
} from "../src/verification";

describe("verification evidence", () => {
  test("infers npm check plus test scripts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-verify-"));
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { check: "tsc", test: "node --test" } }),
      "utf8"
    );
    assert.equal(await inferVerificationCommand(dir), "npm run check && npm test");
  });

  test("round-trips verification JSONL and skips malformed lines", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-verify-"));
    const file = path.join(dir, ".hydra", "verification.jsonl");
    const result = {
      timestamp: "2026-05-09T10:00:00.000Z",
      command: "npm test",
      cwd: dir,
      exitCode: 0,
      timedOut: false,
      durationMs: 1200,
      stdout: "ok",
      stderr: "",
    };
    await ensureVerificationFile(file);
    await appendVerification(file, result);
    await fs.appendFile(file, "nope\n", "utf8");
    assert.deepEqual(await readVerifications(file), [result]);
  });

  test("formats latest verification for review prompts and UI", () => {
    const result = {
      timestamp: "2026-05-09T10:00:00.000Z",
      command: "npm test",
      cwd: "C:\\repo",
      exitCode: 1,
      timedOut: false,
      durationMs: 65000,
      stdout: "tests failed",
      stderr: "boom",
    };
    assert.match(verificationAsReviewContext(result), /Command: npm test/);
    assert.match(verificationAsReviewContext(result), /Exit code: 1/);
    assert.match(verificationSummary(result), /failed: npm test \(1m 05s\)/);
  });

  test("treats only clean zero-exit runs as passed", () => {
    const base = {
      timestamp: "2026-05-09T10:00:00.000Z",
      command: "npm test",
      cwd: "C:\\repo",
      exitCode: 0,
      timedOut: false,
      durationMs: 1000,
      stdout: "",
      stderr: "",
    };
    assert.equal(verificationPassed(base), true);
    assert.equal(verificationPassed({ ...base, exitCode: 1 }), false);
    assert.equal(verificationPassed({ ...base, exitCode: null }), false);
    assert.equal(verificationPassed({ ...base, timedOut: true }), false);
    assert.equal(verificationPassed(undefined), false);
  });
});
