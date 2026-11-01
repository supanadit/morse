# Project instructions

## Releases — mandatory checklist

When the user asks to release, cut a version, or "create a tag and push so CI/CD picks it up", you MUST
follow [docs/RELEASING.md](docs/RELEASING.md) in full, every time. A release is never just `npm version` + tag.
Minimum checklist, in order:

1. Bump **every** manifest (root + all workspaces + lockfile) with an explicit version:
   `npm version X.Y.Z --workspaces --include-workspace-root --no-git-tag-version`
2. Bump the `FRONTEND_IDENTITY` literal in
   `packages/ui-angular/src/app/host/morse.service.ts` — nothing auto-syncs it; `test:fast` fails if forgotten.
3. Bump the version in the first line of `docs/STATUS.md`.
4. Add a `## X.Y.Z` section to `packages/extension/CHANGELOG.md` (it becomes the GitHub Release body).
5. Run `npm run test:fast` locally and confirm green.
6. Commit, create an **annotated** tag (`git tag -a vX.Y.Z` — `--follow-tags` skips lightweight tags), then
   push with `git push origin master --follow-tags`.

Never force-move a tag that CI has already run against; if the release failed and you fixed code, ask or
explain, and prefer fixing forward. Verify the workflow started: `gh run list --limit 1`.
