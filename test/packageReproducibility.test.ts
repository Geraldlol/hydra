import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

interface ReproducibilityGate {
  buildReproducibleVsix(options: {
    packagePath: string;
    buildOnce: (outputPath: string) => Promise<void>;
    verify: (packagePath: string) => Promise<readonly string[]>;
  }): Promise<{ readonly sha256: string; readonly entries: number }>;
  parseReproducibilityArguments(args: readonly string[]): {
    readonly preRelease: boolean;
  };
  finishReproducibilityCleanup(
    primaryError: unknown,
    packagePath: string,
    temporaryRoot?: string,
    removeFile?: (filePath: string) => Promise<void>,
    removeDirectory?: (directoryPath: string) => Promise<void>,
  ): Promise<void>;
  finishReproducibilityPublishCleanup(
    primaryError: unknown,
    temporaryPath: string,
    handle?: { close(): Promise<void> },
    remove?: (filePath: string) => Promise<void>,
  ): Promise<void>;
  finishPackageLockCleanup(
    primaryError: unknown,
    lockPath: string,
    handle: { close(): Promise<void> },
    remove?: (filePath: string) => Promise<void>,
  ): Promise<void>;
  withPackageLock<T>(packagePath: string, operation: () => Promise<T>): Promise<T>;
}

interface PackageBuilder {
  parsePackageArguments(args: readonly string[]): {
    readonly preRelease: boolean;
    readonly packagePath?: string;
  };
}

const repoRoot = process.cwd();

function loadGate(): ReproducibilityGate {
  return require(
    path.join(repoRoot, "scripts", "verify-vsix-reproducibility.js"),
  ) as ReproducibilityGate;
}

function loadPackageBuilder(): PackageBuilder {
  return require(path.join(repoRoot, "scripts", "package-vsix.js")) as PackageBuilder;
}

