import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, test } from "node:test";

interface PackageContentsGate {
  findDeniedVsixEntries(entries: readonly string[]): string[];
  readVsixEntryNames(vsixPath: string): Promise<string[]>;
  verifyVsixContents(vsixPath: string, projectRoot?: string): Promise<readonly string[]>;
}

interface ZipEntry {
  readonly name: string;
  readonly data?: Buffer | string;
  readonly method?: 0 | 8;
  readonly flags?: number;
  readonly versionMadeBy?: number;
  readonly externalAttributes?: number;
  readonly localName?: string;
  readonly declaredCompressedSize?: number;
  readonly declaredUncompressedSize?: number;
  readonly declaredCrc32?: number;
}

interface PackageIdentity {
  readonly name: string;
  readonly publisher: string;
  readonly version: string;
  readonly main: string;
  readonly icon: string;
}

const repoRoot = process.cwd();
const SOURCE_BACKED_EXACT_FILES = [
  ["extension/LICENSE.txt", "LICENSE"],
  ["extension/SUPPORT.md", "SUPPORT.md"],
  ["extension/media/webview.js", "media/webview.js"],
] as const;
const VSCE_NORMALIZED_MARKDOWN_FILES = [
  ["extension/readme.md", "README.md"],
  ["extension/changelog.md", "CHANGELOG.md"],
] as const;
const SOURCE_BACKED_MEDIA_DIRECTORIES = [
  ["extension/media/hydra-heads", "media/hydra-heads"],
  ["extension/media/screenshots", "media/screenshots"],
] as const;

function loadGate(): PackageContentsGate {
  // The release script is intentionally plain JavaScript so it can run before
  // the TypeScript build. Loading it from the repository root also exercises
  // exactly the file used by packaging rather than a compiled test copy.
  return require(path.join(repoRoot, "scripts", "verify-vsix-contents.js")) as PackageContentsGate;
}

