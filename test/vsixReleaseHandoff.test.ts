import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

interface SbomWriter {
  writeVsixSbom(options: {
    readonly projectRoot: string;
    readonly sourceDateEpoch: string;
    readonly verify: () => Promise<readonly string[]>;
  }): Promise<{
    readonly packagePath: string;
    readonly sbomPath: string;
    readonly sha256: string;
  }>;
}

interface ReleaseHandoffVerifier {
  verifyVsixReleaseHandoff(options: {
    readonly projectRoot: string;
    readonly handoffDirectory: string;
    readonly sourceDateEpoch: string;
    readonly verify?: (
      packagePath: string,
      projectRoot: string,
    ) => Promise<readonly string[]>;
  }): Promise<{
    readonly packagePath: string;
    readonly checksumPath: string;
    readonly sbomPath: string;
    readonly sha256: string;
  }>;
}

interface Fixture {
  readonly root: string;
  readonly handoffDirectory: string;
  readonly referencePackagePath: string;
  readonly packagePath: string;
  readonly checksumPath: string;
  readonly sbomPath: string;
  readonly sha256: string;
}

const repoRoot = process.cwd();
const TEST_SOURCE_DATE_EPOCH = "946684800";

function loadSbomWriter(): SbomWriter {
  return require(path.join(repoRoot, "scripts", "write-vsix-sbom.js")) as SbomWriter;
}

function loadHandoffVerifier(): ReleaseHandoffVerifier {
  return require(
    path.join(repoRoot, "scripts", "verify-vsix-release-handoff.js"),
  ) as ReleaseHandoffVerifier;
}

describe("validated VSIX release handoff", () => {
  test("reverifies the exact canonical handoff against freshly compiled source", async (t) => {
    const prepared = await fixture(t);
    let verifiedPackage = "";
    let verifiedRoot = "";

    const result = await loadHandoffVerifier().verifyVsixReleaseHandoff({
      projectRoot: prepared.root,
      handoffDirectory: prepared.handoffDirectory,
      sourceDateEpoch: TEST_SOURCE_DATE_EPOCH,
      verify: async (packagePath, projectRoot) => {
        verifiedPackage = packagePath;
        verifiedRoot = projectRoot;
        return ["extension/package.json"];
      },
    });

    assert.equal(verifiedPackage, prepared.packagePath);
    assert.equal(verifiedRoot, prepared.root);
    assert.equal(result.packagePath, prepared.packagePath);
    assert.equal(result.checksumPath, prepared.checksumPath);
    assert.equal(result.sbomPath, prepared.sbomPath);
    assert.equal(result.sha256, prepared.sha256);
  });

  test("requires one newline-terminated checksum for the exact VSIX subject", async (t) => {
    const prepared = await fixture(t);
    const canonical = await fs.readFile(prepared.checksumPath, "utf8");
    const emptySha256 = createHash("sha256").update("").digest("hex");
    const malformed = [
      canonical.trimEnd(),
      `${emptySha256}  /dev/null\n`,
      `${canonical}${prepared.sha256}  example-extension-1.2.3.vsix\n`,
    ];

    for (const checksum of malformed) {
      await fs.writeFile(prepared.checksumPath, checksum, "utf8");
      await assert.rejects(
        verifyFixture(prepared),
        /SHA256SUMS|checksum|exact release VSIX/i,
      );
    }
  });

  test("rejects a VSIX changed by or after archive verification", async (t) => {
    const prepared = await fixture(t);

    await assert.rejects(
      verifyFixture(prepared, async (packagePath) => {
        await fs.writeFile(packagePath, "changed-after-verification", "utf8");
        return [];
      }),
      /changed|digest|verification/i,
    );
  });

  test("rejects a candidate that differs from the independently rebuilt VSIX", async (t) => {
    const prepared = await fixture(t);
    await fs.writeFile(
      prepared.referencePackagePath,
      "independently-built-different-package",
      "utf8",
    );

    await assert.rejects(
      verifyFixture(prepared),
      /independent|rebuilt|reference|source|differ/i,
    );
  });

  test("rejects an incomplete SPDX object that only matches the digest", async (t) => {
    const prepared = await fixture(t);
    await fs.writeFile(
      prepared.sbomPath,
      `${JSON.stringify({
        spdxVersion: "SPDX-2.3",
        dataLicense: "CC0-1.0",
        SPDXID: "SPDXRef-DOCUMENT",
        documentDescribes: ["SPDXRef-Package-Hydra"],
        packages: [{
          SPDXID: "SPDXRef-Package-Hydra",
          checksums: [{ algorithm: "SHA256", checksumValue: prepared.sha256 }],
        }],
      }, null, 2)}\n`,
      "utf8",
    );

    await assert.rejects(verifyFixture(prepared), /canonical|SPDX/i);
  });

  test("rejects timestamp, license, and namespace-fingerprint drift", async (t) => {
    const prepared = await fixture(t);
    const canonical = await fs.readFile(prepared.sbomPath, "utf8");
    const mutations: Array<(document: Record<string, any>) => void> = [
      (document) => { document.creationInfo.created = "2000-01-01T00:00:01Z"; },
      (document) => { document.packages[0].licenseDeclared = "Apache-2.0"; },
      (document) => { document.documentNamespace = `${document.documentNamespace}-forged`; },
    ];

    for (const mutate of mutations) {
      const document = JSON.parse(canonical) as Record<string, any>;
      mutate(document);
      await fs.writeFile(
        prepared.sbomPath,
        `${JSON.stringify(document, null, 2)}\n`,
        "utf8",
      );
      await assert.rejects(verifyFixture(prepared), /canonical|SPDX/i);
    }
  });

  test("rejects hard-linked handoff files and unexpected root entries", async (t) => {
    const prepared = await fixture(t);
    await fs.link(prepared.packagePath, path.join(prepared.root, "release-alias.bin"));
    await assert.rejects(verifyFixture(prepared), /hard.?link|link count|regular file/i);

    await fs.unlink(path.join(prepared.root, "release-alias.bin"));
    await fs.writeFile(path.join(prepared.handoffDirectory, "unexpected.txt"), "extra", "utf8");
    await assert.rejects(verifyFixture(prepared), /exactly|unexpected|handoff/i);
  });
});