describe("VSIX reproducibility gate", () => {
  test("builds twice, verifies the retained artifact, and reports its digest", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-repro-vsix-"));
    const packagePath = path.join(root, "candidate.vsix");
    t.after(async () => fs.rm(root, { recursive: true, force: true }));
    const bytes = Buffer.from("byte-identical-vsix", "utf8");
    let builds = 0;
    let verified = "";
    const outputs: string[] = [];

    const result = await loadGate().buildReproducibleVsix({
      packagePath,
      buildOnce: async (outputPath) => {
        builds += 1;
        outputs.push(outputPath);
        await fs.writeFile(outputPath, bytes);
      },
      verify: async (candidate) => {
        verified = candidate;
        return ["extension/package.json", "extension/dist/src/extension.js"];
      },
    });

    assert.equal(builds, 2);
    assert.equal(new Set(outputs).size, 2);
    assert.ok(outputs.every((output) => output !== packagePath));
    assert.equal(verified, outputs[1]);
    assert.equal(result.entries, 2);
    assert.equal(
      result.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.deepEqual(await fs.readFile(packagePath), bytes);
  });

  test("fails closed and removes the second artifact when builds differ", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-repro-vsix-"));
    const packagePath = path.join(root, "candidate.vsix");
    t.after(async () => fs.rm(root, { recursive: true, force: true }));
    let builds = 0;
    let verified = false;

    await assert.rejects(
      loadGate().buildReproducibleVsix({
        packagePath,
        buildOnce: async (outputPath) => {
          builds += 1;
          await fs.writeFile(outputPath, `build-${builds}`, "utf8");
        },
        verify: async () => {
          verified = true;
          return [];
        },
      }),
      /not reproducible|SHA-256|differ/u,
    );

    assert.equal(builds, 2);
    assert.equal(verified, false);
    await assert.rejects(fs.access(packagePath), /ENOENT/u);
  });

  test("removes a byte-identical artifact when final verification rejects it", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-repro-vsix-"));
    const packagePath = path.join(root, "candidate.vsix");
    t.after(async () => fs.rm(root, { recursive: true, force: true }));

    await assert.rejects(
      loadGate().buildReproducibleVsix({
        packagePath,
        buildOnce: (outputPath) =>
          fs.writeFile(outputPath, "same-build", "utf8"),
        verify: async () => {
          throw new Error("final verifier rejected stale runtime");
        },
      }),
      /final verifier rejected stale runtime/u,
    );

    await assert.rejects(fs.access(packagePath), /ENOENT/u);
  });

  test("rejects a verifier mutation instead of publishing different bytes", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-repro-vsix-"));
    const packagePath = path.join(root, "candidate.vsix");
    t.after(async () => fs.rm(root, { recursive: true, force: true }));

    await assert.rejects(
      loadGate().buildReproducibleVsix({
        packagePath,
        buildOnce: (outputPath) =>
          fs.writeFile(outputPath, "same-build", "utf8"),
        verify: async (candidate) => {
          await fs.appendFile(candidate, "-mutated", "utf8");
          return [];
        },
      }),
      /changed while its contents were verified/u,
    );

    await assert.rejects(fs.access(packagePath), /ENOENT/u);
  });

  test("cannot pass by reusing the first output for a no-op second build", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-repro-vsix-"));
    const packagePath = path.join(root, "candidate.vsix");
    t.after(async () => fs.rm(root, { recursive: true, force: true }));
    let builds = 0;

    await assert.rejects(
      loadGate().buildReproducibleVsix({
        packagePath,
        buildOnce: async (outputPath) => {
          builds += 1;
          if (builds === 1) await fs.writeFile(outputPath, "first", "utf8");
        },
        verify: async () => [],
      }),
      /ENOENT|did not create|missing/u,
    );

    assert.equal(builds, 2);
    await assert.rejects(fs.access(packagePath), /ENOENT/u);
  });

  test("does not retain pass one when the second builder throws", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-repro-vsix-"));
    const packagePath = path.join(root, "candidate.vsix");
    t.after(async () => fs.rm(root, { recursive: true, force: true }));
    let builds = 0;

    await assert.rejects(
      loadGate().buildReproducibleVsix({
        packagePath,
        buildOnce: async (outputPath) => {
          builds += 1;
          if (builds === 2) throw new Error("second package process failed");
          await fs.writeFile(outputPath, "first", "utf8");
        },
        verify: async () => [],
      }),
      /second package process failed/u,
    );

    assert.equal(builds, 2);
    await assert.rejects(fs.access(packagePath), /ENOENT/u);
  });

  test("serializes package publication with an external exclusive lock", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-repro-vsix-"));
    const packagePath = path.join(root, "candidate.vsix");
    t.after(async () => fs.rm(root, { recursive: true, force: true }));
    const gate = loadGate();

    await gate.withPackageLock(packagePath, async () => {
      await assert.rejects(
        gate.withPackageLock(packagePath, async () => undefined),
        /already running|exclusive package lock/u,
      );
    });
    assert.equal(
      await gate.withPackageLock(packagePath, async () => "released"),
      "released",
    );
  });

  test("preserves reproducibility, rejected-output, and temp-directory cleanup failures", async () => {
    const primary = new Error("reproducibility failed");
    const outputCleanup = new Error("candidate cleanup denied");
    const temporaryCleanup = new Error("temporary directory cleanup denied");

    await assert.rejects(
      loadGate().finishReproducibilityCleanup(
        primary,
        "candidate.vsix",
        "temporary-root",
        async () => { throw outputCleanup; },
        async () => { throw temporaryCleanup; },
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(
          error.errors,
          [primary, outputCleanup, temporaryCleanup],
        );
        return true;
      },
    );
  });

  test("turns successful-build temp cleanup failure into a failure and removes the retained output", async () => {
    const temporaryCleanup = new Error("temporary directory cleanup denied");
    let removedOutput = "";

    await assert.rejects(
      loadGate().finishReproducibilityCleanup(
        undefined,
        "candidate.vsix",
        "temporary-root",
        async (filePath) => { removedOutput = filePath; },
        async () => { throw temporaryCleanup; },
      ),
      temporaryCleanup,
    );
    assert.equal(removedOutput, "candidate.vsix");
  });

  test("preserves publication and package-lock cleanup failures without reporting success", async () => {
    const primary = new Error("release operation failed");
    const close = new Error("cleanup handle close denied");
    const unlink = new Error("cleanup unlink denied");
    const gate = loadGate();

    for (const cleanup of [
      () => gate.finishReproducibilityPublishCleanup(
        primary,
        ".candidate.vsix.tmp",
        { close: async () => { throw close; } },
        async () => { throw unlink; },
      ),
      () => gate.finishPackageLockCleanup(
        primary,
        "candidate.lock",
        { close: async () => { throw close; } },
        async () => { throw unlink; },
      ),
    ]) {
      await assert.rejects(
        cleanup(),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.deepEqual(error.errors, [primary, close, unlink]);
          return true;
        },
      );
    }

    await assert.rejects(
      gate.finishPackageLockCleanup(
        undefined,
        "candidate.lock",
        { close: async () => undefined },
        async () => { throw unlink; },
      ),
      unlink,
    );
  });

  test("strictly parses isolated package and pre-release arguments", () => {
    const outputPath = path.resolve("candidate.vsix");
    const builder = loadPackageBuilder();
    const gate = loadGate();

    assert.deepEqual(builder.parsePackageArguments([]), { preRelease: false });
    assert.deepEqual(
      builder.parsePackageArguments(["--output", outputPath, "--pre-release"]),
      { preRelease: true, packagePath: outputPath },
    );
    assert.deepEqual(gate.parseReproducibilityArguments([]), {
      preRelease: false,
    });
    assert.deepEqual(gate.parseReproducibilityArguments(["--pre-release"]), {
      preRelease: true,
    });
    for (const args of [
      ["--output"],
      ["--output", "relative.vsix"],
      ["--output", outputPath, "--output", outputPath],
      ["--pre-release", "--pre-release"],
      ["--unknown"],
    ]) {
      assert.throws(() => builder.parsePackageArguments(args), /argument|output|duplicate/i);
    }
    assert.throws(
      () => gate.parseReproducibilityArguments(["--pre-release", "--pre-release"]),
      /argument|duplicate/i,
    );
  });

  test("wires normal and pre-release packaging through the two-build gate", async () => {
    const pkg = JSON.parse(
      await fs.readFile(path.join(repoRoot, "package.json"), "utf8"),
    ) as { readonly scripts?: Record<string, string> };
    assert.equal(
      pkg.scripts?.package,
      "node scripts/verify-vsix-reproducibility.js",
    );
    assert.equal(
      pkg.scripts?.["package:pre-release"],
      "node scripts/verify-vsix-reproducibility.js --pre-release",
    );
    const ci = await fs.readFile(
      path.join(repoRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const releaseCandidate = await fs.readFile(
      path.join(repoRoot, ".github", "workflows", "release-candidate.yml"),
      "utf8",
    );
    assert.match(ci, /Build VSIX twice and compare bytes[\s\S]*pnpm run package/u);
    assert.match(
      releaseCandidate,
      /Build release VSIX twice and compare bytes[\s\S]*run: pnpm run package\s*$/mu,
    );
    assert.doesNotMatch(releaseCandidate, /package:pre-release|--pre-release/u);
  });
});
