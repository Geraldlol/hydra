import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

interface SbomWriter {
  finishPublishCleanup(
    primaryError: unknown,
    temporaryPath: string,
    handle?: { close(): Promise<void> },
    remove?: (filePath: string) => Promise<void>,
  ): Promise<void>;
  writeVsixSbom(options: {
    readonly projectRoot: string;
    readonly sourceDateEpoch?: string;
    readonly verify?: (packagePath: string, projectRoot: string) => Promise<readonly string[]>;
  }): Promise<{
    readonly packagePath: string;
    readonly sbomPath: string;
    readonly sha256: string;
  }>;
  rethrowAfterCleanup(
    primaryError: unknown,
    sbomPath: string,
    remove?: (filePath: string) => Promise<void>,
  ): Promise<never>;
}

interface SpdxDocument {
  readonly spdxVersion: string;
  readonly dataLicense: string;
  readonly SPDXID: string;
  readonly name: string;
  readonly documentNamespace: string;
  readonly creationInfo: {
    readonly created: string;
    readonly creators: readonly string[];
    readonly comment?: string;
  };
  readonly documentDescribes: readonly string[];
  readonly packages: ReadonlyArray<{
    readonly name: string;
    readonly SPDXID: string;
    readonly versionInfo: string;
    readonly downloadLocation: string;
    readonly filesAnalyzed: boolean;
    readonly licenseDeclared: string;
    readonly licenseConcluded: string;
    readonly copyrightText: string;
    readonly checksums: ReadonlyArray<{
      readonly algorithm: string;
      readonly checksumValue: string;
    }>;
  }>;
  readonly relationships: ReadonlyArray<{
    readonly spdxElementId: string;
    readonly relationshipType: string;
    readonly relatedSpdxElement: string;
  }>;
}

const repoRoot = process.cwd();
const TEST_SOURCE_DATE_EPOCH = "946684800";
const fakeVerifier = async (): Promise<readonly string[]> => [];

function loadWriter(): SbomWriter {
  return require(path.join(repoRoot, "scripts", "write-vsix-sbom.js")) as SbomWriter;
}

