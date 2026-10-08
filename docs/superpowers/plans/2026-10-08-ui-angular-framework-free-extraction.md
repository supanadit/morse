# Extract framework-free logic out of `@morse/ui-angular` into `@morse/ui-runtime` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every framework-free, reusable frontend helper out of `packages/ui-angular` into `packages/ui-runtime`, leaving `ui-angular` with only Angular/view-specific code.

**Architecture:** A pure relocation plus an import rewrite. Modules keep their code byte-for-byte except for relative import extensions (`.js`), and their specs move with them into `ui-runtime`'s vitest. New modules are re-exported from `ui-runtime`'s single public entry (`index.ts`), so every `ui-angular` consumer changes only its module specifier to `@morse/ui-runtime`.

**Tech Stack:** TypeScript (ESM, `module: NodeNext` for `ui-runtime`; `module: preserve` for `ui-angular`), vitest (+ jsdom), `marked`, `dompurify`, `highlight.js`.

**Spec:** `docs/superpowers/specs/2026-10-08-ui-angular-framework-free-extraction-design.md`

## Global Constraints

- **Never commit or push unless the user explicitly asked in the current turn** (root `AGENTS.md` hard rule). The "Checkpoint" steps below record what a commit *would* contain; do not run a commit unless asked.
- **No wire change, no `PROTOCOL_VERSION` bump.** Do not edit `@morse/protocol`, `@morse/core`, `@morse/host-runtime`, `@morse/adapter-pi-rpc`, `packages/extension`, `packages/server`.
- **No new package, no subpath exports.** The only public specifier is `@morse/ui-runtime`.
- **`ui-runtime` is ESM `NodeNext`**: every relative import inside a moved file or spec must carry the `.js` extension, and must use the new filename (e.g. `from './graph.js'`).
- **Dependency versions, verbatim:** `marked ^18.0.14`, `dompurify ^3.4.16`, `highlight.js ^11.12.0`, `jsdom ^30.0.0`.
- **Never edit generated output**: `packages/*/dist`, `packages/*/out`, `packages/extension/media/webview`, `dist/*.vsix`.
- **Merge rule for consumers:** when a consumer file already imports from `@morse/ui-runtime`, merge the moved binding into that existing statement and delete the now-empty import statement.
- A consumer's module specifier is the only thing that changes; the named bindings stay identical.
- **Locate imports by module specifier, not by the line numbers below.** The line numbers were captured before any edit, and earlier tasks edit the same consumer files (`file-preview.ts`, `chat-composer.ts`, `tool-group.ts`, `command-palette.ts`, `pin-annotation.ts`). Match each import by its current `from '…'` specifier, which is unique per moved module, then ignore the stale number.
- **A moved source file must satisfy `ui-runtime`'s `noUnusedLocals` / `noUnusedParameters`**, which `ui-angular` does not enable. If `check-types` flags a now-unused local or parameter in a moved file, delete it as dead code; do not add an underscore prefix or a suppression comment.

## Review Focus

These are the ways this refactor can look done but be wrong. Each is pinned by a step in the owning task.

1. **A moved spec stops running silently** (wrong path or missing extension) and the suite still reports green by running fewer files. Pinned by Task 1 Step 2 running the moved spec by its new path and expecting a non-zero, named test result.
2. **A `export *` name collision in `ui-runtime/index.ts`** breaks the shared package for every consumer. Pinned by Task 1 Step 5 (`check-types` on `ui-runtime`).
3. **A DOM spec runs under the node environment** where DOMPurify is a no-op, so the sanitization test (`markdown.spec.ts` "strips script markup") passes vacuously or fails obscurely. Pinned by Task 2 Step 6 and Task 4 Step 6 (`// @vitest-environment jsdom` + the test actually asserting `<script` is stripped).
4. **A consumer still resolving the old relative path** — the `ui-angular` build fails. Pinned by the `ng build` step in every task.
5. **`prompt/render.ts` lands in the eager bundle** instead of the lazily loaded prompt-editor chunk, regressing first paint. Pinned by Task 5 Step 5 inspecting `dist` chunk membership.

---

### Task 1: Pure git helpers (`git/`)

