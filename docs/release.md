# Hydra 0.8.0 Release Checklist

This document prepares a release candidate; it does not authorize a commit, tag, push, GitHub release, Marketplace upload, unpublish, or deletion. Those external actions remain human-controlled.

## Identity and artifact

- Publisher id: `geraldlol`
- Extension id: `geraldlol.vscode-hydra-room`
- Marketplace display name: `Hydra Agents`
- Package name: `vscode-hydra-room`
- Release version: `0.8.0`
- Expected artifact: `vscode-hydra-room-0.8.0.vsix`
- Digest record: `SHA256SUMS.txt`
- Consumer SBOM: `vscode-hydra-room-0.8.0.spdx.json`

The publisher id and package name are the durable extension identity. The display name can change in a later release.

## Release boundaries

- Gemini and Claude Worker Fanout have deterministic contract coverage, but this release candidate has not been live-smoked against paid/authenticated provider accounts. Run bounded account-specific smoke tests only with explicit operator approval and cost limits.
- Arena's isolated core, retained-result management, promotion, startup classification, and confirmed dead-owner repository-lease takeover surfaces are implemented. The recovery command does not execute resume, abort, cleanup, or contestant processes. Built-in native contestants remain fail-closed and there is no production Start Arena action until each adapter has platform-specific descendant containment and active-count-zero quiescence proof.
- Flight Replay prepares an isolated metadata-bound worktree and replacement input. It does not retain exact prompt/response content, reuse a provider session, or submit a paid request automatically.
- The experimental Windows PowerShell Terminal Bridge keeps reply-HMAC key material out of pasted commands and shell history. Its one-use 32-byte artifact is created in extension-private storage, exclusively read and deleted before native command resolution, and cleared from host and PowerShell buffers during cleanup. Fresh owner-tagged crash leftovers are eligible for early reclamation only when the extension-host PID is definitively dead; this is ambient-leakage hardening, not isolation from pre-existing or detached processes running as the same OS user.
- A configured CI matrix is not evidence that the release commit passed it. Record the actual workflow URL/result before publication.
- Public promotion is blocked until the repository has a real independent security/workflow reviewer and an enforced GitHub ruleset or branch-protection policy that requires that review and the release gates. Do not satisfy this mechanically by naming the current sole owner again in CODEOWNERS; the reviewer and enforcement must be independent and real.

## Local release candidate