describe("VSIX SPDX handoff", () => {
  test("writes a deterministic SPDX 2.3 document bound to the verified release digest", async (t) => {
    const root = await fixture(t);
    const packagePath = path.join(root, "example-extension-1.2.3.vsix");
    const bytes = Buffer.from("verified-package", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await fs.writeFile(packagePath, bytes);
    await fs.writeFile(
      path.join(root, "SHA256SUMS.txt"),
      `${sha256}  example-extension-1.2.3.vsix\n`,
      "utf8",
    );

    const first = await writeFixtureSbom(root);
    const firstBytes = await fs.readFile(first.sbomPath);
    const second = await writeFixtureSbom(root);
    const secondBytes = await fs.readFile(second.sbomPath);
    const document = JSON.parse(firstBytes.toString("utf8")) as SpdxDocument;

    assert.equal(first.packagePath, packagePath);
    assert.equal(first.sha256, sha256);
    assert.equal(second.sbomPath, first.sbomPath);
    assert.deepEqual(secondBytes, firstBytes);
    assert.equal(document.spdxVersion, "SPDX-2.3");
    assert.equal(document.dataLicense, "CC0-1.0");
    assert.equal(document.SPDXID, "SPDXRef-DOCUMENT");
    assert.equal(document.name, "example-extension-1.2.3-vsix");
    assert.match(document.documentNamespace, new RegExp(`${sha256}-[a-f0-9]{64}$`, "u"));
    assert.equal(document.creationInfo.created, "2000-01-01T00:00:00Z");
    assert.deepEqual(document.creationInfo.creators, ["Tool: hydra-vsix-sbom-1.0.0"]);
    assert.match(document.creationInfo.comment ?? "", /SOURCE_DATE_EPOCH/i);
    assert.deepEqual(document.documentDescribes, ["SPDXRef-Package-Hydra"]);
    assert.equal(document.packages.length, 1, "devDependencies are not bundled components");
    assert.deepEqual(document.packages[0], {
      name: "example-extension",
      SPDXID: "SPDXRef-Package-Hydra",
      versionInfo: "1.2.3",
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseDeclared: "MIT",
      licenseConcluded: "NOASSERTION",
      copyrightText: "NOASSERTION",
      checksums: [{ algorithm: "SHA256", checksumValue: sha256 }],
    });
    assert.deepEqual(document.relationships, [{
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: "SPDXRef-Package-Hydra",
    }]);
  });

  test("rejects malformed or stale checksum handoffs and removes stale SBOM output", async (t) => {
    const root = await fixture(t);
    const packagePath = path.join(root, "example-extension-1.2.3.vsix");
    const sbomPath = path.join(root, "example-extension-1.2.3.spdx.json");
    await fs.writeFile(packagePath, "current-package", "utf8");

    for (const checksum of [
      "not-a-checksum\n",
      `${"0".repeat(64)}  example-extension-1.2.3.vsix\n`,
      `${createHash("sha256").update("current-package").digest("hex")}  wrong.vsix\n`,
    ]) {
      await fs.writeFile(path.join(root, "SHA256SUMS.txt"), checksum, "utf8");
      await fs.writeFile(sbomPath, "stale sbom", "utf8");
      await assert.rejects(
        writeFixtureSbom(root),
        /checksum|digest|SHA256SUMS|artifact name/i,
      );
      await assert.rejects(fs.access(sbomPath), /ENOENT/u);
    }
  });

  test("fails closed when runtime dependency metadata appears", async (t) => {
    const root = await fixture(t, { dependencies: { undici: "1.0.0" } });
    const packagePath = path.join(root, "example-extension-1.2.3.vsix");
    const bytes = Buffer.from("verified-package", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await fs.writeFile(packagePath, bytes);
    await fs.writeFile(
      path.join(root, "SHA256SUMS.txt"),
      `${sha256}  example-extension-1.2.3.vsix\n`,
      "utf8",
    );

    await assert.rejects(
      writeFixtureSbom(root),
      /runtime dependencies|component modeling|undici/i,
    );
  });

  test("reverifies the release archive instead of trusting a matching checksum alone", async (t) => {
    const root = await fixture(t);
    const packagePath = path.join(root, "example-extension-1.2.3.vsix");
    const bytes = Buffer.from("not-a-zip", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await fs.writeFile(packagePath, bytes);
    await fs.writeFile(
      path.join(root, "SHA256SUMS.txt"),
      `${sha256}  example-extension-1.2.3.vsix\n`,
      "utf8",
    );

    await assert.rejects(
      loadWriter().writeVsixSbom({ projectRoot: root, sourceDateEpoch: TEST_SOURCE_DATE_EPOCH }),
      /VSIX|ZIP|archive|signature/i,
    );
  });

  test("requires a declared reproducible source epoch and emits strict SPDX seconds", async (t) => {
    const root = await preparedFixture(t);
    const previous = process.env.SOURCE_DATE_EPOCH;
    try {
      delete process.env.SOURCE_DATE_EPOCH;
      await assert.rejects(
        loadWriter().writeVsixSbom({ projectRoot: root, verify: fakeVerifier }),
        /SOURCE_DATE_EPOCH.*required/i,
      );
    } finally {
      if (previous === undefined) delete process.env.SOURCE_DATE_EPOCH;
      else process.env.SOURCE_DATE_EPOCH = previous;
    }

    const result = await writeFixtureSbom(root, "946684801");
    const document = JSON.parse(await fs.readFile(result.sbomPath, "utf8")) as SpdxDocument;
    assert.equal(document.creationInfo.created, "2000-01-01T00:00:01Z");
    assert.doesNotMatch(document.creationInfo.created, /\.\d+Z$/u);
  });

  test("gives every semantically different SPDX document a distinct namespace", async (t) => {
    const root = await preparedFixture(t);
    const first = await writeFixtureSbom(root, "946684800");
    const firstDocument = JSON.parse(await fs.readFile(first.sbomPath, "utf8")) as SpdxDocument;
    const second = await writeFixtureSbom(root, "946684801");
    const secondDocument = JSON.parse(await fs.readFile(second.sbomPath, "utf8")) as SpdxDocument;
    assert.notEqual(secondDocument.documentNamespace, firstDocument.documentNamespace);

    const manifestPath = path.join(root, "package.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, license: "Apache-2.0" }, null, 2)}\n`,
      "utf8",
    );
    const third = await writeFixtureSbom(root, "946684801");
    const thirdDocument = JSON.parse(await fs.readFile(third.sbomPath, "utf8")) as SpdxDocument;
    assert.notEqual(thirdDocument.documentNamespace, secondDocument.documentNamespace);
  });

  test("maps an unrecognized license to NOASSERTION instead of emitting invalid SPDX", async (t) => {
    const root = await preparedFixture(t, { license: "NOT-A-REAL-LICENSE" });
    const result = await writeFixtureSbom(root);
    const document = JSON.parse(await fs.readFile(result.sbomPath, "utf8")) as SpdxDocument;
    assert.equal(document.packages[0]?.licenseDeclared, "NOASSERTION");
  });

  test("rejects hard-linked release artifacts", async (t) => {
    const root = await preparedFixture(t);
    await fs.link(
      path.join(root, "example-extension-1.2.3.vsix"),
      path.join(root, "release-alias.bin"),
    );
    await assert.rejects(writeFixtureSbom(root), /hard.?link|link count|regular file/i);
  });

  test("reports both the generation failure and a stale-output cleanup failure", async () => {
    const primary = new Error("primary generation failure");
    const cleanup = new Error("cleanup denied");
    await assert.rejects(
      loadWriter().rethrowAfterCleanup(
        primary,
        path.join(repoRoot, "never-created.spdx.json"),
        async () => { throw cleanup; },
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /cleanup/i);
        assert.deepEqual(error.errors, [primary, cleanup]);
        return true;
      },
    );
  });

  test("preserves publish, handle-close, and temporary-unlink failures together", async () => {
    const primary = new Error("primary publish failure");
    const close = new Error("temporary handle close denied");
    const unlink = new Error("temporary unlink denied");
    await assert.rejects(
      loadWriter().finishPublishCleanup(
        primary,
        path.join(repoRoot, ".never-created.spdx.json.tmp"),
        { close: async () => { throw close; } },
        async () => { throw unlink; },
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /publish.*cleanup/i);
        assert.deepEqual(error.errors, [primary, close, unlink]);
        return true;
      },
    );
  });

  test("keeps successful temporary cleanup non-failing", async () => {
    let closed = false;
    let removed = false;
    await loadWriter().finishPublishCleanup(
      undefined,
      path.join(repoRoot, ".never-created.spdx.json.tmp"),
      { close: async () => { closed = true; } },
      async () => { removed = true; },
    );
    assert.equal(closed, true);
    assert.equal(removed, true);
  });
});

async function writeFixtureSbom(
  projectRoot: string,
  sourceDateEpoch = TEST_SOURCE_DATE_EPOCH,
): ReturnType<SbomWriter["writeVsixSbom"]> {
  return loadWriter().writeVsixSbom({
    projectRoot,
    sourceDateEpoch,
    verify: fakeVerifier,
  });
}

async function preparedFixture(
  t: { after(callback: () => Promise<void>): void },
  extra: Record<string, unknown> = {},
): Promise<string> {
  const root = await fixture(t, extra);
  const packagePath = path.join(root, "example-extension-1.2.3.vsix");
  const bytes = Buffer.from("verified-package", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(packagePath, bytes);
  await fs.writeFile(
    path.join(root, "SHA256SUMS.txt"),
    `${sha256}  example-extension-1.2.3.vsix\n`,
    "utf8",
  );
  return root;
}

async function fixture(
  t: { after(callback: () => Promise<void>): void },
  extra: Record<string, unknown> = {},
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-vsix-sbom-"));
  await fs.writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({
      name: "example-extension",
      publisher: "example-publisher",
      version: "1.2.3",
      license: "MIT",
      engines: { vscode: "^1.120.0" },
      devDependencies: { typescript: "6.0.2" },
      ...extra,
    }, null, 2)}\n`,
    "utf8",
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
