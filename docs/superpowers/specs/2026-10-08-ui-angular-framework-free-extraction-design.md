# Extract framework-free logic out of `@morse/ui-angular` into `@morse/ui-runtime`

- **Date:** 2026-10-08
- **Status:** Design — approved in chat, awaiting spec review
- **Scope:** `packages/ui-angular`, `packages/ui-runtime` (source, tests, manifests, docs)
- **Related:** `docs/FRONTENDS.md`, `packages/ui-angular/AGENTS.md`, `packages/ui-runtime/AGENTS.md`

## Context

Morse is built so the UI framework is a leaf detail: a frontend is a static bundle plus
`webview.manifest.json`, both hosts serve it as-is, and `docs/FRONTENDS.md` states that
`@morse/ui-runtime` is "everything a frontend needs that is not a view". A framework binding was
supposed to be thin — hold the `SessionView` in the framework's reactivity primitive and call
`client.actions.*`.

The current tree does not meet that contract. `packages/ui-angular/src/app/` holds ~1,600 lines of
framework-agnostic logic that a second frontend (`ui-react`, `ui-svelte`, …) would have to copy
verbatim. Coupling is clean: every one of those modules imports only `@morse/protocol` (or nothing),
none is imported by any package outside `ui-angular`, and none depends on Angular.

The frontend contract (`docs/FRONTENDS.md`) is therefore true in intent but not yet in fact for the
non-view layer.

## Goal

`@morse/ui-angular` contains only what is genuinely Angular- or view-specific: components,
directives, HTML/CSS, DI tokens and providers, the `MorseService` wire binding, and app-local state
that needs Angular reactivity. Every framework-free, reusable piece lives in `@morse/ui-runtime`
alongside the existing transport, client and prompt-template modules.

### Success criteria

- No file under `packages/ui-angular/src/` is framework-free *and* reusable by another frontend.
- `@morse/ui-runtime` exports every shared frontend helper from its single public entry
  (`@morse/ui-runtime`), with its own tests and type-check.
- No behavioural change, no wire change, no `PROTOCOL_VERSION` bump.
- `npm run build`, `npm run test:fast` and `npm run sync-webview` pass.

## Non-goals

- No change to the behaviour of any Angular store, component, directive, template or stylesheet;
  only their import paths are rewritten.
- No change to `@morse/protocol`, `@morse/core`, `@morse/host-runtime`, `@morse/adapter-pi-rpc`,
  `packages/extension` or `packages/server`.
- No new package.
- No subpath exports; the public path stays the single `@morse/ui-runtime`.
- No behaviour change of any kind — this is a move plus an import rewrite.

## Boundary rule

A module moves to `@morse/ui-runtime` when **all** of these hold:

1. It imports no `@angular/*` (and no Angular-specific primitive such as `signal`/`inject`).
2. It is useful to a frontend built with another framework, unchanged.
3. It does not own app-local state that needs framework reactivity.

Everything else stays. Under this rule the following stay: `shell-state`, `workspace-tabs`,
`attachments`, `composer-drafts`, `queued-prompts`, `queue-drain`, `mcp-state`, `terminal-store`,
`shortcuts`, `view-state`, `workbench-persistence`, `workspace-files`, `panel-state`,
`git-panel-state`, `display-prefs`, `notification-prefs`, `notifications`, `uploads`,
`prompt-templates-state`, `boot-handoff`, `drop-zone`, `drop-flight`, `popover-fit.directive`,
`animation.service`, `morse.service`, `transport.token`, and every component/directive.

## Module mapping

`src` paths below are relative to `packages/ui-angular/src/app/` (source) and
`packages/ui-runtime/src/` (target). Each module's `.spec.ts` moves with it.

| Target | Source | Lines |
| --- | --- | --- |
| `git/graph.ts` | `core/git-graph.ts` | 116 |
| `git/status.ts` | `core/git-status.ts` | 150 |
| `git/diff.ts` | `chat/file-preview/git-diff.ts` | 196 |
| `files/tree.ts` | `core/file-tree.ts` | 86 |
| `files/positions.ts` | `chat/file-preview/preview-positions.ts` | 209 |
| `transcript/rows.ts` | `chat/transcript-rows.ts` | 274 |
| `transcript/tasks.ts` | `core/task-list.ts` | 169 |
| `transcript/tools.ts` | `core/tool-describe.ts` | 102 |
| `transcript/usage.ts` | `core/usage-format.ts` | 104 |
| `palette/commands.ts` | `core/palette.ts` | 182 |
| `lsp/guards.ts` | `core/lsp.ts` | 139 |
| `render/markdown.ts` | `core/markdown.ts` | 183 |
| `render/highlight.ts` | `core/highlight.ts` | 169 |
| `render/annotation-mirror.ts` | `chat/pin-annotation/mirror.ts` | 156 |
| `prompt/render.ts` | `chat/prompt-editor/render.ts` | 48 |
| `ui/placement.ts` | `chat/pin-annotation/placement.ts` | 63 |
| `terminal/links.ts` | `findTerminalLinks` from `chat/terminal/terminal-links.ts` | — |

