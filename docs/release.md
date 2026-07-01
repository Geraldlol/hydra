# Hydra Public Beta Release Checklist

This checklist is for the first public Marketplace beta of Hydra.

## Confirm Identity

- Publisher id: `geraldlol`
- Extension id: `geraldlol.vscode-hydra-room`
- Marketplace display name: `Hydra Agents`
- Package name: `vscode-hydra-room`
- Release version: `0.5.1`

The display name is reversible in a later release. The publisher id and package name are the durable extension identity.

## Local Release Candidate

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm run verify:fast
pnpm run package:pre-release
pnpm exec vsce ls --no-dependencies
```

Inspect the VSIX contents before publishing. `.hydra/`, source TypeScript, tests, local VS Code settings, and native reconnaissance notes should not be shipped.

## Required Human Actions

1. Claim or create the `geraldlol` publisher in the VS Code Marketplace account.
2. Make `https://github.com/Geraldlol/hydra` public.
3. Create a GitHub release and attach the pre-release VSIX.
4. Publish to Marketplace with `vsce publish --pre-release` or upload the VSIX manually.

Do not publish from automation until the first manual beta has been tested from the Marketplace listing.

## Pre-Publish Checks

- Confirm no secrets are tracked in Git history.
- Confirm `.hydra/` is ignored and absent from `pnpm exec vsce ls --no-dependencies`.
- Confirm README security notes are accurate for public users.
- Confirm a fresh install from VSIX can run `Hydra: Run Doctor`.
- Confirm the extension host has been reloaded after installing the VSIX.