Run from a clean checkout with the pinned pnpm version and supported Node 22.22.1 or 24.x runtime:

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm run lint
pnpm test
pnpm run test:coverage
pnpm audit --audit-level high
pnpm run test:integration
$env:SOURCE_DATE_EPOCH = (git show -s --format=%ct HEAD).Trim()
pnpm run package
pnpm run verify:vsix
```

`pnpm run package` uses a stable `SOURCE_DATE_EPOCH` when none is supplied, creates two independent VSIX archives from the same compiled `dist` tree, compares the complete artifact bytes, and runs the strict VSIX verifier before retaining the artifact. This proves archive-packaging reproducibility; the clean compilation and source tests are separate gates earlier in the checklist. `verify:vsix` independently reopens the package and checks bounded ZIP structure, root/embedded manifest identity, the exact packaged release manifest, every compiled JavaScript runtime byte, and security-relevant source-backed static bytes including `media/webview.js`, license/support files, and shipped images. Marketplace README/changelog entries are mandatory but VSCE-normalized; the fresh validation-job rebuild binds their exact packaged bytes along with every generated archive byte. Source, tests, scripts, the repository `docs/` tree, `.hydra/`, `.sf/`, `.sfdx/`, tool state, credential-shaped files, nested VSIX files, and other local/private content must be absent.

`pnpm run test:integration` launches a VS Code Extension Development Host and may need a display plus the VS Code test runtime download. Record an unavailable external runtime as a release blocker; do not relabel it as a pass.

## Reproducibility, digest, SBOM, and attestations

The package command performs the two-build comparison automatically. Bind the canonical build/document time to the reviewed release commit, then record the retained artifact digest:

```powershell
$env:SOURCE_DATE_EPOCH = (git show -s --format=%ct HEAD).Trim()
pnpm run package
pnpm run digest:vsix
pnpm run sbom:vsix
Get-Content .\SHA256SUMS.txt
```

Byte equality is guaranteed only within the same checkout normalization, OS/filesystem, dependencies, and pinned Node/pnpm/VSCE toolchain. The `Release Candidate` workflow's Ubuntu Node 22.22.1 package job is the reference release environment; cross-platform test success does not imply that archives created from platform-specific working-tree bytes share one hash.

Run `digest:vsix` only after the final source and packaged documentation state is frozen. It removes any stale digest, requires the exact version-derived VSIX to be the only root `.vsix`, re-verifies it, and writes the lowercase hash plus basename to `SHA256SUMS.txt`. Then run `sbom:vsix`; it requires the declared source-commit `SOURCE_DATE_EPOCH`, independently re-verifies the archive, fails closed on missing, malformed, stale, or mismatched checksum evidence, and writes a strict SPDX 2.3 document whose package checksum is the recorded VSIX SHA-256. Re-run `pnpm run verify:vsix`, compare the artifact hash with `SHA256SUMS.txt`, and inspect the SBOM immediately before upload.

The manual `Release Candidate` workflow packages only `main` and deliberately uses stable `pnpm run package` semantics; the resulting VSIX is the single artifact intended for the 0.8.0 GitHub and Marketplace publication handoff, not a Marketplace pre-release. Its unprivileged package job uploads the three files once as one immutable 14-day artifact and exposes that exact GitHub artifact ID. A fresh no-OIDC validation job downloads only that ID, checks out the same trusted source revision, installs without lifecycle scripts, recompiles it, independently rebuilds the reproducible stable VSIX, and requires the downloaded candidate to be byte-for-byte identical to that fresh rebuild. It then reruns the strict archive verifier and requires the checksum plus SPDX bytes (including source timestamp, license, and namespace fingerprint) to be exactly canonical; it does not copy, promote, or re-upload the validated files. A successful job emits a code-free receipt that is exactly the original package artifact ID. Only then does a final minimal job download that receipt's ID and receive GitHub's OIDC/attestation authority. An absent ID is replaced with a deliberately invalid ID so either download fails closed instead of broadening to every run artifact. No checkout, dependency install, or repository script runs with that authority. Both downloads require GitHub's recorded artifact digest to match, and both attestations use the same exact `SHA256SUMS.txt` VSIX subject digest. After the workflow succeeds, verify the exact downloaded artifact against this repository, signer workflow, protected source ref, GitHub-hosted runner, and recorded release commit:

```powershell
$releaseCommit = "<reviewed full release commit SHA>"
gh attestation verify vscode-hydra-room-0.8.0.vsix -R Geraldlol/hydra --signer-workflow Geraldlol/hydra/.github/workflows/release-candidate.yml --source-ref refs/heads/main --source-digest $releaseCommit --deny-self-hosted-runners
gh attestation verify vscode-hydra-room-0.8.0.vsix -R Geraldlol/hydra --predicate-type https://spdx.dev/Document/v2.3 --signer-workflow Geraldlol/hydra/.github/workflows/release-candidate.yml --source-ref refs/heads/main --source-digest $releaseCommit --deny-self-hosted-runners
```

Treat a missing or failed attestation verification as a release blocker. Compare the workflow artifact with the intended release source rather than assuming equivalence.

## CI evidence

The release commit must pass:

- `verify:fast` on Linux, Windows, and macOS with Node 22.22.1 and 24.x;
- extension-host tests on Linux, Windows, and macOS;
- `pnpm audit --audit-level=high`;
- coverage thresholds of 80% lines, 70% branches, and 80% functions; and
- reproducible package creation, independent VSIX verification, checksum-bound SPDX generation, and successful build/SBOM attestations.

Actions are pinned by immutable revision and repository contents remain read-only. Only the final handoff job receives the identity-token and attestation permissions required to create GitHub attestations, and it runs no repository or dependency code. The workflow does not publish a GitHub release or Marketplace package. Preserve the workflow run URL with the human approval record.

## Human inspection and smoke

- Review the complete change set and confirm version, changelog, README, VSIX manifest, VSIX/SBOM filenames, and `SHA256SUMS.txt` agree.
- Inspect `pnpm exec vsce ls --no-dependencies --tree` and the verifier result. Confirm no workspace/private state or secrets are present.
- Download the release-candidate artifact, run both policy-pinned `gh attestation verify` commands above, and retain the successful results with the workflow evidence.
- Install the exact digested VSIX into an isolated VS Code profile, reload the extension host, and run `Hydra: Start`, `Hydra: Run Doctor`, and the Mission + Flight Recorder smoke test.
- Run the Arena worktree smoke only in a disposable clean Git repository. It uses supervised fake heads and does not prove native-model containment.
- If Gemini or Claude fanout will be advertised as account-tested, run a separately approved bounded live smoke and record CLI versions, auth mode, cost ceiling, and sanitized outcome. Otherwise retain the explicit untested boundary in the release notes.
- Have a human make the final publish decision after reviewing all evidence.

## Superseding 0.7.3

The default recovery is to publish the sanitized 0.8.0 as a higher-version successor. Do not overwrite or silently relabel a 0.7.3 artifact. Keep the 0.7.3 changelog and tag history intact.

Unpublishing 0.7.3 is a separate, externally destructive decision. Use it only if the owner concludes that leaving the old Marketplace artifact available creates greater risk than breaking historical availability, and record that rationale before acting. No automation in this repository performs the removal.

If 0.8.0 must be withdrawn after publication:

1. stop further promotion and preserve the failing artifact, digest, logs, and private-state schema evidence;
2. disable the affected optional capability or prepare a fix-forward 0.8.1 whenever possible;
3. offer 0.7.3 only if the exact old VSIX has independently passed the same private-content review and its digest is known; and
4. archive workspace and extension-private state before any downgrade, because forward-written private schemas are not promised to be writable by an older extension.

## Publication handoff

After every gate above is green and the human approves:

1. merge the reviewed release commit;
2. create the signed/annotated `v0.8.0` tag according to repository policy;
3. create the GitHub release and attach the exact digested VSIX, `SHA256SUMS.txt`, and `vscode-hydra-room-0.8.0.spdx.json`; and
4. upload that same VSIX under the existing `geraldlol` Marketplace publisher.

Publication credentials and timing are intentionally absent from automation. Verify the Marketplace install and critical commands after upload, then retain the rollback evidence for the monitoring window.
