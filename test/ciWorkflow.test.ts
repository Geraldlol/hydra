import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

describe("CI workflow contracts", () => {
  test("publishes one stable required gate that fails closed over every CI dependency", () => {
    const workflow = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
    const requiredStart = workflow.indexOf("  required-ci:");
    const packageStart = workflow.indexOf("  package:");

    assert.match(workflow, /^  merge_group:\s*\n\s+types: \[checks_requested\]/m);
    assert.ok(requiredStart >= 0 && packageStart > requiredStart);
    const required = workflow.slice(requiredStart, packageStart);
    assert.match(required, /^\s+name: Required CI$/m);
    assert.match(required, /^\s+permissions: \{\}$/m);
    assert.match(required, /^\s+if: \$\{\{ always\(\) \}\}$/m);
    assert.match(required, /^\s+needs: \[build, extension-host, audit, coverage\]$/m);
    assert.match(required, /BUILD_RESULT: \$\{\{ needs\.build\.result \}\}/);
    assert.match(required, /EXTENSION_HOST_RESULT: \$\{\{ needs\['extension-host'\]\.result \}\}/);
    assert.match(required, /AUDIT_RESULT: \$\{\{ needs\.audit\.result \}\}/);
    assert.match(required, /COVERAGE_RESULT: \$\{\{ needs\.coverage\.result \}\}/);
    assert.match(required, /for result in .*BUILD_RESULT.*EXTENSION_HOST_RESULT.*AUDIT_RESULT.*COVERAGE_RESULT/s);
    assert.match(required, /if \[ "\$result" != "success" \]/);
  });

  test("runs supported Node lines on every desktop OS and retains extension-host coverage", () => {
    const workflow = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
    const buildStart = workflow.indexOf("  build:");
    const extensionHostStart = workflow.indexOf("  extension-host:");
    assert.ok(buildStart >= 0 && extensionHostStart > buildStart);
    const build = workflow.slice(buildStart, extensionHostStart);
    const extensionHost = workflow.slice(extensionHostStart);

    assert.match(build, /os:\s*\[ubuntu-latest, windows-latest, macos-latest\]/);
    assert.match(build, /node:\s*\[22\.22\.1, ['"]24\.x['"]\]/);
    assert.match(build, /node-version:\s*\$\{\{ matrix\.node \}\}/);
    assert.match(extensionHost, /os:\s*\[ubuntu-latest, windows-latest, macos-latest\]/);
    assert.match(extensionHost, /xvfb-run -a pnpm run test:integration/);
    assert.match(extensionHost, /if: runner\.os != 'Linux'[\s\S]*pnpm run test:integration/);
  });

  test("pins released actions immutably and narrows engines to tested Node lines", () => {
    const workflow = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
    const release = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "release-candidate.yml"), "utf8");
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      engines?: { node?: string };
    };
    const combined = `${workflow}\n${release}`;

    assert.match(workflow, /actions\/checkout@[a-f0-9]{40} # v7\.0\.1/);
    assert.match(workflow, /actions\/setup-node@[a-f0-9]{40} # v7\.0\.0/);
    assert.match(
      workflow,
      /pnpm\/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6/,
    );
    assert.match(
      release,
      /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/,
    );
    assert.equal((workflow.match(/pnpm\/action-setup@/g) ?? []).length, 5);
    assert.equal((release.match(/pnpm\/action-setup@/g) ?? []).length, 6);
    assert.doesNotMatch(combined, /pnpm\/setup@|install: false/);
    assert.doesNotMatch(combined, /uses:\s+[^\s]+@v\d+/);

    const actionRefs = [...combined.matchAll(/uses:\s+[^\s]+@([^\s#]+)/g)]
      .map((match) => match[1]);
    assert.ok(actionRefs.length > 0);
    assert.equal(actionRefs.every((ref) => /^[a-f0-9]{40}$/.test(ref ?? "")), true);

    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /node-version: 22\.22\.1/);
    assert.equal(manifest.engines?.node, "^22.13.0 || ^24.0.0");
  });

  test("keeps audit independent and makes the release candidate run every release gate", () => {
    const workflow = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
    const release = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "release-candidate.yml"), "utf8");

    assert.match(workflow, /^  audit:\s*$/m);
    assert.match(release, /pnpm audit --audit-level=high/);
    assert.match(release, /os:\s*\[ubuntu-latest, windows-latest, macos-latest\]/);
    assert.match(release, /node:\s*\[22\.22\.1, ['"]24\.x['"]\]/);
    assert.match(release, /xvfb-run -a pnpm run test:integration/);
    assert.match(release, /if: runner\.os != 'Linux'[\s\S]*pnpm run test:integration/);
    assert.match(release, /^\s+run: pnpm run package\s*$/mu);
    assert.doesNotMatch(release, /package:pre-release|--pre-release/u);
    assert.match(release, /pnpm run verify:vsix/);
    assert.match(release, /SHA256SUMS\.txt/);
    assert.match(workflow, /^concurrency:\s*$/m);
    assert.match(release, /^concurrency:\s*$/m);
    assert.match(workflow, /^  coverage:\s*$/m);
    assert.match(release, /^  coverage:\s*$/m);
    assert.match(workflow, /pnpm run test:coverage/);
    assert.match(release, /pnpm run test:coverage/);
    assert.doesNotMatch(release, /uses:\s+[^\s]+@v\d+/);
    assert.equal((release.match(/pnpm\/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86/g) ?? []).length, 6);
    assert.doesNotMatch(release, /pnpm\/setup@|install: false/);
    assert.match(release, /actions\/upload-artifact@[a-f0-9]{40} # v7\.0\.1/);
    assert.match(release, /retention-days: 14/);
    assert.match(workflow, /timeout-minutes: 25/);
    assert.match(release, /timeout-minutes: 25/);
  });

  test("isolates attestation authority and binds a protected-ref handoff to one recorded digest", () => {
    const release = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "release-candidate.yml"), "utf8");
    const releaseGuide = fs.readFileSync(path.join(process.cwd(), "docs", "release.md"), "utf8");
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      name: string;
      version: string;
      scripts?: Record<string, string>;
    };
    const artifact = `${manifest.name}-${manifest.version}.vsix`;
    const sbom = `${manifest.name}-${manifest.version}.spdx.json`;
    const packageStart = release.indexOf("  package:");
    const validateStart = release.indexOf("  validate-release-handoff:", packageStart);
    const attestStart = release.indexOf("  attest-release-handoff:", validateStart);
    assert.ok(packageStart >= 0 && validateStart > packageStart && attestStart > validateStart);
    const packageJob = release.slice(packageStart, validateStart);
    const validateJob = release.slice(validateStart, attestStart);
    const attestJob = release.slice(attestStart);

    assert.equal(manifest.scripts?.["sbom:vsix"], "node scripts/write-vsix-sbom.js");
    assert.match(packageJob, /if:\s+github\.ref == 'refs\/heads\/main'/u);
    assert.match(packageJob, /SOURCE_DATE_EPOCH=.*git show -s --format=%ct HEAD/u);
    assert.match(packageJob, /^\s+run: pnpm run package\s*$/mu);
    assert.doesNotMatch(packageJob, /id-token: write|attestations: write|actions\/attest@/u);
    assert.ok(packageJob.indexOf("pnpm run digest:vsix") < packageJob.indexOf("pnpm run sbom:vsix"));
    assert.match(packageJob, /name: Upload immutable release handoff/u);

    assert.match(validateJob, /needs: package/u);
    assert.match(validateJob, /if:\s+github\.ref == 'refs\/heads\/main'/u);
    assert.doesNotMatch(validateJob, /id-token: write|attestations: write|actions\/attest@/u);
    assert.match(validateJob, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1/u);
    assert.match(validateJob, /persist-credentials: false/u);
    assert.match(validateJob, /pnpm install --frozen-lockfile --ignore-scripts/u);
    assert.match(validateJob, /pnpm run compile/u);
    assert.match(validateJob, /SOURCE_DATE_EPOCH=.*git show -s --format=%ct HEAD/u);
    assert.match(
      validateJob,
      /^\s+run: node scripts\/verify-vsix-reproducibility\.js\s*$/mu,
    );
    assert.match(validateJob, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8\.0\.1/u);
    assert.match(validateJob, /digest-mismatch: error/u);
    assert.match(
      validateJob,
      /node scripts\/verify-vsix-release-handoff\.js release-handoff/u,
    );
    assert.doesNotMatch(validateJob, /actions\/upload-artifact@|Upload validated release handoff/u);

    assert.match(attestJob, /needs:\s*\[package, validate-release-handoff\]/u);
    assert.match(attestJob, /if:\s+github\.ref == 'refs\/heads\/main'/u);
    assert.match(attestJob, /permissions:\s*\n\s+contents: read\s*\n\s+id-token: write\s*\n\s+attestations: write/u);
    assert.match(attestJob, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8\.0\.1/u);
    assert.doesNotMatch(attestJob, /(?:^|\n)\s+-?\s*run:|checkout@|pnpm|node /u);
    assert.equal((attestJob.match(/actions\/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d # v4\.2\.1/g) ?? []).length, 2);
    assert.equal((release.match(/actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/g) ?? []).length, 2);
    assert.equal((release.match(/actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/g) ?? []).length, 1);

    const provenanceStart = attestJob.indexOf("name: Attest VSIX build provenance");
    const sbomStart = attestJob.indexOf("name: Attest VSIX SBOM", provenanceStart);
    assert.ok(provenanceStart >= 0 && sbomStart > provenanceStart);
    const provenanceStep = attestJob.slice(provenanceStart, sbomStart);
    const sbomStep = attestJob.slice(sbomStart);
    assert.match(provenanceStep, /subject-checksums: SHA256SUMS\.txt/u);
    assert.doesNotMatch(provenanceStep, /subject-path:/u);
    assert.match(sbomStep, /subject-checksums: SHA256SUMS\.txt/u);
    assert.match(sbomStep, new RegExp(`sbom-path: ${escapeRegExp(sbom)}`, "u"));
    assert.doesNotMatch(sbomStep, /subject-path:/u);

    assert.match(
      releaseGuide,
      /gh attestation verify vscode-hydra-room-0\.8\.0\.vsix[\s\S]*--signer-workflow Geraldlol\/hydra\/\.github\/workflows\/release-candidate\.yml[\s\S]*--source-ref refs\/heads\/main[\s\S]*--deny-self-hosted-runners/u,
    );
    assert.match(packageJob, new RegExp(`^\\s+${escapeRegExp(artifact)}$`, "mu"));
    assert.match(packageJob, new RegExp(`^\\s+${escapeRegExp(sbom)}$`, "mu"));
  });

  test("attests the original immutable artifact identity without a mutable validation re-upload", () => {
    const release = fs.readFileSync(
      path.join(process.cwd(), ".github", "workflows", "release-candidate.yml"),
      "utf8",
    );
    const packageStart = release.indexOf("  package:");
    const validateStart = release.indexOf("  validate-release-handoff:", packageStart);
    const attestStart = release.indexOf("  attest-release-handoff:", validateStart);
    assert.ok(packageStart >= 0 && validateStart > packageStart && attestStart > validateStart);
    const packageJob = release.slice(packageStart, validateStart);
    const validateJob = release.slice(validateStart, attestStart);
    const attestJob = release.slice(attestStart);
    const packageArtifactIdentity =
      /artifact-ids:\s*\$\{\{ needs\.package\.outputs\.release_artifact_id \|\| '0' \}\}/u;
    const validatedArtifactIdentity =
      /artifact-ids:\s*\$\{\{ needs\.validate-release-handoff\.outputs\.validated_release_artifact_id \|\| '0' \}\}/u;

    assert.match(
      packageJob,
      /outputs:\s*\n\s+release_artifact_id:\s*\$\{\{ steps\.upload_release_handoff\.outputs\.artifact-id \}\}/u,
    );
    assert.match(packageJob, /id: upload_release_handoff/u);
    assert.match(packageJob, /retention-days: 14/u);
    assert.match(
      validateJob,
      /outputs:\s*\n\s+validated_release_artifact_id:\s*\$\{\{ needs\.package\.outputs\.release_artifact_id \}\}/u,
    );
    assert.match(validateJob, packageArtifactIdentity);
    assert.match(validateJob, /digest-mismatch: error/u);
    assert.doesNotMatch(validateJob, /actions\/upload-artifact@|Upload validated release handoff/u);

    assert.match(attestJob, /needs:\s*\[package, validate-release-handoff\]/u);
    assert.match(attestJob, validatedArtifactIdentity);
    assert.match(attestJob, /digest-mismatch: error/u);
    assert.equal((release.match(/actions\/upload-artifact@/g) ?? []).length, 1);
    assert.equal((release.match(/actions\/download-artifact@/g) ?? []).length, 2);
  });

});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