describe("VSIX packaged-content safety gate", () => {
  test("packages with stable SOURCE_DATE_EPOCH metadata", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "scripts", "package-vsix.js"),
      "utf8",
    );
    assert.match(source, /DEFAULT_SOURCE_DATE_EPOCH/);
    assert.match(source, /process\.env\.SOURCE_DATE_EPOCH\s*=/);
    assert.match(source, /ensureReproducibleEpoch\(\)/);
  });

  test("pins VS Code API types to the declared minimum engine", async () => {
    const manifest = await packageManifest() as {
      readonly engines?: { readonly vscode?: unknown };
      readonly devDependencies?: { readonly "@types/vscode"?: unknown };
    };
    const engine = manifest.engines?.vscode;
    const apiTypes = manifest.devDependencies?.["@types/vscode"];

    assert.ok(typeof engine === "string");
    assert.match(engine, /^\^\d+\.\d+\.\d+$/u);
    assert.equal(apiTypes, engine.slice(1));
  });

  test("explicitly denies agent state, MCP configuration, env files, and credentials", () => {
    const { findDeniedVsixEntries } = loadGate();
    const denied = findDeniedVsixEntries([
      "extension/.sf/orgs/example/metadata-catalog/catalog.json",
      "extension/.sfdx/orgs/example/auth.json",
      "extension/packages/force-app/.sfdx/orgs/example/auth.json",
      "extension/packages/force-app/.SfDx/orgs/example/auth.json",
      "extension/.codex/auth.json",
      "extension/.gemini/settings.json",
      "extension/.mcp.json",
      "extension/config/mcp-servers.json",
      "extension/config/.env.production",
      "extension/certs/release-signing.pfx",
      "extension/id_ed25519",
      "extension/dist/src/extension.js",
      "extension/package.json",
      "extension.vsixmanifest",
    ]);

    assert.deepEqual(denied, [
      "extension/.sf/orgs/example/metadata-catalog/catalog.json",
      "extension/.sfdx/orgs/example/auth.json",
      "extension/packages/force-app/.sfdx/orgs/example/auth.json",
      "extension/packages/force-app/.SfDx/orgs/example/auth.json",
      "extension/.codex/auth.json",
      "extension/.gemini/settings.json",
      "extension/.mcp.json",
      "extension/config/mcp-servers.json",
      "extension/config/.env.production",
      "extension/certs/release-signing.pfx",
      "extension/id_ed25519",
    ]);
  });

  test("accepts only the release shape and validates every stored payload", async () => {
    const { readVsixEntryNames, verifyVsixContents } = loadGate();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-safe-vsix-"));
    const vsixPath = path.join(root, "safe.vsix");
    const entries = await safePackageEntries();

    try {
      await fs.writeFile(vsixPath, storedZip(entries));
      assert.deepEqual(await readVsixEntryNames(vsixPath), entries.map((entry) => entry.name));
      assert.deepEqual(await verifyVsixContents(vsixPath), entries.map((entry) => entry.name));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed for malformed archives, missing assets, and non-allowlisted files", async () => {
    const { verifyVsixContents } = loadGate();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-blocked-vsix-"));

    try {
      const malformed = path.join(root, "malformed.vsix");
      await fs.writeFile(malformed, Buffer.from("not a zip", "utf8"));
      await assert.rejects(verifyVsixContents(malformed), /invalid|central directory|VSIX/i);

      const base = await safePackageEntries();
      const missingMain = path.join(root, "missing-main.vsix");
      await fs.writeFile(missingMain, storedZip(base.filter((entry) => entry.name !== "extension/dist/src/extension.js")));
      await assert.rejects(verifyVsixContents(missingMain), /declared main|extension\.js/i);

      const missingWebview = path.join(root, "missing-webview.vsix");
      await fs.writeFile(missingWebview, storedZip(base.filter((entry) => entry.name !== "extension/media/webview.js")));
      await assert.rejects(verifyVsixContents(missingWebview), /critical|required|webview\.js/i);

      const unexpected = path.join(root, "unexpected.vsix");
      await fs.writeFile(unexpected, storedZip([...base, { name: "extension/random.txt", data: "surprise" }]));
      await assert.rejects(verifyVsixContents(unexpected), /allowlist|unexpected|random\.txt/i);

      for (const privateName of [
        "extension/.sfdx/orgs/root/auth.json",
        "extension/packages/force-app/.sfdx/orgs/nested/auth.json",
        "extension/packages/force-app/.SfDx/orgs/mixed-case/auth.json",
        "extension/.codex/config.toml",
        "extension/.gemini/settings.json",
        "extension/.mcp.json",
        "extension/config/settings.json",
      ]) {
        const privateArchive = path.join(root, `${path.basename(privateName)}-${privateName.length}.vsix`);
        await fs.writeFile(privateArchive, storedZip([...base, { name: privateName, data: "{}" }]));
        await assert.rejects(verifyVsixContents(privateArchive), /denied|private|allowlist|unexpected/i);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects empty, invalid, and stale embedded manifests", async () => {
    const { verifyVsixContents } = loadGate();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-stale-vsix-"));
    const base = await safePackageEntries();
    const embedded = await packageIdentity();

    try {
      for (const [label, packageJson, expected] of [
        ["empty", "", /empty|package\.json/i],
        ["invalid", "{", /JSON|package\.json/i],
        ["name", JSON.stringify({ ...embedded, name: `${embedded.name}-stale` }), /name|stale|mismatch/i],
        ["publisher", JSON.stringify({ ...embedded, publisher: "someone-else" }), /publisher|stale|mismatch/i],
        ["version", JSON.stringify({ ...embedded, version: "99.0.0" }), /version|stale|mismatch/i],
        ["main", JSON.stringify({ ...embedded, main: "./dist/src/old-extension.js" }), /main|stale|mismatch/i],
        ["icon", JSON.stringify({ ...embedded, icon: "media/hydra-heads/old-guard.png" }), /icon|stale|mismatch/i],
      ] as const) {
        const vsixPath = path.join(root, `${label}.vsix`);
        await fs.writeFile(vsixPath, storedZip(replaceEntry(base, "extension/package.json", packageJson)));
        await assert.rejects(verifyVsixContents(vsixPath), expected);
      }

      const staleVsixManifest = path.join(root, "stale-vsix-manifest.vsix");
      await fs.writeFile(staleVsixManifest, storedZip(replaceEntry(
        base,
        "extension.vsixmanifest",
        vsixManifestXml({ ...embedded, version: "98.0.0" }),
      )));
      await assert.rejects(verifyVsixContents(staleVsixManifest), /VSIX manifest|version|stale|mismatch/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects missing, stale, and extra packaged runtime files", async () => {
    const { verifyVsixContents } = loadGate();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-runtime-vsix-"));
    const base = await safePackageEntries();
    const importedRuntime = "extension/dist/src/browserBroker.js";

    try {
      assert.ok(base.some((entry) => entry.name === importedRuntime), "fixture includes a directly imported runtime");
      const extensionRuntime = base.find((entry) => entry.name === "extension/dist/src/extension.js");
      assert.ok(Buffer.isBuffer(extensionRuntime?.data), "fixture includes the compiled extension entrypoint");
      assert.match(extensionRuntime.data.toString("utf8"), /require\("\.\/browserBroker"\)/);

      const missingRuntime = path.join(root, "missing-runtime.vsix");
      await fs.writeFile(missingRuntime, storedZip(base.filter((entry) => entry.name !== importedRuntime)));
      await assert.rejects(
        verifyVsixContents(missingRuntime),
        /runtime inventory|missing|browserBroker\.js/i,
      );

      const staleRuntime = path.join(root, "stale-runtime.vsix");
      await fs.writeFile(staleRuntime, storedZip(replaceEntry(base, importedRuntime, "module.exports = 'stale';")));
      await assert.rejects(
        verifyVsixContents(staleRuntime),
        /runtime|stale|bytes|browserBroker\.js/i,
      );

      const extraRuntime = path.join(root, "extra-runtime.vsix");
      await fs.writeFile(extraRuntime, storedZip([
        ...base,
        { name: "extension/dist/src/stale-runtime.js", data: "module.exports = {};" },
      ]));
      await assert.rejects(
        verifyVsixContents(extraRuntime),
        /runtime inventory|extra|stale-runtime\.js/i,
      );

      const sourceMap = path.join(root, "source-map.vsix");
      await fs.writeFile(sourceMap, storedZip([
        ...base,
        { name: `${importedRuntime}.map`, data: "{}" },
      ]));
      await assert.rejects(
        verifyVsixContents(sourceMap),
        /allowlist|source map|browserBroker\.js\.map/i,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects packaged webview code that diverges from the checked-out source", async () => {
    const { verifyVsixContents } = loadGate();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-stale-webview-vsix-"));

    try {
      const entries = await safePackageEntries();
      const staleWebview = path.join(root, "stale-webview.vsix");
      await fs.writeFile(staleWebview, storedZip(replaceEntry(
        entries,
        "extension/media/webview.js",
        "acquireVsCodeApi().postMessage({ type: 'forged-release-payload' });",
      )));

      await assert.rejects(
        verifyVsixContents(staleWebview),
        /webview\.js|source|stale|bytes/i,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects stale or incomplete source-backed documents and images", async () => {
    const { verifyVsixContents } = loadGate();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-stale-static-vsix-"));

    try {
      const entries = await safePackageEntries();
      const mutations: ReadonlyArray<readonly [string, Buffer | string]> = [
        ["extension/LICENSE.txt", "forged-license\n"],
        ["extension/media/hydra-heads/guard.png", "forged-image"],
      ];
      for (const [name, data] of mutations) {
        const vsixPath = path.join(root, `${path.basename(name)}-stale.vsix`);
        await fs.writeFile(vsixPath, storedZip(replaceEntry(entries, name, data)));
        await assert.rejects(
          verifyVsixContents(vsixPath),
          /static|source|stale|bytes/i,
        );
      }

      const incomplete = path.join(root, "missing-support.vsix");
      await fs.writeFile(
        incomplete,
        storedZip(entries.filter((entry) => entry.name !== "extension/SUPPORT.md")),
      );
      await assert.rejects(
        verifyVsixContents(incomplete),
        /static|source|inventory|missing|SUPPORT/i,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects stale same-version contribution metadata", async () => {
    const { verifyVsixContents } = loadGate();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-contributions-vsix-"));
    const base = await safePackageEntries();
    const manifest = await packageManifest();
    const contributes = manifest.contributes as { commands?: Array<Record<string, unknown>> } | undefined;
    assert.ok(contributes?.commands?.length, "release manifest declares commands");
    const commands = contributes.commands.map((command, index) => index === 0
      ? { ...command, title: "Hydra: Stale Same-Version Command" }
      : command);
    const staleManifest = {
      ...manifest,
      contributes: { ...contributes, commands },
    };
    const vsixPath = path.join(root, "stale-contributions.vsix");

    try {
      await fs.writeFile(vsixPath, storedZip(replaceEntry(
        base,
        "extension/package.json",
        JSON.stringify(staleManifest),
      )));
      await assert.rejects(
        verifyVsixContents(vsixPath),
        /package\.json|manifest|stale|mismatch/i,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects oversized archives, entry bombs, and corrupt payload metadata before extraction", async () => {
    const { readVsixEntryNames } = loadGate();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-bomb-vsix-"));

    try {
      const tooMany = path.join(root, "too-many.vsix");
      await fs.writeFile(tooMany, storedZip(Array.from(
        { length: 2_049 },
        (_, index) => ({ name: `extension/dist/src/module-${index}.js`, data: "" }),
      )));
      await assert.rejects(readVsixEntryNames(tooMany), /entry count|too many|2048/i);

      const oversized = path.join(root, "oversized-entry.vsix");
      await fs.writeFile(oversized, storedZip([{
        name: "extension/dist/src/extension.js",
        data: "x",
        declaredUncompressedSize: 17 * 1024 * 1024,
      }]));
      await assert.rejects(readVsixEntryNames(oversized), /uncompressed|entry size|limit/i);

      const ratioBomb = path.join(root, "ratio-bomb.vsix");
      await fs.writeFile(ratioBomb, storedZip([{
        name: "extension/dist/src/extension.js",
        data: "x",
        method: 8,
        declaredUncompressedSize: 1024 * 1024,
      }]));
      await assert.rejects(readVsixEntryNames(ratioBomb), /compression ratio|ratio/i);

      const totalBomb = path.join(root, "total-bomb.vsix");
      await fs.writeFile(totalBomb, storedZip(Array.from(
        { length: 5 },
        (_, index) => ({
          name: `extension/dist/src/large-${index}.js`,
          data: "x",
          method: 8,
          declaredCompressedSize: 100 * 1024,
          declaredUncompressedSize: 16 * 1024 * 1024,
        }),
      )));
      await assert.rejects(readVsixEntryNames(totalBomb), /total uncompressed|total.*limit/i);

      const corruptCrc = path.join(root, "corrupt-crc.vsix");
      await fs.writeFile(corruptCrc, storedZip([{
        name: "extension/dist/src/extension.js",
        data: "payload",
        declaredCrc32: 0,
      }]));
      await assert.rejects(readVsixEntryNames(corruptCrc), /CRC|integrity/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects links, duplicate or case-colliding names, and Windows-unsafe paths", async () => {
    const { readVsixEntryNames } = loadGate();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-path-vsix-"));

    try {
      const cases: ReadonlyArray<readonly [string, readonly ZipEntry[], RegExp]> = [
        ["symlink", [{
          name: "extension/dist/src/extension.js",
          data: "target",
          versionMadeBy: (3 << 8) | 20,
          externalAttributes: (0o120777 << 16) >>> 0,
        }], /link|regular file|external attribute/i],
        ["privileged-mode", [{
          name: "extension/dist/src/extension.js",
          data: "payload",
          versionMadeBy: (3 << 8) | 20,
          externalAttributes: (0o104755 << 16) >>> 0,
        }], /privileged|external attribute/i],
        ["duplicate", [
          { name: "extension/dist/src/a.js", data: "a" },
          { name: "extension/dist/src/a.js", data: "b" },
        ], /duplicate|collision/i],
        ["case-collision", [
          { name: "extension/dist/src/A.js", data: "a" },
          { name: "extension/dist/src/a.js", data: "b" },
        ], /duplicate|collision/i],
        ["reserved", [{ name: "extension/media/CON.png", data: "x" }], /Windows|unsafe|reserved|path/i],
        ["trailing-dot", [{ name: "extension/media/icon./guard.png", data: "x" }], /Windows|unsafe|path/i],
        ["alternate-stream", [{ name: "extension/media/icon.png:secret", data: "x" }], /Windows|unsafe|path/i],
        ["traversal", [{ name: "extension/../.env", data: "x" }], /invalid|unsafe|path/i],
        ["backslash", [{ name: "extension\\.codex\\auth.json", data: "x" }], /invalid|unsafe|path/i],
        ["local-name-mismatch", [{
          name: "extension/dist/src/extension.js",
          localName: "extension/dist/src/not-extension.js",
          data: "x",
        }], /local and central|local metadata/i],
      ];

      for (const [label, entries, expected] of cases) {
        const vsixPath = path.join(root, `${label}.vsix`);
        await fs.writeFile(vsixPath, storedZip(entries));
        await assert.rejects(readVsixEntryNames(vsixPath), expected, label);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("release scripts package reproducibly and then invoke the fail-closed archive gate", async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const reproducibilityGate = await fs.readFile(
      path.join(repoRoot, "scripts", "verify-vsix-reproducibility.js"),
      "utf8",
    );

    assert.match(manifest.scripts?.package ?? "", /scripts\/verify-vsix-reproducibility\.js/);
    assert.match(manifest.scripts?.["package:pre-release"] ?? "", /scripts\/verify-vsix-reproducibility\.js --pre-release/);
    assert.match(manifest.scripts?.["verify:vsix"] ?? "", /scripts\/verify-vsix-contents\.js/);
    assert.match(reproducibilityGate, /package-vsix\.js/);
    assert.match(reproducibilityGate, /verifyVsixContents/);
  });

  test("the packaging ignore file excludes all recognized local agent and secret state", async () => {
    const ignore = await fs.readFile(path.join(repoRoot, ".vscodeignore"), "utf8");

    for (const pattern of [
      ".sf/**",
      ".sfdx/**",
      "**/.sfdx/**",
      "**/.[sS][fF][dD][xX]/**",
      ".agents/**",
      ".codex/**",
      ".gemini/**",
      ".mcp.json",
      "mcp*.json",
      "config/**",
      "tasks/**",
      "SHA256SUMS.txt",
      "*.spdx.json",
      ".env*",
      "*.pfx",
      "*.pem",
      "*.key",
    ]) {
      assert.match(ignore, new RegExp(`^${escapeRegExp(pattern)}$`, "m"), `${pattern} must be excluded`);
    }
  });
});

async function packageIdentity(): Promise<PackageIdentity> {
  const value = await packageManifest() as Partial<PackageIdentity>;
  for (const field of ["name", "publisher", "version", "main", "icon"] as const) {
    assert.equal(typeof value[field], "string", `root package.json ${field}`);
    assert.notEqual(value[field], "", `root package.json ${field}`);
  }
  return value as PackageIdentity;
}

async function packageManifest(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8")) as Record<string, unknown>;
}

async function safePackageEntries(): Promise<ZipEntry[]> {
  const identity = await packageIdentity();
  const packageJson = await fs.readFile(path.join(repoRoot, "package.json"));
  const runtimeNames = (await fs.readdir(path.join(repoRoot, "dist", "src"), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const runtimeEntries = await Promise.all(runtimeNames.map(async (name): Promise<ZipEntry> => ({
    name: `extension/dist/src/${name}`,
    data: await fs.readFile(path.join(repoRoot, "dist", "src", name)),
  })));
  const staticEntries = await sourceBackedStaticEntries();
  return [
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "extension.vsixmanifest", data: vsixManifestXml(identity) },
    { name: "extension/package.json", data: packageJson },
    ...runtimeEntries,
    ...staticEntries,
  ];
}

async function sourceBackedStaticEntries(): Promise<ZipEntry[]> {
  const entries = await Promise.all([
    ...SOURCE_BACKED_EXACT_FILES,
    ...VSCE_NORMALIZED_MARKDOWN_FILES,
  ].map(
    async ([name, relativePath]): Promise<ZipEntry> => ({
      name,
      data: await fs.readFile(path.join(repoRoot, relativePath)),
    }),
  ));
  for (const [archivePrefix, relativeDirectory] of SOURCE_BACKED_MEDIA_DIRECTORIES) {
    const names = (await fs.readdir(path.join(repoRoot, relativeDirectory), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      entries.push({
        name: `${archivePrefix}/${name}`,
        data: await fs.readFile(path.join(repoRoot, relativeDirectory, name)),
      });
    }
  }
  return entries;
}

function vsixManifestXml(identity: PackageIdentity): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<PackageManifest Version="2.0.0">',
    "<Metadata>",
    `<Identity Id="${identity.name}" Version="${identity.version}" Publisher="${identity.publisher}" />`,
    "</Metadata>",
    "</PackageManifest>",
  ].join("");
}

function replaceEntry(entries: readonly ZipEntry[], name: string, data: Buffer | string): ZipEntry[] {
  return entries.map((entry) => entry.name === name ? { ...entry, data } : entry);
}

function storedZip(entries: readonly ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const localName = Buffer.from(entry.localName ?? entry.name, "utf8");
    const source = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : (entry.data ?? Buffer.alloc(0));
    const method = entry.method ?? 0;
    const payload = method === 8 ? deflateRawSync(source) : source;
    const flags = entry.flags ?? 0x0800;
    const crc = entry.declaredCrc32 ?? crc32(source);
    const compressedSize = entry.declaredCompressedSize ?? payload.byteLength;
    const uncompressedSize = entry.declaredUncompressedSize ?? source.byteLength;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(localName.length, 26);
    localParts.push(local, localName, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.versionMadeBy ?? ((3 << 8) | 20), 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.externalAttributes ?? ((0o100644 << 16) >>> 0), 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + localName.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

const CRC32_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