async function verifyFixture(
  prepared: Fixture,
  verify: (
    packagePath: string,
    projectRoot: string,
  ) => Promise<readonly string[]> = async () => [],
): ReturnType<ReleaseHandoffVerifier["verifyVsixReleaseHandoff"]> {
  return loadHandoffVerifier().verifyVsixReleaseHandoff({
    projectRoot: prepared.root,
    handoffDirectory: prepared.handoffDirectory,
    sourceDateEpoch: TEST_SOURCE_DATE_EPOCH,
    verify,
  });
}

async function fixture(t: {
  after(callback: () => Promise<void>): void;
}): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-release-handoff-"));
  const handoffDirectory = path.join(root, "release-handoff");
  const packageName = "example-extension-1.2.3.vsix";
  const sbomName = "example-extension-1.2.3.spdx.json";
  const packagePath = path.join(root, packageName);
  const checksumPath = path.join(root, "SHA256SUMS.txt");
  const bytes = Buffer.from("verified-package", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  await fs.writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({
      name: "example-extension",
      publisher: "example-publisher",
      version: "1.2.3",
      license: "MIT",
      main: "./dist/src/extension.js",
      icon: "media/hydra-heads/guard.png",
      devDependencies: { typescript: "6.0.2" },
    }, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(packagePath, bytes);
  await fs.writeFile(checksumPath, `${sha256}  ${packageName}\n`, "utf8");
  const generated = await loadSbomWriter().writeVsixSbom({
    projectRoot: root,
    sourceDateEpoch: TEST_SOURCE_DATE_EPOCH,
    verify: async () => [],
  });

  await fs.mkdir(handoffDirectory);
  const movedPackagePath = path.join(handoffDirectory, packageName);
  const movedChecksumPath = path.join(handoffDirectory, "SHA256SUMS.txt");
  const movedSbomPath = path.join(handoffDirectory, sbomName);
  await fs.copyFile(packagePath, movedPackagePath);
  await fs.rename(checksumPath, movedChecksumPath);
  await fs.rename(generated.sbomPath, movedSbomPath);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  return {
    root,
    handoffDirectory,
    referencePackagePath: packagePath,
    packagePath: movedPackagePath,
    checksumPath: movedChecksumPath,
    sbomPath: movedSbomPath,
    sha256,
  };
}