**Files:**
- Create (move): `packages/ui-runtime/src/git/graph.ts` ← `packages/ui-angular/src/app/core/git-graph.ts`
- Create (move): `packages/ui-runtime/src/git/status.ts` ← `packages/ui-angular/src/app/core/git-status.ts`
- Create (move): `packages/ui-runtime/src/git/diff.ts` ← `packages/ui-angular/src/app/chat/file-preview/git-diff.ts`
- Create (move): `packages/ui-runtime/src/git/graph.spec.ts`, `git/status.spec.ts`, `git/diff.spec.ts` (their specs)
- Modify: `packages/ui-runtime/src/index.ts`
- Modify: `packages/ui-angular/src/app/git/git-panel.ts:14,23`, `core/workspace-files.ts:3`, `chat/file-preview/file-preview.ts:19,46`, `nav/file-explorer/file-explorer.ts:13`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ui-runtime` exports `layoutGraph`, `GraphEdge`, `GraphRow`, `GraphY`, `GraphLayout` (from `git/graph.js`); `changeKind`, `isStaged`, `isUnstaged`, `stagedKind`, `unstagedKind`, `asGitStatus`, `asCommitFiles`, `statusByPath`, `ChangeKind` (from `git/status.js`); `parseUnifiedDiff`, `unifiedRows`, `splitRows`, `addedFileDiff`, `DiffRow`, `DiffHunk`, `ParsedDiff`, `UnifiedRow`, `SplitRow` (from `git/diff.js`).

- [ ] **Step 1: Move the three modules and their specs**

```bash
cd /home/supanadit/Workspaces/Personal/NodeJS/morse
mkdir -p packages/ui-runtime/src/git
git mv packages/ui-angular/src/app/core/git-graph.ts      packages/ui-runtime/src/git/graph.ts
git mv packages/ui-angular/src/app/core/git-graph.spec.ts packages/ui-runtime/src/git/graph.spec.ts
git mv packages/ui-angular/src/app/core/git-status.ts      packages/ui-runtime/src/git/status.ts
git mv packages/ui-angular/src/app/core/git-status.spec.ts packages/ui-runtime/src/git/status.spec.ts
git mv packages/ui-angular/src/app/chat/file-preview/git-diff.ts      packages/ui-runtime/src/git/diff.ts
git mv packages/ui-angular/src/app/chat/file-preview/git-diff.spec.ts packages/ui-runtime/src/git/diff.spec.ts
```

- [ ] **Step 2: Fix the relative import inside each moved spec and run it**

In `git/graph.spec.ts` change `from './git-graph'` → `from './graph.js'`; in `git/status.spec.ts` change `from './git-status'` → `from './status.js'`; in `git/diff.spec.ts` change `from './git-diff'` → `from './diff.js'`.

Run: `npm run test -w @morse/ui-runtime -- src/git`
Expected: 3 spec files run, all pass (the modules are self-contained; the code is unchanged).

- [ ] **Step 3: Re-export from the public entry**

Add to `packages/ui-runtime/src/index.ts`:

```ts
export * from './git/graph.js';
export * from './git/status.js';
export * from './git/diff.js';
```

- [ ] **Step 4: Rewrite the `ui-angular` importers**

| File | Line | Change |
| --- | --- | --- |
| `app/git/git-panel.ts` | 14 | specifier `'../core/git-graph'` → `'@morse/ui-runtime'` |
| `app/git/git-panel.ts` | 23 | specifier `'../core/git-status'` → `'@morse/ui-runtime'`, merge |
| `app/core/workspace-files.ts` | 3 | specifier `'./git-status'` → `'@morse/ui-runtime'` |
| `app/chat/file-preview/file-preview.ts` | 19 | specifier `'../../core/git-status'` → `'@morse/ui-runtime'`, merge |
| `app/chat/file-preview/file-preview.ts` | 46 | specifier `'./git-diff'` → `'@morse/ui-runtime'`, merge |
| `app/nav/file-explorer/file-explorer.ts` | 13 | specifier `'../../core/git-status'` → `'@morse/ui-runtime'` |

- [ ] **Step 5: Type-check `ui-runtime` and build `ui-angular`**

Run: `npm run check-types -w @morse/ui-runtime && npm run build -w @morse/ui-angular`
Expected: both succeed. A duplicate export name fails `check-types` here (Review Focus 2).

- [ ] **Step 6: Run both test suites**

Run: `npm run test -w @morse/ui-runtime && npm run test -w @morse/ui-angular`
Expected: all pass; the `ui-angular` suite no longer contains the 3 moved specs.

- [ ] **Step 7: Checkpoint**

Commit message if asked: `refactor(ui-runtime): move the pure git helpers out of ui-angular`. Do not commit unless the user asked this turn.

---

### Task 2: Pure files + transcript helpers (`files/`, `transcript/`) and the jsdom setup

**Files:**
- Create (move): `packages/ui-runtime/src/files/tree.ts` ← `core/file-tree.ts`; `files/positions.ts` ← `chat/file-preview/preview-positions.ts`
- Create (move): `packages/ui-runtime/src/transcript/rows.ts` ← `chat/transcript-rows.ts`; `transcript/tasks.ts` ← `core/task-list.ts`; `transcript/tools.ts` ← `core/tool-describe.ts`; `transcript/usage.ts` ← `core/usage-format.ts`
- Create (move): their six specs
- Modify: `packages/ui-runtime/src/index.ts`, `packages/ui-runtime/package.json` (devDep `jsdom`)
- Modify: `packages/ui-angular/src/app/chat/file-preview/preview-positions.spec.ts` (jsdom docblock) — becomes `files/positions.spec.ts`
- Modify (importers): `chat/tab-strip/tab-strip.ts:11`, `nav/file-explorer/file-explorer.ts:12`, `chat/file-preview/file-preview.ts:28,37`, `chat/chat-transcript/chat-transcript.ts:9`, `chat/chat-composer/chat-composer.ts:30`, `chat/tool-group/tool-group.ts:15,23,25`, `chat/tool-group/task-board.ts:2`, `chat/task-overlay/task-overlay.ts:10`, `nav/session-nav/session-nav.ts:16`, `chat/usage/usage-indicator.ts:9`, `chat/model-picker/model-picker.ts:17`, `palette/command-palette.ts:14`

**Interfaces:**
- Consumes: `ui-runtime` public entry from Task 1.
- Produces: `buildFileTree`, `fileGlyph`, `FileNode` (`files/tree.js`); `offsetAt`, `pointAt`, `identifierAt`, `sourceOffsetIn`, `domRangeFor`, `SourcePoint`, `SourceSpan` (`files/positions.js`); `groupTranscriptItems`, `activeProcessKey`, `splitMentionTokens`, `parseMentionToken`, `userMessageMarkdown`, `pinNoteHint`, `ProcessStep`, `TranscriptRow`, `MentionSegment` (`transcript/rows.js`); `asTaskList`, `taskCounts`, `sessionTaskList`, `TaskRow`, `TaskStatus`, `TaskCounts`, `SessionTaskList` (`transcript/tasks.js`); `toolKind`, `toolVerb`, `toolGerund`, `toolGlyph`, `toolTitle`, `toolFileName`, `toolChangedFile`, `ToolKind` (`transcript/tools.js`); `formatTokens`, `formatUsageValue`, `cacheHitRate`, `formatCost`, `contextPercent`, `formatUsage` (`transcript/usage.js`).

- [ ] **Step 1: Move the modules and specs**

```bash
cd /home/supanadit/Workspaces/Personal/NodeJS/morse
mkdir -p packages/ui-runtime/src/files packages/ui-runtime/src/transcript
git mv packages/ui-angular/src/app/core/file-tree.ts            packages/ui-runtime/src/files/tree.ts
git mv packages/ui-angular/src/app/core/file-tree.spec.ts       packages/ui-runtime/src/files/tree.spec.ts
git mv packages/ui-angular/src/app/chat/file-preview/preview-positions.ts      packages/ui-runtime/src/files/positions.ts
git mv packages/ui-angular/src/app/chat/file-preview/preview-positions.spec.ts packages/ui-runtime/src/files/positions.spec.ts
git mv packages/ui-angular/src/app/chat/transcript-rows.ts       packages/ui-runtime/src/transcript/rows.ts
git mv packages/ui-angular/src/app/chat/transcript-rows.spec.ts  packages/ui-runtime/src/transcript/rows.spec.ts
git mv packages/ui-angular/src/app/core/task-list.ts             packages/ui-runtime/src/transcript/tasks.ts
git mv packages/ui-angular/src/app/core/task-list.spec.ts        packages/ui-runtime/src/transcript/tasks.spec.ts
git mv packages/ui-angular/src/app/core/tool-describe.ts         packages/ui-runtime/src/transcript/tools.ts
git mv packages/ui-angular/src/app/core/tool-describe.spec.ts    packages/ui-runtime/src/transcript/tools.spec.ts
git mv packages/ui-angular/src/app/core/usage-format.ts          packages/ui-runtime/src/transcript/usage.ts
git mv packages/ui-angular/src/app/core/usage-format.spec.ts     packages/ui-runtime/src/transcript/usage.spec.ts
```

- [ ] **Step 2: Fix the relative specifier in each moved spec**

`files/tree.spec.ts`: `./file-tree` → `./tree.js`. `files/positions.spec.ts`: `./preview-positions` → `./positions.js`. `transcript/rows.spec.ts`: `./transcript-rows` → `./rows.js`. `transcript/tasks.spec.ts`: `./task-list` → `./tasks.js`. `transcript/tools.spec.ts`: `./tool-describe` → `./tools.js`. `transcript/usage.spec.ts`: `./usage-format` → `./usage.js`.

- [ ] **Step 3: Add `jsdom` and the DOM-environment docblock**

Add `"jsdom": "^30.0.0"` to `devDependencies` in `packages/ui-runtime/package.json`, then run `npm install` at the repo root. At the very top of `packages/ui-runtime/src/files/positions.spec.ts`, before any import, add:

```ts
// @vitest-environment jsdom
```

- [ ] **Step 4: Re-export from the public entry**

Add to `packages/ui-runtime/src/index.ts`:

```ts
export * from './files/tree.js';
export * from './files/positions.js';
export * from './transcript/rows.js';
export * from './transcript/tasks.js';
export * from './transcript/tools.js';
export * from './transcript/usage.js';
```

- [ ] **Step 5: Rewrite the `ui-angular` importers to `'@morse/ui-runtime'`**

Change the module specifier only, and merge into an existing `@morse/ui-runtime` statement where one exists:

- `files/tree`: `chat/tab-strip/tab-strip.ts:11`, `nav/file-explorer/file-explorer.ts:12`
- `files/positions`: `chat/file-preview/file-preview.ts:37`
- `transcript/rows`: `chat/chat-transcript/chat-transcript.ts:9`, `chat/chat-composer/chat-composer.ts:30`, `chat/tool-group/tool-group.ts:25`, `chat/file-preview/file-preview.ts:28`
- `transcript/tasks`: `chat/tool-group/tool-group.ts:15`, `chat/tool-group/task-board.ts:2`, `chat/task-overlay/task-overlay.ts:10`
- `transcript/tools`: `chat/tool-group/tool-group.ts:23`, `nav/session-nav/session-nav.ts:16`
- `transcript/usage`: `chat/usage/usage-indicator.ts:9`, `chat/model-picker/model-picker.ts:17`, `palette/command-palette.ts:14`

- [ ] **Step 6: Run the moved DOM spec and confirm jsdom is active**

Run: `npm run test -w @morse/ui-runtime -- src/files/positions.spec.ts`
Expected: pass, with `domRangeFor` assertions reading real `Range` values. If the docblock is missing, `document.createElement` is undefined and the spec errors (Review Focus 3).

- [ ] **Step 7: Type-check, build and test**

Run: `npm run check-types -w @morse/ui-runtime && npm run test -w @morse/ui-runtime && npm run build -w @morse/ui-angular && npm run test -w @morse/ui-angular`
Expected: all pass.

- [ ] **Step 8: Checkpoint**

Commit message if asked: `refactor(ui-runtime): move the pure files and transcript helpers out of ui-angular`. Do not commit unless asked.

---

### Task 3: Pure command/validation helpers (`palette/`, `lsp/`, `ui/placement.ts`)

**Files:**
- Create (move): `packages/ui-runtime/src/palette/commands.ts` ← `core/palette.ts`; `lsp/guards.ts` ← `core/lsp.ts`; `ui/placement.ts` ← `chat/pin-annotation/placement.ts`
- Create (move): their three specs
- Modify: `packages/ui-runtime/src/index.ts`
- Modify (importers): `palette/command-palette.ts:27`, `chat/file-preview/file-preview.ts:21,27`, `chat/chat-composer/chat-composer.ts:43`, `chat/pin-annotation/note-hover.directive.ts:22`, `chat/pin-annotation/note-hover.ts:22`, `chat/pin-annotation/pin-annotation.ts:30`

**Interfaces:**
- Consumes: `ui-runtime` public entry from Tasks 1–2.
- Produces: `parsePaletteQuery`, `scorePaletteEntry`, `paletteGroups`, `PaletteKind`, `PaletteEntry`, `PaletteQuery`, `PaletteGroup` (`palette/commands.js`); `asPosition`, `asRange`, `asHover`, `asLocation`, `asReferences`, `asDiagnostics` (`lsp/guards.js`); `placePopover`, `PopoverAnchor`, `PopoverSize`, `PopoverViewport`, `PopoverSpot` (`ui/placement.js`).

- [ ] **Step 1: Move the modules and specs**

```bash
cd /home/supanadit/Workspaces/Personal/NodeJS/morse
mkdir -p packages/ui-runtime/src/palette packages/ui-runtime/src/lsp packages/ui-runtime/src/ui
git mv packages/ui-angular/src/app/core/palette.ts          packages/ui-runtime/src/palette/commands.ts
git mv packages/ui-angular/src/app/core/palette.spec.ts     packages/ui-runtime/src/palette/commands.spec.ts
git mv packages/ui-angular/src/app/core/lsp.ts              packages/ui-runtime/src/lsp/guards.ts
git mv packages/ui-angular/src/app/core/lsp.spec.ts         packages/ui-runtime/src/lsp/guards.spec.ts
git mv packages/ui-angular/src/app/chat/pin-annotation/placement.ts      packages/ui-runtime/src/ui/placement.ts
git mv packages/ui-angular/src/app/chat/pin-annotation/placement.spec.ts packages/ui-runtime/src/ui/placement.spec.ts
```

- [ ] **Step 2: Fix the relative specifier in each moved spec**

`palette/commands.spec.ts`: `./palette` → `./commands.js`. `lsp/guards.spec.ts`: `./lsp` → `./guards.js`. `ui/placement.spec.ts`: `./placement` → `./placement.js`.

- [ ] **Step 3: Re-export from the public entry**

Add to `packages/ui-runtime/src/index.ts`:

```ts
export * from './palette/commands.js';
export * from './lsp/guards.js';
export * from './ui/placement.js';
```

- [ ] **Step 4: Rewrite the `ui-angular` importers to `'@morse/ui-runtime'`**

- `palette/commands`: `palette/command-palette.ts:27`
- `lsp/guards`: `chat/file-preview/file-preview.ts:21`
- `ui/placement`: `chat/chat-composer/chat-composer.ts:43`, `chat/file-preview/file-preview.ts:27`, `chat/pin-annotation/note-hover.directive.ts:22`, `chat/pin-annotation/note-hover.ts:22`, `chat/pin-annotation/pin-annotation.ts:30`

- [ ] **Step 5: Type-check, build and test**

Run: `npm run check-types -w @morse/ui-runtime && npm run test -w @morse/ui-runtime && npm run build -w @morse/ui-angular && npm run test -w @morse/ui-angular`
Expected: all pass.

- [ ] **Step 6: Checkpoint**

Commit message if asked: `refactor(ui-runtime): move the palette, lsp and placement helpers out of ui-angular`. Do not commit unless asked.

---

### Task 4: Render helpers (`render/`) and the render dependencies

**Files:**
- Create (move): `packages/ui-runtime/src/render/highlight.ts` ← `core/highlight.ts`; `render/markdown.ts` ← `core/markdown.ts`; `render/annotation-mirror.ts` ← `chat/pin-annotation/mirror.ts`
- Create (move): their three specs
- Modify: `packages/ui-runtime/src/render/markdown.ts` (internal import), `packages/ui-runtime/src/index.ts`, `packages/ui-runtime/package.json` (`dependencies`), `packages/ui-angular/package.json` (drop the three render dependencies)
- Modify: `packages/ui-runtime/src/render/markdown.spec.ts` (cross-module import + jsdom docblock)
- Modify (importers): `shared/markdown/markdown.ts:14`, `core/workspace-tabs.ts:2`, `chat/file-preview/file-preview.ts:20`, `chat/pin-annotation/pin-annotation.ts:29`

**Interfaces:**
- Consumes: `ui-runtime` public entry from Tasks 1–3.
- Produces: `languageForPath`, `highlightCode`, `escapeHtml`, `HighlightedCode` (`render/highlight.js`); `renderMarkdown`, `renderUserMarkdown` (`render/markdown.js`); `renderAnnotationMirror` (`render/annotation-mirror.js`).

- [ ] **Step 1: Move the modules and specs**

```bash
cd /home/supanadit/Workspaces/Personal/NodeJS/morse
mkdir -p packages/ui-runtime/src/render
git mv packages/ui-angular/src/app/core/highlight.ts            packages/ui-runtime/src/render/highlight.ts
git mv packages/ui-angular/src/app/core/highlight.spec.ts       packages/ui-runtime/src/render/highlight.spec.ts
git mv packages/ui-angular/src/app/core/markdown.ts             packages/ui-runtime/src/render/markdown.ts
git mv packages/ui-angular/src/app/core/markdown.spec.ts        packages/ui-runtime/src/render/markdown.spec.ts
git mv packages/ui-angular/src/app/chat/pin-annotation/mirror.ts      packages/ui-runtime/src/render/annotation-mirror.ts
git mv packages/ui-angular/src/app/chat/pin-annotation/mirror.spec.ts packages/ui-runtime/src/render/annotation-mirror.spec.ts
```

- [ ] **Step 2: Fix the internal and spec imports**

In `render/markdown.ts`: `from './highlight'` → `from './highlight.js'` (this is the one relative import in a moved source). In `render/highlight.spec.ts`: `./highlight` → `./highlight.js`. In `render/annotation-mirror.spec.ts`: `./mirror` → `./annotation-mirror.js`. In `render/markdown.spec.ts`: `./markdown` → `./markdown.js` **and** `'../chat/transcript-rows'` → `'../transcript/rows.js'`.

- [ ] **Step 3: Move the three render dependencies from `ui-angular` to `ui-runtime`**

`core/markdown.ts` and `core/highlight.ts` were the only files in the workspace importing these libraries directly; both have now moved. In `packages/ui-runtime/package.json` `dependencies` add (exact ranges):

```json
"marked": "^18.0.14",
"dompurify": "^3.4.16",
"highlight.js": "^11.12.0",
```

Then remove those same three entries from the `dependencies` block of `packages/ui-angular/package.json`. `ui-runtime` declares them and `ui-angular` reaches them transitively, so nothing else changes; `about/credits.spec.ts` scans every workspace manifest, so it stays green. This is the one deliberate deviation from the spec, whose text assumed `ui-angular` still used the libraries directly.

Run `npm install` at the repo root.

- [ ] **Step 4: Add the jsdom docblock to the markdown spec**

At the very top of `packages/ui-runtime/src/render/markdown.spec.ts`, before any import, add:

```ts
// @vitest-environment jsdom
```

- [ ] **Step 5: Re-export from the public entry**

Add to `packages/ui-runtime/src/index.ts`:

```ts
export * from './render/highlight.js';
export * from './render/markdown.js';
export * from './render/annotation-mirror.js';
```

- [ ] **Step 6: Run the markdown spec and confirm the sanitizer is live**

Run: `npm run test -w @morse/ui-runtime -- src/render/markdown.spec.ts`
Expected: pass, including "strips script markup from untrusted text" (`renderMarkdown('<script>…')` does not contain `<script`). Under the node environment DOMPurify is a no-op and this is the test that catches it (Review Focus 3).

- [ ] **Step 7: Rewrite the `ui-angular` importers to `'@morse/ui-runtime'`**

- `render/markdown`: `shared/markdown/markdown.ts:14` (was `'../../core/markdown'`)
- `render/highlight`: `core/workspace-tabs.ts:2`; `chat/file-preview/file-preview.ts:20`
- `render/annotation-mirror`: `chat/pin-annotation/pin-annotation.ts:29`

- [ ] **Step 8: Type-check, build and test**

Run: `npm run check-types -w @morse/ui-runtime && npm run test -w @morse/ui-runtime && npm run build -w @morse/ui-angular && npm run test -w @morse/ui-angular`
Expected: all pass.

- [ ] **Step 9: Checkpoint**

Commit message if asked: `refactor(ui-runtime): move the markdown and highlight render helpers out of ui-angular`. Do not commit unless asked.

---

### Task 5: Prompt-template renderer (`prompt/render.ts`) and its lazy-chunk check

**Files:**
- Create (move): `packages/ui-runtime/src/prompt/render.ts` ← `chat/prompt-editor/render.ts`
- Create (move): `packages/ui-runtime/src/prompt/render.spec.ts` ← `chat/prompt-editor/render.spec.ts`
- Modify: `packages/ui-runtime/src/prompt/render.ts` (stale doc comment), `packages/ui-runtime/src/index.ts`
- Modify (importer): `chat/prompt-editor/prompt-editor.ts:24`

**Interfaces:**
- Consumes: `ui-runtime` public entry from Tasks 1–4. The spec already imports `readPromptTemplate` from `@morse/ui-runtime`.
- Produces: `renderPromptTemplate`, `PromptTemplateDraft` (`prompt/render.js`).

- [ ] **Step 1: Move the module and spec**

```bash
cd /home/supanadit/Workspaces/Personal/NodeJS/morse
mkdir -p packages/ui-runtime/src/prompt
git mv packages/ui-angular/src/app/chat/prompt-editor/render.ts      packages/ui-runtime/src/prompt/render.ts
git mv packages/ui-angular/src/app/chat/prompt-editor/render.spec.ts packages/ui-runtime/src/prompt/render.spec.ts
```

- [ ] **Step 2: Fix the specifier and the stale comment**

In `packages/ui-runtime/src/prompt/render.spec.ts`: `'./render'` → `'./render.js'`.

In `packages/ui-runtime/src/prompt/render.ts`, replace the doc paragraph that begins "It lives here, not in `@morse/ui-runtime`, because only the editor writes a file back" with one sentence stating it now lives here as the shared inverse of `prompt-template.ts`'s expansion, imported by the lazily loaded editor. The claim "keeping it in the editor's lazy chunk keeps it out of the initial bundle" is what Step 5 verifies, so leave the bundling rationale out of the comment.

- [ ] **Step 3: Re-export from the public entry**

Add to `packages/ui-runtime/src/index.ts`:

```ts
export * from './prompt/render.js';
```

- [ ] **Step 4: Rewrite the `ui-angular` importer**

`chat/prompt-editor/prompt-editor.ts:24`: specifier `'./render'` → `'@morse/ui-runtime'`, merged into the existing `@morse/ui-runtime` statement at line 19.

- [ ] **Step 5: Build and confirm the renderer stays in the lazy chunk**

Run: `npm run test -w @morse/ui-runtime` (the moved spec passes) then `npm run build -w @morse/ui-angular`.

Then inspect `packages/ui-angular/dist`: locate the JS files referenced by `dist/index.html` (the eager entry chunk(s)) and confirm the string `argument-hint` (a frontmatter key emitted only by `renderPromptTemplate`) appears **only** in a lazily loaded chunk, not in those entry files. If it appears in an entry chunk, stop and report (Review Focus 5).

- [ ] **Step 6: Full type-check, build and test**

Run: `npm run check-types -w @morse/ui-runtime && npm run build -w @morse/ui-angular && npm run test -w @morse/ui-angular`
Expected: all pass.

- [ ] **Step 7: Checkpoint**

Commit message if asked: `refactor(ui-runtime): move the prompt-template renderer out of ui-angular`. Do not commit unless asked.

---

### Task 6: Split terminal link detection (`terminal/links.ts`)

**Files:**
- Create: `packages/ui-runtime/src/terminal/links.ts` (pure half: `TerminalLink`, `findTerminalLinks`, `trimTrailing`)
- Create (move + edit): `packages/ui-runtime/src/terminal/links.spec.ts` ← `chat/terminal/terminal-links.spec.ts`
- Delete (after split): `packages/ui-angular/src/app/chat/terminal/terminal-links.spec.ts`
- Modify: `packages/ui-angular/src/app/chat/terminal/terminal-links.ts` (keep only `registerTerminalLinks`; import `findTerminalLinks` from `@morse/ui-runtime`)
- Modify: `packages/ui-runtime/src/index.ts`

**Interfaces:**
- Consumes: `ui-runtime` public entry from Tasks 1–5.
- Produces: `TerminalLink`, `findTerminalLinks` (`terminal/links.js`). `ui-angular` keeps `registerTerminalLinks` locally, so it is not a new public export.

- [ ] **Step 1: Create the pure module**

`packages/ui-runtime/src/terminal/links.ts` contains exactly the current `TerminalLink` interface, `URL_PATTERN`, `TRAILING`, `findTerminalLinks` and `trimTrailing` — copied byte-for-byte from `chat/terminal/terminal-links.ts`, with the xterm `import type` line removed.

- [ ] **Step 2: Move and adjust the spec**

```bash
cd /home/supanadit/Workspaces/Personal/NodeJS/morse
mkdir -p packages/ui-runtime/src/terminal
git mv packages/ui-angular/src/app/chat/terminal/terminal-links.spec.ts packages/ui-runtime/src/terminal/links.spec.ts
```

In it, change `from './terminal-links'` → `from './links.js'`.

Run: `npm run test -w @morse/ui-runtime -- src/terminal/links.spec.ts`
Expected: pass.

- [ ] **Step 3: Reduce the `ui-angular` file to the xterm binding**

In `packages/ui-angular/src/app/chat/terminal/terminal-links.ts` delete the pure half, keep the `import type` from `@xterm/xterm`, keep `registerTerminalLinks`, and add `import { findTerminalLinks } from '@morse/ui-runtime';`. `chat/terminal/terminal.ts:17` still imports `registerTerminalLinks` from `'./terminal-links'` and is not touched.

- [ ] **Step 4: Re-export from the public entry**

Add to `packages/ui-runtime/src/index.ts`:

```ts
export * from './terminal/links.js';
```

- [ ] **Step 5: Type-check, build and test**

Run: `npm run check-types -w @morse/ui-runtime && npm run test -w @morse/ui-runtime && npm run build -w @morse/ui-angular && npm run test -w @morse/ui-angular`
Expected: all pass.

- [ ] **Step 6: Checkpoint**

Commit message if asked: `refactor(ui-runtime): share terminal link detection, keep the xterm binding in ui-angular`. Do not commit unless asked.

---

### Task 7: Update the documentation and run the full verification

**Files:**
- Modify: `packages/ui-runtime/AGENTS.md`
- Modify: `packages/ui-angular/AGENTS.md`
- Modify: `docs/FRONTENDS.md`
- Modify: `AGENTS.md` (root)
- Modify: `docs/ARCHITECTURE.md` (only if it cites a moved path)

**Interfaces:**
- Consumes: the final public entry assembled by Tasks 1–6.
- Produces: documentation that matches the tree.

- [ ] **Step 1: Update `packages/ui-runtime/AGENTS.md`**

Extend the "Path / Holds" table with the new domain folders (`git/`, `files/`, `transcript/`, `palette/`, `lsp/`, `render/`, `prompt/render.ts`, `ui/`, `terminal/`) and one line each on what they hold. Add to Code style: a framework-free frontend helper belongs here, not in a UI package; relative imports carry `.js`; a DOM spec carries `// @vitest-environment jsdom`.

