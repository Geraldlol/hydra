# Contributing

Thanks for looking at Hydra. It is a solo project right now, and outside help is welcome. Bug reports, feature ideas, docs fixes, and pull requests all move it forward.

## Ways to help

- **File an issue** for a bug or an idea. See [SUPPORT.md](SUPPORT.md) for what to include in a good bug report.
- **Send a pull request** for a fix or a small feature. For anything large, open an issue first so the shape can be agreed before you spend time on it.
- **Report how it runs on your platform.** Hydra is developed on Windows, so Mac and Linux reports are especially useful.

## Development setup

Hydra pins pnpm through Corepack.

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm run lint           # type-check + source-format gate
pnpm test               # clean compile + full deterministic test suite
pnpm run test:coverage  # 80% lines / 70% branches / 80% functions
pnpm run dev            # open an Extension Development Host to try changes live
```

`pnpm run dev` loads the extension from source, so you can iterate without repackaging. See the Local Development section of the README for more.

## Branch and pull request policy

`main` is the release branch.

1. Work on a feature branch.
2. Open a pull request into `main`.
3. Wait for every required GitHub Actions job to pass: the Linux/Windows/macOS and Node 22/24 verification matrix, desktop extension-host tests, dependency audit, coverage, and any package gate applicable to the branch/event.
4. Request owner review before merging.
5. Do not force-push or delete `main`.

Direct pushes to `main` are reserved for owner fixes, and the commit or follow-up note should say why the normal pull request path was bypassed.

## Before you open a pull request

- Run `pnpm run lint` and `pnpm test`, and confirm both pass.
- Run `pnpm run test:coverage` for behavior changes and `pnpm audit --audit-level high` for dependency or release-tooling changes.
- Run `pnpm run test:integration` for extension activation, command-registration, or VS Code host changes. Release-impacting changes must also run `pnpm run package` followed by `pnpm run verify:vsix` and inspect the versioned artifact.
- Keep changes focused, and match the surrounding code style.
- Many behaviors are pinned by contract tests under `test/`. If you move a function across modules, update the matching `*SourceContract*` test.
- Do not commit secrets or `.hydra/` workspace state.
- Do not commit, tag, publish, upload, or remove Marketplace/GitHub artifacts unless the repository owner explicitly authorizes that external action.

## Reporting a security issue

Please do not open a public issue for a security problem. Report it privately using the **Report a vulnerability** button on the repository's **Security** tab so it can be fixed before disclosure.
