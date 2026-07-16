# Hydra Marketplace Release Checklist

This checklist is for packaging and publishing the current Marketplace preview of Hydra.

## Confirm Identity

- Publisher id: `geraldlol`
- Extension id: `geraldlol.vscode-hydra-room`
- Marketplace display name: `Hydra Agents`
- Package name: `vscode-hydra-room`
- Release version: `0.6.3`

The display name is reversible in a later release. The publisher id and package name are the durable extension identity.

## Local Release Candidate

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm run verify:fast
pnpm run package
pnpm exec vsce ls --no-dependencies --tree
```

Inspect the VSIX contents before publishing. `.hydra/`, source TypeScript, tests, local VS Code settings, and native reconnaissance notes should not be shipped.

## Required Human Actions

1. Merge the release branch so README assets resolve from the repository's default branch.
2. Create a GitHub release and attach the versioned VSIX.
3. Upload the VSIX to the Marketplace under the existing `geraldlol` publisher.

Do not publish from automation until the first manual beta has been tested from the Marketplace listing.

## Pre-Publish Checks

- Confirm no secrets are tracked in Git history.
- Confirm `.hydra/` is ignored and absent from `pnpm exec vsce ls --no-dependencies`.
- Confirm README security notes are accurate for public users.
- Confirm a fresh install from VSIX can run `Hydra: Run Doctor`.
- Confirm the extension host has been reloaded after installing the VSIX.
