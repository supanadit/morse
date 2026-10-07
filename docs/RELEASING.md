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

3. Bump the version stamped in [`STATUS.md`](STATUS.md) — its first line names the release the page describes.
   It is prose, not a manifest, so nothing in the pipeline compares it, and a version nobody checks drifts:
   it read `v0.9.2` through twelve releases before this step existed.

4. Write the `## <version>` section of [`CHANGELOG.md`](../packages/extension/CHANGELOG.md). It is two things at
   once: what a VS Code user reads in the extension's changelog, and the body of the GitHub Release — the
   workflow extracts that section, and only falls back to the notes GitHub generates from commit subjects when a
   version has no section. Keep it about what a user gets: bold lead-in, one sentence, no commit hashes.

5. Commit, tag, and push:

   ```bash
   git add -A
   git commit -m "chore(release): v0.2.0"
   git tag -a v0.2.0 -m "Morse v0.2.0"
   git push origin master --follow-tags
   ```

   The tag must be **annotated** (`git tag -a`): `--follow-tags` silently skips lightweight tags, so a
   `git tag v0.2.0` would push the commit and never trigger the release. Verify with
   `git ls-remote --tags origin | grep v0.2.0`.

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
| `OVSX_PAT` | secret (optional) | open-vsx.org → Settings → Access Tokens | `ovsx publish -p` |
| `GITHUB_TOKEN` | automatic | Provided by GitHub Actions | Creating the GitHub Release |
| `PUBLISH_MARKETPLACE` | variable (optional) | Set to `true` to enable the Marketplace step | Enabling the Marketplace step |
| `PUBLISH_OPENVSX` | variable (optional) | Set to `true` to enable the Open VSX step | Enabling the Open VSX step |

`NPM_TOKEN` is always needed. `VSCE_PAT` is only needed when `PUBLISH_MARKETPLACE` is `true`, and `OVSX_PAT` only
when `PUBLISH_OPENVSX` is `true`.

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

## Publishing to Open VSX

Open VSX is the registry the editors that cannot use the Microsoft Marketplace install from: **VSCodium, Cursor,
Windsurf, code-server, Theia**, and anything else built on the VS Code API. The artifact is identical — the same
`dist/morse.vsix` — so there is nothing extra to build, only a namespace and a token to set up once:

1. Sign in at [open-vsx.org](https://open-vsx.org) — a GitHub account works.
2. **Log in with Eclipse** (Profile → *Log in with Eclipse*) and link or create an Eclipse Foundation account.
   Open VSX wants both accounts, and this is the step that is easy to miss.
3. **Sign the Publisher Agreement**: Profile → *Show Publisher Agreement* → read to the end → **Agree**. Publishing is
   refused without it (it is required on top of the GitHub login).
4. Claim the namespace **`supanadit`**, so it matches the `publisher` field in
   `packages/extension/package.json`. A namespace that matches a GitHub account can be verified from that account,
   which also earns the verified badge.
5. Create an **Access Token** (Settings → Access Tokens) and add it to the `Morse` environment as the secret
   `OVSX_PAT`, then set the environment variable `PUBLISH_OPENVSX` to `true`.

Open VSX also supports **trusted publishing**, and the workflow already prefers it when no token is configured: register
this repository, the workflow file (`release.yml`) and the `Morse` environment on the extension's manage page
(*Trusted Publishers*), and then delete the `OVSX_PAT` secret — the step exchanges the workflow's OIDC ID token
(`id-token: write`, already in the job) for a token valid for minutes. A `-p "$OVSX_PAT"` always takes precedence
over that exchange, so keeping the secret while you try it out changes nothing.

The workflow then runs `ovsx verify-pat` before publishing — a missing namespace or a token that does not own it
fails with a nameable error instead of a half-published release — and asks `open-vsx.org/api/...` afterwards, with
a warning rather than a failure: Open VSX scans a new version before it serves it.

By hand, from the repository root:

```bash
npx ovsx verify-pat supanadit -p <token>
npx ovsx publish --packagePath dist/morse.vsix -p <token>
```

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
| Open VSX step skipped | `PUBLISH_OPENVSX` is not `true` |
| Open VSX step fails with a token/ID-token error | neither `OVSX_PAT` nor a trusted-publisher registration matches this repository, workflow (`release.yml`) and environment (`Morse`) |
| `ovsx` namespace error | the namespace in `publisher` is not claimed by the token's account (see above) |
| A brand-new extension on Open VSX shows *Under review* (an earlier label was *Deactivated*) and its API answers *Extension not found* | Open VSX runs pre-publish security checks, so a new version is quarantined until they pass — normally minutes, longer when the automated checks flag something. Nothing to fix, and the workflow's warning is the expected state; still hidden after a day → `openvsx@eclipse-foundation.org` |
| `ovsx` refuses to publish at all | no Eclipse account or Publisher Agreement for the namespace's owner (both are required on top of GitHub) |
| A registry shows the old version right after a release | it holds a new version while it validates it — the publish steps warn instead of failing |
| Tag pushed but no run | The tag must match `v*`; delete and re-push it (`git push origin :v0.2.0 && git push origin v0.2.0`). If `git push --follow-tags` printed no tag line, the tag is lightweight and was skipped — recreate it annotated (`git tag -a v0.2.0 -m "Morse v0.2.0"`) and push it |
