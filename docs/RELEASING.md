# Releasing

One semver tag releases **both** artifacts:

| Artifact | Where it goes |
|---|---|
| `morse-<version>.vsix` | GitHub Release asset, and the VS Code Marketplace (when Marketplace publishing is enabled) |
| `@supanadit/morse-web` | npm (`npm install -g @supanadit/morse-web`) |

The tag `v<major>.<minor>.<patch>` is the single source of truth. The workflow refuses to publish if any
manifest disagrees with it, so the version in the tag, the VSIX and the npm package can never drift.

## Cut a release

1. Bump every manifest to the release version and refresh the lockfile:

   ```bash
   npm version 0.2.0 --workspaces --include-workspace-root --no-git-tag-version
   ```

   This sets the version in the root, every package under `packages/`, and `package-lock.json`. Use an
   explicit version — a `patch`/`minor` bump would update each package relative to its *own* current version
   and leave them out of sync.

2. Update [`CHANGELOG.md`](../packages/extension/CHANGELOG.md) if there is anything worth saying beyond the
   generated commit list.

3. Commit, tag, and push:

   ```bash
   git add -A
   git commit -m "chore(release): v0.2.0"
   git tag v0.2.0
   git push origin master --follow-tags
   ```

Pushing the tag starts [`.github/workflows/release.yml`](../.github/workflows/release.yml).

## What the release workflow does

1. Resolves the version from the tag and **fails early** when a manifest does not match it.
2. `npm ci`, `check-types`, `test:fast`.
3. `npm run build` → libraries, Angular bundle, webview sync, extension and server.
4. `npm run build -w @supanadit/morse-web` → the single-file npm artifact.
5. `npm run vsix -w morse` → `dist/morse.vsix` (verifies the webview bundle first).
6. `npm publish -w @supanadit/morse-web` with `NPM_TOKEN`.
7. `gh release create` with the VSIX attached and generated release notes.
8. `vsce publish --packagePath dist/morse.vsix --oidc` — only when the `PUBLISH_MARKETPLACE` environment
   variable is `true` (see below).

The GitHub Release is created **after** npm and **before** the Marketplace publish, so a Marketplace failure
(trusted publishing not configured yet) never hides the npm release or the VSIX asset.

## Secrets and variables

| Name | Kind | Where it comes from | Used for |
|---|---|---|---|
| `NPM_TOKEN` | secret | npm → Access Tokens → *Generate New Token* → **Automation** (or Granular with publish rights for `@supanadit/morse-web`) | `npm publish` |
| `GITHUB_TOKEN` | automatic | Provided by GitHub Actions | Creating the GitHub Release |
| `PUBLISH_MARKETPLACE` | variable (optional) | You set it to `true` once trusted publishing is configured | Enabling the Marketplace step |

So the only secret you store by hand is **`NPM_TOKEN`**. The Marketplace step uses OIDC — no PAT, no secret.

The release job targets the **`Morse` environment**, so both live there: **Settings → Environments → Morse**.
Add `NPM_TOKEN` under **Environment secrets** and `PUBLISH_MARKETPLACE` under **Environment variables**. An approval
rule on that environment (Required reviewers) then gates every publish. Repository-scope secrets/variables work too,
but the environment is what the workflow reads from first.

## Publishing to the VS Code Marketplace (OIDC)

Personal Access Tokens for Marketplace publishing are being retired: **global PATs in Azure DevOps stop working
on December 1, 2026**. The workflow therefore publishes with trusted publishing instead:

1. Configure a **trusted publishing policy for this repository and workflow** on the VS Code Marketplace
   publisher. The `vsce` documentation and the tracking issue describe the exact policy:
   - <https://github.com/microsoft/vscode-vsce#trusted-publishing>
   - <https://github.com/microsoft/vsmarketplace/issues/1422>
   - <https://code.visualstudio.com/api/working-with-extensions/publishing-extension>
2. Set the `PUBLISH_MARKETPLACE` environment variable (Settings → Environments → Morse → Environment variables)
   to `true`.

The workflow already grants the OIDC token permission (`permissions: id-token: write`) and runs
`vsce publish --oidc`. OIDC has **no fallback**: if the policy is missing or the exchange fails, the step fails
loudly instead of silently skipping. While the variable is unset, the step is skipped and the VSIX still ships
as a GitHub Release asset, so a release never blocks on Marketplace setup.

If your publisher cannot use trusted publishing yet, the documented Entra ID route uses a user-assigned managed
identity plus a federated credential and `vsce publish --azure-credential`; issue #1422 walks through it. A PAT
(`VSCE_PAT` + `vsce publish -p`) also still works until December 1, 2026 as a stopgap, but it is not wired into
the workflow.

## Verifying a release without publishing

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every push and pull request: `check-types`,
`lint`, `test:fast`, a full build, a `npm pack --dry-run` of the npm artifact, and the VS Code integration test
under `xvfb-run`. To rehearse the release locally, follow
[`PACKAGING.md`](PACKAGING.md) and
[`INSTALL.md`](INSTALL.md#32-install-from-a-local-tarball-before-it-is-on-npm).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "a manifest disagrees with the tag" | The tag does not match the versions; run the `npm version` line above and re-tag |
| `npm publish` 403 | `NPM_TOKEN` is missing, expired, or not allowed to publish `@supanadit/morse-web` |
| Marketplace step skipped | `PUBLISH_MARKETPLACE` is not `true` |
| `vsce publish` OIDC error | The trusted publishing policy is missing or does not match this repo/workflow; see issue #1422 |
| Tag pushed but no run | The tag must match `v*`; delete and re-push it (`git push origin :v0.2.0 && git push origin v0.2.0`) |