- [ ] **Step 2: Update `packages/ui-angular/AGENTS.md`**

Remove the moved modules from the `src/app/core/` description and from the "When stuck" paths; point those references at `@morse/ui-runtime`. Leave the app-local state entries and the `core/markdown.ts` — sanitization note as applied to `@morse/ui-runtime`'s `render/markdown.ts` (the view must still route rendered HTML through it).

- [ ] **Step 3: Update `docs/FRONTENDS.md`**

In "Reusable pieces", note that `@morse/ui-runtime` now also carries the framework-free git, file, transcript, palette, lsp, render, prompt and terminal-link helpers. Update every cited moved path (for example `core/git-graph.ts` → `@morse/ui-runtime`) in the Rules and browser-host sections. Keep rule 6's DOMPurify statement true by naming `render/markdown.ts` in `ui-runtime`.

- [ ] **Step 4: Update the root `AGENTS.md` "Where new code goes"**

Add a row: a framework-free, frontend-reusable helper goes to `packages/ui-runtime`.

- [ ] **Step 5: Update `docs/ARCHITECTURE.md` if it cites a moved path**

Run: `grep -rn "core/git-graph\|core/git-status\|core/file-tree\|core/task-list\|core/tool-describe\|core/usage-format\|core/palette\|core/lsp\|core/markdown\|core/highlight\|chat/file-preview/git-diff\|chat/transcript-rows" docs/ARCHITECTURE.md`
If it prints anything, repoint those citations at `@morse/ui-runtime`; otherwise skip.

- [ ] **Step 6: Confirm no stale import remains in `ui-angular`**

Run: `grep -rnE "from '[^']*/(git-graph|git-status|git-diff|file-tree|preview-positions|transcript-rows|task-list|tool-describe|usage-format|palette|lsp|markdown|highlight|mirror|placement|terminal-links)'" packages/ui-angular/src --include=*.ts`
Expected: only `app/chat/terminal/terminal.ts` importing `registerTerminalLinks` from `'./terminal-links'` may appear (that is the intentional local binding from Task 6); otherwise the output is empty.

- [ ] **Step 7: Full build, tests and manifest sync**

Run: `npm run build && npm run test:fast && npm run sync-webview`
Expected: all pass. No `PROTOCOL_VERSION` change was made, so the manifest stays compatible.

- [ ] **Step 8: Checkpoint**

Commit message if asked: `docs(ui): record the framework-free helpers now living in ui-runtime`. Do not commit unless asked.