The existing `packages/ui-runtime/src/prompt-template.ts` and `client.ts` are **not** moved. The new
`prompt/render.ts` sits beside the existing `prompt-template.ts`; consolidating the latter into
`prompt/template.ts` is explicitly deferred (it would churn an already-documented path for no
functional gain).

### `terminal/links.ts` — a split, not a move

`chat/terminal/terminal-links.ts` currently holds two things:

- `findTerminalLinks(text): TerminalLink[]` — pure string analysis, framework-free.
- `registerTerminalLinks(term, open)` — binds `ILinkProvider` to an `@xterm/xterm` `Terminal`
  instance, i.e. a view binding to one specific terminal emulator.

Only `findTerminalLinks` (and its `TerminalLink` type) moves to `ui-runtime`. `registerTerminalLinks`
stays in `ui-angular` and imports the pure helper from `@morse/ui-runtime`. This keeps
`@xterm/xterm` out of `ui-runtime`'s dependency surface.

### Guards stay in `ui-runtime`, not `protocol`

`asGitStatus`, `asCommitFiles` and the `asLsp*` helpers validate the `unknown` reply of a
`host/command`, which is a frontend-runtime concern. `@morse/protocol` is the pure wire contract
(`parseHostMessage`, `isFrontendManifest` validate wire messages); pulling git porcelain semantics
and LSP shapes into it would widen that contract past its purpose. They travel with their modules
into `ui-runtime`.

## Public API

`packages/ui-runtime/src/index.ts` gains one re-export per new module:

```ts
export * from './git/graph.js';
export * from './git/status.js';
export * from './git/diff.js';
export * from './files/tree.js';
export * from './files/positions.js';
export * from './transcript/rows.js';
export * from './transcript/tasks.js';
export * from './transcript/tools.js';
export * from './transcript/usage.js';
export * from './palette/commands.js';
export * from './lsp/guards.js';
export * from './render/markdown.js';
export * from './render/highlight.js';
export * from './render/annotation-mirror.js';
export * from './prompt/render.js';
export * from './ui/placement.js';
export * from './terminal/links.js';
```

Relative imports inside moved files must carry the `.js` extension (ESM rule; `ui-runtime` uses
`module: NodeNext`). `render/markdown.ts`'s `import { highlightCode } from './highlight'` becomes
`'./highlight.js'`.

No export name collides with an existing `ui-runtime` export. This is checked during the first
wave by building `ui-runtime`; a collision fails `tsc` on the duplicate `export *`.

## Dependencies

`packages/ui-runtime/package.json`:

- `dependencies`: `marked` (`^18.0.14`), `dompurify` (`^3.4.16`), `highlight.js` (`^11.12.0`) —
  versions matched to `packages/ui-angular/package.json`. These are required by
  `render/markdown.ts` and `render/highlight.ts`, which move.
- `devDependencies`: add `jsdom` (for the DOM specs).
- No `@xterm/xterm` — the xterm binding stays in `ui-angular`.

`packages/ui-angular/package.json` keeps its copies of `marked`, `dompurify` and `highlight.js`
because other `ui-angular` modules and its Angular build still declare and use them
(`shared/markdown/markdown.ts`, `chat/pin-annotation/`, etc.). Removing them is out of scope; a
later dedup can drop the direct deps once nothing in `ui-angular` imports the libraries directly.

This is a deliberate dependency addition to `ui-runtime`, approved as part of the chosen approach.

## Tests

- Every moved module's spec moves with it and runs under `ui-runtime`'s vitest.
- `ui-runtime` has no vitest config and defaults to the node environment. DOM-dependent specs
  (`render/markdown.spec.ts`, `files/positions.spec.ts`, and any other that touches `document` or
  `DOMPurify`) get a `// @vitest-environment jsdom` docblock at the top of the file; the rest keep
  the node default. No `environmentMatchGlobs` needed.
