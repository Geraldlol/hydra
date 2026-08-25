import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

interface DigestWriter {
  finishDigestPublishCleanup(
    primaryError: unknown,
    temporaryPath: string,
    handle?: { close(): Promise<void> },
    remove?: (filePath: string) => Promise<void>,
  ): Promise<void>;
  rethrowAfterDigestCleanup(
    primaryError: unknown,
    digestPath: string,
    remove?: (filePath: string) => Promise<void>,
  ): Promise<never>;
  writeVsixDigest(options: {
    readonly projectRoot: string;
    readonly verify: (
      packagePath: string,
      projectRoot: string,
    ) => Promise<readonly string[]>;
  }): Promise<{
    readonly packagePath: string;
    readonly digestPath: string;
    readonly sha256: string;
  }>;
}

const repoRoot = process.cwd();

function loadWriter(): DigestWriter {
  return require(path.join(repoRoot, "scripts", "write-vsix-digest.js")) as DigestWriter;
}

describe("VSIX digest handoff", () => {
  test("verifies and records the one exact derived release artifact", async (t) => {
    const root = await fixture(t);
    const packagePath = path.join(root, "example-extension-1.2.3.vsix");
    const bytes = Buffer.from("verified-package", "utf8");
    await fs.writeFile(packagePath, bytes);
    let verified = "";

    const result = await loadWriter().writeVsixDigest({
      projectRoot: root,
      verify: async (candidate, projectRoot) => {
        assert.equal(projectRoot, root);
        verified = candidate;
        return ["extension/package.json"];
      },
    });

    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    assert.equal(verified, packagePath);
    assert.equal(result.packagePath, packagePath);
    assert.equal(result.sha256, expectedSha256);
    assert.equal(
      await fs.readFile(result.digestPath, "utf8"),
      `${expectedSha256}  example-extension-1.2.3.vsix\n`,
    );
  });

  test("rejects extra root VSIX files and removes a stale digest", async (t) => {
    const root = await fixture(t);
    await fs.writeFile(
      path.join(root, "example-extension-1.2.3.vsix"),
      "expected",
      "utf8",
    );
    await fs.writeFile(path.join(root, "old-release.vsix"), "old", "utf8");
    const digestPath = path.join(root, "SHA256SUMS.txt");
    await fs.writeFile(digestPath, "stale digest\n", "utf8");

    await assert.rejects(
      loadWriter().writeVsixDigest({
        projectRoot: root,
        verify: async () => [],
      }),
      /exactly one|extra|old-release\.vsix/u,
    );
    await assert.rejects(fs.access(digestPath), /ENOENT/u);
  });

  test("preserves digest generation and stale-output cleanup failures together", async () => {
    const primary = new Error("digest generation failed");
    const cleanup = new Error("stale digest cleanup denied");

    await assert.rejects(
      loadWriter().rethrowAfterDigestCleanup(
        primary,
        "SHA256SUMS.txt",
        async () => { throw cleanup; },
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [primary, cleanup]);
        return true;
      },
    );
  });

  test("preserves digest publish, handle-close, and temp-unlink failures together", async () => {
    const primary = new Error("digest publish failed");
    const close = new Error("digest temp handle close denied");
    const unlink = new Error("digest temp unlink denied");

    await assert.rejects(
      loadWriter().finishDigestPublishCleanup(
        primary,
        ".SHA256SUMS.tmp",
        { close: async () => { throw close; } },
        async () => { throw unlink; },
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [primary, close, unlink]);
        return true;
      },
    );
  });

  test("fails a nominally successful digest publish when temp cleanup fails", async () => {
    const cleanup = new Error("digest temp cleanup denied");
    await assert.rejects(
      loadWriter().finishDigestPublishCleanup(
        undefined,
        ".SHA256SUMS.tmp",
        undefined,
        async () => { throw cleanup; },
      ),
      cleanup,
    );
  });

  test("release workflow hashes and uploads no wildcard artifacts", async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(repoRoot, "package.json"), "utf8"),
    ) as {
      readonly name: string;
      readonly version: string;
      readonly scripts?: Record<string, string>;
    };
    const expected = `${manifest.name}-${manifest.version}.vsix`;
    const workflow = await fs.readFile(
      path.join(repoRoot, ".github", "workflows", "release-candidate.yml"),
      "utf8",
    );

    assert.equal(
      manifest.scripts?.["digest:vsix"],
      "node scripts/write-vsix-digest.js",
    );
    assert.match(workflow, /run: pnpm run digest:vsix/u);
    assert.ok(workflow.includes(expected));
    assert.doesNotMatch(workflow, /\*\.vsix/u);
  });
});

async function fixture(t: {
  after(callback: () => Promise<void>): void;
}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-vsix-digest-"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "example-extension",
      publisher: "example-publisher",
      version: "1.2.3",
      main: "./dist/src/extension.js",
      icon: "media/hydra-heads/guard.png",
    }),
    "utf8",
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
