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

2. Bump the version the frontend announces, in `packages/ui-angular/src/app/core/morse.service.ts`
   (`FRONTEND_IDENTITY`). The panel cannot read its own manifest at runtime, so the number is a literal — and
   `core/frontend-identity.spec.ts` compares it with `packages/ui-angular/package.json`, which means a forgotten
   bump fails `test:fast` before the tag is pushed.

3. Write the `## <version>` section of [`CHANGELOG.md`](../packages/extension/CHANGELOG.md). It is two things at
   once: what a VS Code user reads in the extension's changelog, and the body of the GitHub Release — the
   workflow extracts that section, and only falls back to the notes GitHub generates from commit subjects when a
   version has no section. Keep it about what a user gets: bold lead-in, one sentence, no commit hashes.

4. Commit, tag, and push:

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
7. `gh release create` with the VSIX attached and this version's changelog section as the release body (the
   generated commit notes only when there is no section).
8. `vsce publish --packagePath dist/morse.vsix -p "$VSCE_PAT"` — only when `PUBLISH_MARKETPLACE` is `true` and
   the `VSCE_PAT` secret is present (see below).

The GitHub Release is created **after** npm and **before** the Marketplace publish, so a Marketplace failure
never hides the npm release or the VSIX asset.

## Secrets and variables

| Name | Kind | Where it comes from | Used for |
|---|---|---|---|
| `NPM_TOKEN` | secret | npm → Access Tokens → *Generate New Token* → **Automation** (or Granular with publish rights for `@supanadit/morse-web`) | `npm publish` |
| `VSCE_PAT` | secret (optional) | Azure DevOps → PAT scoped to **Marketplace → Manage** | `vsce publish -p` |
| `GITHUB_TOKEN` | automatic | Provided by GitHub Actions | Creating the GitHub Release |
| `PUBLISH_MARKETPLACE` | variable (optional) | Set to `true` to enable the Marketplace step | Enabling the Marketplace step |

`NPM_TOKEN` is always needed. `VSCE_PAT` is only needed when `PUBLISH_MARKETPLACE` is `true`.

The release job targets the **`Morse` environment**, so both live there: **Settings → Environments → Morse**.
Add `NPM_TOKEN` under **Environment secrets** and `PUBLISH_MARKETPLACE` under **Environment variables**. An approval
rule on that environment (Required reviewers) then gates every publish. Repository-scope secrets/variables work too,
but the environment is what the workflow reads from first.

## Publishing to the VS Code Marketplace

The workflow publishes with a Personal Access Token (`VSCE_PAT`). `vsce publish --oidc` is **not usable yet**:
vsce 4.0.0 calls the Marketplace token exchange without an `api-version` and the endpoint answers
`400 Bad Request`.

1. Create a PAT in Azure DevOps:
   - **Organization**: pick a single organization. Do **not** use *All accessible organizations* — those
     "global" PATs are retired on December 1, 2026.
   - **Scopes**: *Custom defined* → **Show all scopes** → **Marketplace** → **Manage**. Nothing else is needed.
   - Copy it immediately (it is shown once).
2. Add it to the `Morse` environment as a secret named `VSCE_PAT`
   (Settings → Environments → Morse → Environment secrets).
3. Set the `PUBLISH_MARKETPLACE` environment variable to `true`.

The step is skipped unless `PUBLISH_MARKETPLACE` is `true` **and** `VSCE_PAT` is non-empty, so a release never
blocks on Marketplace setup.

Notes:

- PATs expire (up to a year) — rotate before it lapses and update the secret, or the step fails with 401/403.
- `vsce publish --oidc` (trusted publishing) and the Entra ID route (`vsce publish --azure-credential` plus a
  user-assigned managed identity with a federated credential; see `microsoft/vsmarketplace#1422`) remove the
  long-lived secret. Switch when OIDC is fixed or the Entra ID identity is set up.
- You can also skip CI entirely and upload the `.vsix` by hand: **New extension → Upload** on the publisher page.

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
| Marketplace step skipped | `PUBLISH_MARKETPLACE` is not `true`, or the `VSCE_PAT` secret is empty |
| `vsce publish` 401/403 | `VSCE_PAT` is missing, expired, or not scoped to **Marketplace → Manage** |
| Tag pushed but no run | The tag must match `v*`; delete and re-push it (`git push origin :v0.2.0 && git push origin v0.2.0`) |