- `npm run test:fast` already runs `@morse/ui-runtime` before `@morse/ui-angular`, so ordering is
  unchanged.
- `ui-angular`'s spec files for the moved modules are deleted as part of the same move; no spec
  stays behind pointing at a moved source.

## Build and CI

- No build-config change: `ui-runtime` builds with `tsc -p tsconfig.json` and already emits per-file
  output; `index.ts` picks up the new modules. `tsconfig.json` already has
  `lib: ["ES2022", "DOM", "DOM.Iterable"]`.
- `build:libs` already builds `@morse/ui-runtime` before `@morse/ui-angular`; no CI change.
- No `PROTOCOL_VERSION` bump (no wire shape changed).
- `npm run sync-webview` is still required after the UI changes, because `ui-angular` rebuilds.

## Migration waves

Each wave ends green (build + type-check + tests) before the next begins, so a wave can be reverted
on its own.

1. **Category A (pure, zero new deps).** Move the 12 Category A modules and specs with `git mv`;
   add their `index.ts` re-exports; rewrite every `ui-angular` import to `@morse/ui-runtime`. Build
   and test both packages.
2. **Category B (render).** Move the 4 render/DOM modules and specs — `markdown`, `highlight`,
   `preview-positions`, `annotation-mirror`; add `marked`/`dompurify`/`highlight.js` and `jsdom`;
   add `// @vitest-environment jsdom` where needed; rewrite imports. Build and test both packages.
3. **`terminal-links` split and docs.** Extract `findTerminalLinks` into `terminal/links.ts`; leave
   `registerTerminalLinks` in `ui-angular`. Update the docs listed below. Full
   `npm run build`, `npm run test:fast`, `npm run sync-webview`.

The full importer set to rewrite is ~23 non-spec files in `ui-angular`, including `chat-transcript`,
`file-preview`, `pin-annotation` (3 files), `note-hover`, `prompt-editor`, `tab-strip`,
`task-overlay`, `terminal`, `task-board`, `tool-group`, `usage-indicator`, `workspace-files`,
`workspace-tabs`, `git-panel`, `file-explorer`, `session-nav`, `command-palette`, `shared/markdown`,
`model-picker` and `chat-composer`.

## Documentation updates (wave 3)

- `packages/ui-runtime/AGENTS.md` — extend the Overview table with the new domain folders; add
  "framework-free frontend helper" to the guidance; note the jsdom docblock convention.
- `packages/ui-angular/AGENTS.md` — remove the moved modules from `src/app/core/` and the feature
  paths; keep the app-local state entries; update the "When stuck" references to the new
  `ui-runtime` paths.
- `docs/FRONTENDS.md` — update the "Reusable pieces" table and the module paths cited in the Rules
  and browser-host sections (e.g. `core/git-graph.ts` → `@morse/ui-runtime`).
- Root `AGENTS.md` — "Where new code goes": a framework-free frontend helper goes to
  `packages/ui-runtime`.
- `docs/ARCHITECTURE.md` — update any rule-map citation of the moved paths.

## Verification

1. `npm run check-types -w @morse/ui-runtime`
2. `npm run test -w @morse/ui-runtime`
3. `npm run build -w @morse/ui-angular` (its type-check) and `npm run test -w @morse/ui-angular`
4. `npm run build` and `npm run sync-webview`
5. `npm run test:fast`
6. A grep for stale relative imports of the moved basenames under `packages/ui-angular/src`
   returns nothing outside `registerTerminalLinks`'s intentional local use.

## Rollback

Each wave is a self-contained commit-ready change; `git revert` of a wave restores the previous
state. No data migration, no wire change, so rollback has no operational consequence.

## Risks

- **Duplicate `export *` name collision** in `ui-runtime/index.ts`. Mitigated by building
  `ui-runtime` at the end of wave 1; `tsc` fails loudly.
- **DOM specs under node env.** Mitigated by the explicit per-file jsdom docblock and by running
  `ui-runtime` tests before `ui-angular`'s.
- **Stale relative imports** in a file missed by the importer sweep. Mitigated by the grep in
  Verification step 6 and by `ui-angular`'s build, which fails on an unresolved import.
- **Eager root re-export pulls DOM libraries into the package graph.** `export * from
  './render/markdown.js'` means importing `@morse/ui-runtime` evaluates `dompurify`/`marked` at the
  module level. Every consumer is a frontend whose bundler tree-shakes unused exports, and every
  frontend already uses these libraries, so the effect is nominal. If it ever matters, subpath
  exports are the follow-up — deliberately out of scope here.
