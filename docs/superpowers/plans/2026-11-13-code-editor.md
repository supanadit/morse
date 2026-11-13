# Code Editor and LSP Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the browser host's static file preview with a read-only CodeMirror 6 editor carrying openidea's comfort behaviours, redesign pinning into margin note cards, and delete LSP from the product.

**Architecture:** A new `ui/code-editor` component owns a CM6 `EditorView` plus an Angular note rail beside it; `features/file-preview` loads it through an injection token (lazy chunk), keeps its diff modes on highlight.js, and delegates every pin action to `AttachmentStore`. LSP is removed from the frontend, the wire and the server, in that order, so each commit type-checks.

**Tech Stack:** Angular 22 (standalone, signals, OnPush), CodeMirror 6 (`@codemirror/*` 6.x, `@lezer/highlight` 1.2), vitest + jsdom, NestJS host, TypeScript.

**Spec:** `docs/superpowers/specs/2026-11-13-code-editor-design.md` (read it before Task 1; the plan argues from it).

## Global Constraints

- Editor is **read-only**: `EditorState.readOnly.of(true)` and `EditorView.editable.of(false)`. No `writeFile`, no dirty state.
- Initial JS is ~1.24 MB against `maximumError` 1.3 MB in `packages/ui-angular/angular.json`. Every CM import must sit behind a dynamic `import()`; nothing from `@codemirror/*` may be imported by a file reachable from `main`.
- `packages/ui-angular/src/app/shell/conventions.spec.ts` rules: styles/templates in their own files; imports only to the same layer or right (`routing → shell → features → ui → services → state → host`); only `shell`/`routing` may reach two features; host seam imports nothing else.
- `anyComponentStyle` budget: warn 12 kB, error 16 kB.
- openidea is Apache-2.0, port pinned to commit `835c44615b0aa847d8aa8461a5d3f812ff8c8919` (v0.1.43). Every ported file keeps its header plus a line naming the upstream path and that commit. `NOTICE` is **created** at repo root.
- CM package versions (from that snapshot, latest patch): `@codemirror/state` 6.7.6, `view` 6.43.15, `language` 6.13.1, `commands` 6.11.1, `search` 6.7.2, `@lezer/highlight` 1.2.5; grammars `lang-javascript` 6.2.5, `lang-json` 6.0.2, `lang-html` 6.4.12, `lang-css` 6.3.1, `lang-markdown` 6.5.2, `lang-python` 6.2.1, `lang-rust` 6.0.2, `lang-go` 6.0.1, `lang-java` 6.0.2, `lang-sql` 6.10.0, `lang-yaml` 6.1.3, `lang-xml` 6.1.0. All go in `packages/ui-angular/package.json`.
- No workers, no WASM, no network at runtime.
- Tests: `cd packages/ui-angular && npx ng test --include <path> --watch=false`; `cd packages/ui-runtime && npx vitest run <path>`; `cd packages/server && npx vitest run <path>`. `npm run test:fast` from the root must pass before the final handoff.
- Read-only CM means every ported extension that edits text is dropped, not stubbed: no `indentOnInput`, no `closeBrackets`, no smart keys, no completion.

## Review Focus

1. **A grammar chunk that fails to load** (cache miss, offline) — the file must still show as plain text, never a blank pane or a thrown rejection.
2. **A path with no extension or a dotfile** (`Makefile`, `.env`, `LICENSE`) — plain text, no exception, no bad grammar guess.
3. **A pin on a folded or scrolled-away line** — its card must hide (or clamp), never float beside the wrong line.
4. **Many pins on a truncated huge file** (200 ranges) — rail placement must stay linear and cards must not overlap.
5. **A selection over emoji or a soft-wrap boundary** — columns and `characters` must count UTF-16 units correctly and the pin must round-trip through the chip label.

---

### Task 1: CodeMirror dependencies and the grammar registry

**Files:**
- Modify: `packages/ui-angular/package.json`
- Create: `packages/ui-angular/src/app/ui/code-editor/languages.ts`
- Test: `packages/ui-angular/src/app/ui/code-editor/languages.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type GrammarLoader = () => Promise<LanguageSupport | null>;
  export function extensionOf(path: string): string;
  export function grammarFor(path: string): GrammarLoader | null;
  export function loadLanguage(path: string): Promise<LanguageSupport | null>;
  ```

- [ ] **Step 1: Install the dependencies**

```bash
cd packages/ui-angular
npm i @codemirror/state@6.7.6 @codemirror/view@6.43.15 @codemirror/language@6.13.1 \
  @codemirror/commands@6.11.1 @codemirror/search@6.7.2 @lezer/highlight@1.2.5 \
  @codemirror/lang-javascript@6.2.5 @codemirror/lang-json@6.0.2 @codemirror/lang-html@6.4.12 \
  @codemirror/lang-css@6.3.1 @codemirror/lang-markdown@6.5.2 @codemirror/lang-python@6.2.1 \
  @codemirror/lang-rust@6.0.2 @codemirror/lang-go@6.0.1 @codemirror/lang-java@6.0.2 \
  @codemirror/lang-sql@6.10.0 @codemirror/lang-yaml@6.1.3 @codemirror/lang-xml@6.1.0
```
Run from the repo root afterwards: `npm ls @codemirror/state` — expected: exactly one version.

- [ ] **Step 2: Write the failing test**

`languages.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { extensionOf, grammarFor, loadLanguage } from './languages';

describe('extensionOf', () => {
  it('lowercases the extension', () => expect(extensionOf('src/A.TSX')).toBe('tsx'));
  it('returns empty for a dotfile', () => expect(extensionOf('/repo/.env')).toBe(''));
  it('returns empty for an extensionless path', () => expect(extensionOf('/repo/Makefile')).toBe(''));
  it('reads the last dot only', () => expect(extensionOf('a.test.ts')).toBe('ts'));
});

describe('grammarFor', () => {
  it('maps a known extension', () => expect(grammarFor('a.rs')).not.toBeNull());
  it('returns null for an unknown one', () => expect(grammarFor('a.txt')).toBeNull());
  it('returns null for a dotfile', () => expect(grammarFor('.env')).toBeNull());
});

describe('loadLanguage', () => {
  it('resolves a language for a mapped path', async () => {
    expect(await loadLanguage('a.py')).not.toBeNull();
  });
  it('resolves null for an unmapped path', async () => {
    expect(await loadLanguage('a.txt')).toBeNull();
  });
  it('resolves null when the loader rejects (Review Focus 1)', async () => {
    expect(await loadLanguage('a.rs', () => Promise.reject(new Error('offline')))).toBeNull();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

`cd packages/ui-angular && npx ng test --include src/app/ui/code-editor/languages.spec.ts --watch=false`
Expected: FAIL — cannot resolve `./languages`.

- [ ] **Step 4: Implement `languages.ts`**

`extensionOf` returns the lowercased text after the last dot when that dot is not index 0; otherwise `''`. `grammarFor` is a module-level `Record<string, GrammarLoader>` where each loader is `() => import(...).then(m => m.x())`. Mapping, exactly:

| extensions | loader body |
| --- | --- |
| `ts tsx js jsx mjs cjs` | `javascript({ typescript: true, jsx: true })` |
| `json` | `json()` |
| `html htm vue svelte` | `html()` |
| `css scss sass less` | `css()` |
| `md mdx` | `markdown()` |
| `py` | `python()` |
| `rs` | `rust()` |
| `go` | `go()` |
| `java kt kts` | `java()` |
| `sql` | `sql()` |
| `yaml yml` | `yaml()` |
| `xml svg plist` | `xml()` |

`loadLanguage(path, load = grammarFor(path))` returns `null` when `load` is null, else `await load().catch(() => null)`. The optional second parameter exists so the rejection case is testable; the component calls it with one argument.

- [ ] **Step 5: Run the test and confirm it passes**

Same command. Expected: PASS, six extensions and six loader cases.

- [ ] **Step 6: Confirm nothing loaded eagerly**

`cd packages/ui-angular && npx ng build 2>&1 | tail -20`
Expected: build succeeds and no `@codemirror` package appears in the initial chunk (the only importer so far is a spec). Note the initial size for Task 10's comparison.

- [ ] **Step 7: Commit**

```bash
git add packages/ui-angular/package.json package-lock.json packages/ui-angular/src/app/ui/code-editor/
git commit -m "feat(ui): add CodeMirror and the lazy grammar registry"
```

---

### Task 2: The pin model and selection math

**Files:**
- Create: `packages/ui-angular/src/app/ui/code-editor/pins.ts`
- Create: `packages/ui-angular/src/app/ui/code-editor/pin-selection.ts`
- Test: `packages/ui-angular/src/app/ui/code-editor/pins.spec.ts`
- Test: `packages/ui-angular/src/app/ui/code-editor/pin-selection.spec.ts`

**Interfaces:**
- Consumes: `PendingPin` from `../../../state/attachments` (fields `id, path, startLine?, endLine?, startColumn?, endColumn?, characters?, text?, note?`).
- Produces:
  ```ts
  export interface EditorPin {
    readonly id: string;
    readonly startLine: number;
    readonly endLine?: number;
    readonly startColumn?: number;
    readonly endColumn?: number;
    readonly note?: string;
  }
  export function editorPins(pins: readonly PendingPin[], path: string): EditorPin[];

  export interface PinRequest {
    startLine: number;
    endLine?: number;
    startColumn?: number;
    endColumn?: number;
    characters?: number;
    text?: string;
  }
  export function pinFromOffsets(
    text: string,
    from: number,
    to: number,
    options?: { lineOnly?: boolean },
  ): PinRequest | null;
  ```

- [ ] **Step 1: Write the failing tests**

`pins.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { editorPins } from './pins';
import type { PendingPin } from '../../../state/attachments';

const pin = (over: Partial<PendingPin>): PendingPin => ({ id: 'p', path: 'a.ts', ...over } as PendingPin);

describe('editorPins', () => {
  it('keeps only this file and sorts by line', () => {
    const out = editorPins(
      [pin({ id: 'b', startLine: 9 }), pin({ id: 'x', path: 'b.ts', startLine: 1 }), pin({ id: 'a', startLine: 2 })],
      'a.ts',
    );
    expect(out.map((p) => p.id)).toEqual(['a', 'b']);
  });
  it('drops a pin with no start line', () => {
    expect(editorPins([pin({ id: 'a' })], 'a.ts')).toEqual([]);
  });
  it('carries columns and the note through', () => {
    const [only] = editorPins([pin({ id: 'a', startLine: 1, endLine: 2, startColumn: 3, endColumn: 4, note: 'why' })], 'a.ts');
    expect(only).toEqual({ id: 'a', startLine: 1, endLine: 2, startColumn: 3, endColumn: 4, note: 'why' });
  });
});
```

`pin-selection.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { pinFromOffsets } from './pin-selection';

const doc = 'one\ntwo\nthree';

describe('pinFromOffsets', () => {
  it('returns null for an empty selection', () => {
    expect(pinFromOffsets(doc, 2, 2)).toBeNull();
  });
  it('pins a single line with columns and text', () => {
    expect(pinFromOffsets(doc, 0, 3)).toEqual({
      startLine: 1, startColumn: 1, endColumn: 3, characters: 3, text: 'one',
    });
  });
  it('pins whole lines from a gutter drag', () => {
    expect(pinFromOffsets(doc, 0, 7, { lineOnly: true })).toEqual({
      startLine: 1, endLine: 2, characters: 7,
    });
  });
  it('pins a multi-line selection without text', () => {
    expect(pinFromOffsets(doc, 2, 6)).toEqual({
      startLine: 1, endLine: 2, startColumn: 3, endColumn: 3, characters: 4,
    });
  });
  it('counts UTF-16 units for emoji (Review Focus 5)', () => {
    expect(pinFromOffsets('a😀b', 1, 3)).toMatchObject({ startColumn: 2, endColumn: 3, characters: 2 });
  });
  it('clamps offsets past the end', () => {
    expect(pinFromOffsets('ab', 0, 99)).toMatchObject({ startLine: 1, endLine: undefined });
  });
  it('pins the last line when the doc ends with a newline', () => {
    expect(pinFromOffsets('ab\n', 3, 3)).toBeNull();
  });
});
```

`from`/`to` are document offsets (CM's `state.doc`, already `\n`-normalised).

- [ ] **Step 2: Run both and watch them fail**

`cd packages/ui-angular && npx ng test --include src/app/ui/code-editor/pins.spec.ts --include src/app/ui/code-editor/pin-selection.spec.ts --watch=false`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement both modules**

`editorPins` filters by `path`, drops `startLine === undefined`, sorts by `startLine` then `id`, and copies only the six fields above.

`pinFromOffsets` clamps `from`/`to` into `[0, text.length]`, swaps them when reversed, returns `null` when equal, splits the prefix `text.slice(0, from)` on `\n` for the 1-based start line/column, does the same for `to` for the end, and computes `characters` as `to - from` (UTF-16 units, which is what `String.length` and the store both use). With `lineOnly`, it returns only `startLine`, `endLine` (omitted when both ends share a line) and `characters`. Without it, `endColumn` is the 1-based column of the last selected character (the exclusive end's character index, normalised to the previous line's length when the selection stops at a later line's first column), and `text` is set only when the selection stays on one line.

- [ ] **Step 4: Run both tests and confirm they pass**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui-angular/src/app/ui/code-editor/pins.ts packages/ui-angular/src/app/ui/code-editor/pins.spec.ts packages/ui-angular/src/app/ui/code-editor/pin-selection.ts packages/ui-angular/src/app/ui/code-editor/pin-selection.spec.ts
git commit -m "feat(ui): model editor pins and pin selection"
```

---

### Task 3: Rail placement math

**Files:**
- Create: `packages/ui-angular/src/app/ui/code-editor/rail.ts`
- Test: `packages/ui-angular/src/app/ui/code-editor/rail.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RailSlot { readonly top: number; readonly height: number; }
  export function railSlots(
    anchors: readonly (number | null)[],
    heights: readonly number[],
    gap?: number,
  ): (RailSlot | null)[];
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { railSlots } from './rail';

describe('railSlots', () => {
  it('places one card at its anchor', () => {
    expect(railSlots([100], [40])).toEqual([{ top: 100, height: 40 }]);
  });
  it('pushes a card down when the previous one would overlap', () => {
    expect(railSlots([100, 110], [40, 30], 6)).toEqual([
      { top: 100, height: 40 }, { top: 146, height: 30 },
    ]);
  });
  it('keeps the anchor when there is room', () => {
    expect(railSlots([100, 300], [40, 30], 6)[1]).toEqual({ top: 300, height: 30 });
  });
  it('drops a card whose line could not be measured (Review Focus 3)', () => {
    expect(railSlots([100, null], [40, 30])).toEqual([{ top: 100, height: 40 }, null]);
  });
  it('stays linear and non-overlapping with 200 pins (Review Focus 4)', () => {
    const anchors = Array.from({ length: 200 }, (_, i) => i * 4);
    const slots = railSlots(anchors, Array.from({ length: 200 }, () => 30), 6);
    for (let i = 1; i < slots.length; i += 1) expect(slots[i]!.top).toBeGreaterThanOrEqual(slots[i - 1]!.top + 30 + 6);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

`cd packages/ui-angular && npx ng test --include src/app/ui/code-editor/rail.spec.ts --watch=false`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `rail.ts`**

Single pass, `gap` defaulting to 6: keep a `bottom` cursor; for each index, a `null` anchor yields `null` and does not move the cursor; otherwise `top = Math.max(anchor, bottom + gap)` and `bottom = top + height`. Inputs are given in line order; the function does not sort.

- [ ] **Step 4: Run the test and confirm it passes**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui-angular/src/app/ui/code-editor/rail.ts packages/ui-angular/src/app/ui/code-editor/rail.spec.ts
git commit -m "feat(ui): place note cards without overlap"
```

---

### Task 4: Token mapping, syntax theme and the NOTICE entry

**Files:**
- Create: `NOTICE`
- Create: `packages/ui-angular/src/app/ui/code-editor/editor-theme.ts`
- Modify: `packages/ui-angular/src/styles.css` (three theme blocks — the VS Code `:root`, the light block, the standalone dark block)
- Test: `packages/ui-angular/src/app/ui/code-editor/editor-theme.spec.ts`

**Interfaces:**
- Consumes: `@codemirror/language` `HighlightStyle`, `@lezer/highlight` `tags`.
- Produces:
  ```ts
  export const morseHighlightStyle: HighlightStyle;
  export const THEME_TOKENS: readonly string[]; // css custom properties the style reads, e.g. '--morse-keyword'
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEME_TOKENS, morseHighlightStyle } from './editor-theme';

const styles = readFileSync(join(__dirname, '../../../../styles.css'), 'utf8');

describe('morseHighlightStyle', () => {
  it('reads only tokens the stylesheet defines', () => {
    for (const token of THEME_TOKENS) expect(styles).toContain(`${token}:`);
  });
  it('is a highlight style', () => {
    expect(morseHighlightStyle).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

`cd packages/ui-angular && npx ng test --include src/app/ui/code-editor/editor-theme.spec.ts --watch=false`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the four tokens to all three theme blocks**

In `styles.css`, next to each block's existing `--morse-typename` line:

```css
--morse-comment: var(--morse-fg-muted);
--morse-punct: var(--morse-fg-muted);
--morse-editor-bg: var(--morse-code-bg);
--morse-editor-gutter: var(--morse-panel);
```

Aliases only — no new colours. `--morse-fg-muted`, `--morse-code-bg` and `--morse-panel` already exist in all three blocks; verify before editing and copy the surrounding formatting.

- [ ] **Step 4: Implement `editor-theme.ts`**

A `HighlightStyle.define([...])` mapping, per the spec's D3 table: keyword/controlKeyword/moduleKeyword/operatorKeyword/modifier/bool/null/unit → `--morse-keyword`; string/character/attributeValue/regexp/escape → `--morse-string`; number/integer/float/atom/constant(variableName) → `--morse-number`; typeName/className/namespace/standard(…) → `--morse-typename`; function(variableName)/function(propertyName) + url → `--morse-info`; comment/lineComment/blockComment/punctuation/bracket/operator/separator/meta → `--morse-punct` or `--morse-comment` as the spec says; variableName/propertyName → `--morse-fg`; tagName/angleBracket/annotation → `--morse-keyword`; invalid → `--morse-error`; heading → bold; emphasis italic; strong 600. `THEME_TOKENS` lists exactly the custom properties used.

- [ ] **Step 5: Create `NOTICE`**

```
Morse
Copyright 2026 Morse contributors

This product includes software derived from OpenIDEA
(https://github.com/l0ng-ai/openidea), pinned at commit
835c44615b0aa847d8aa8461a5d3f812ff8c8919, licensed under the Apache
License, Version 2.0. Ported files retain their original headers and name
the upstream path they came from.

The full Apache License, Version 2.0 text is at
https://www.apache.org/licenses/LICENSE-2.0
```

- [ ] **Step 6: Run the test and confirm it passes**

Same command. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add NOTICE packages/ui-angular/src/styles.css packages/ui-angular/src/app/ui/code-editor/editor-theme.ts packages/ui-angular/src/app/ui/code-editor/editor-theme.spec.ts
git commit -m "feat(ui): map CodeMirror highlights onto Morse tokens"
```

---

### Task 5: The editor extension set

**Files:**
- Create: `packages/ui-angular/src/app/ui/code-editor/editor-setup.ts`
- Create: `packages/ui-angular/src/app/ui/code-editor/scroll.ts`
- Test: `packages/ui-angular/src/app/ui/code-editor/scroll.spec.ts`
- Test: `packages/ui-angular/src/app/ui/code-editor/editor-setup.spec.ts`

**Interfaces:**
- Consumes: `morseHighlightStyle` (Task 4).
- Produces:
  ```ts
  export interface EditorSetupOptions {
    readonly sticky?: boolean;   // default true
    readonly wrap?: boolean;     // default true
  }
  export function editorExtensions(options?: EditorSetupOptions): Extension;
  export const caretRow: Extension; // decoration plugin, exported for the smoke test

  export function clampLine(line: number, lines: number): number;
  ```

- [ ] **Step 1: Write the failing tests**
`scroll.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { clampLine } from './scroll';

describe('clampLine', () => {
  it('keeps a line in range', () => expect(clampLine(3, 10)).toBe(3));
  it('clamps above', () => expect(clampLine(0, 10)).toBe(1));
  it('clamps below', () => expect(clampLine(99, 10)).toBe(10));
  it('survives an empty document', () => expect(clampLine(5, 0)).toBe(1));
});
```

`editor-setup.spec.ts` — state-level only, never a view:

```ts
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { editorExtensions } from './editor-setup';

describe('editorExtensions', () => {
  it('builds a state without a view', () => {
    const state = EditorState.create({ doc: 'const a = 1;\n', extensions: editorExtensions() });
    expect(state.doc.lines).toBe(2);
  });
  it('is read-only', () => {
    const state = EditorState.create({ doc: 'x', extensions: editorExtensions() });
    expect(state.readOnly).toBe(true);
  });
  it('folds a JavaScript function body when the language is loaded', async () => {
    const { javascript } = await import('@codemirror/lang-javascript');
    const state = EditorState.create({
      doc: 'function a() {\n  return 1;\n}\n',
      extensions: [javascript(), editorExtensions()],
    });
    const tree = ensureSyntaxTree(state, state.doc.length, 5000);
    expect(tree).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run both and watch them fail**

`cd packages/ui-angular && npx ng test --include src/app/ui/code-editor/scroll.spec.ts --include src/app/ui/code-editor/editor-setup.spec.ts --watch=false`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `scroll.ts`**

`clampLine` is `Math.min(Math.max(1, Math.round(line)), Math.max(1, lines))`. The file also exports `lineFlash(line: number): Decoration` returning a line decoration classed `morse-line-flash` (no test; the CSS animation makes it a flash).

- [ ] **Step 4: Implement `editor-setup.ts`**

`editorExtensions` returns, in this order: `EditorState.readOnly.of(true)`, `EditorView.editable.of(false)`, `EditorView.lineWrapping` when `wrap !== false`, `syntaxHighlighting(morseHighlightStyle)`, `drawSelection({ cursorBlinkRate: 1200 })`, the caret-glide `ViewPlugin` (ported from `cm/prefs.ts` `caretGlide`: only selection-only updates with equal range counts and both endpoints on screen; toggles the class `morse-caret-glide`), `caretRow`, `highlightActiveLineGutter()`, `foldGutter()`, `keymap.of([...defaultKeymap, ...searchKeymap, ...foldKeymap])`, `search({ top: true })`, `scrollPastEnd()` (6 lines), `stickyScroll()` when `sticky !== false`, `indentGuides()`, `rainbowBrackets()`.

- Indent guides: a `ViewPlugin` that, per visible line, emits a line decoration carrying `--morse-guides: <depth>`; the CSS paints one 1px strip per depth in `--morse-border`. Compute depth from the line's leading whitespace and the state's indent unit — no syntax tree.
- Rainbow brackets: a `ViewPlugin` over `syntaxTree(state)` marking bracket tokens with `morse-bracket-<n>` classes by depth; the CSS cycles five tints off `--morse-keyword`, `--morse-string`, `--morse-number`, `--morse-typename`, `--morse-attr`.
- Sticky scroll: ported from `cm/stickyScroll.ts`, but its `backendFolds` dependency is replaced by `foldedRanges(state)`; cap at 2 lines via the `morse-sticky` class. It hides itself when no enclosing declaration is above the top visible line.

Header on the file: `// Ported from openidea src/editor/core/cm/{prefs,stickyScroll,indentGuides,rainbowBrackets}.ts @ 835c446 (Apache-2.0), see NOTICE.`

- [ ] **Step 5: Run both tests and confirm they pass**

Same command. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ui-angular/src/app/ui/code-editor/editor-setup.ts packages/ui-angular/src/app/ui/code-editor/editor-setup.spec.ts packages/ui-angular/src/app/ui/code-editor/scroll.ts packages/ui-angular/src/app/ui/code-editor/scroll.spec.ts
git commit -m "feat(ui): build the read-only CodeMirror extension set"
```

---

### Task 6: The editor component

**Files:**
- Create: `packages/ui-angular/src/app/ui/code-editor/code-editor.ts`
- Create: `packages/ui-angular/src/app/ui/code-editor/code-editor.html`
- Create: `packages/ui-angular/src/app/ui/code-editor/code-editor.css`
- Create: `packages/ui-angular/src/app/ui/code-editor/code-editor-loader.ts`
- Modify: `packages/ui-angular/src/app/shell/conventions.spec.ts`
- Test: `packages/ui-angular/src/app/shell/conventions.spec.ts` (the new case)

**Interfaces:**
- Consumes: `editorExtensions` (Task 5), `grammarFor`/`loadLanguage` (Task 1), `EditorPin` (Task 2), `clampLine`/`lineFlash` (Task 5), `PinRequest` (Task 2).
- Produces:
  ```ts
  export class CodeEditor {
    readonly text = input.required<string>();
    readonly path = input.required<string>();
    readonly line = input<number | undefined>(undefined);
    readonly pins = input<readonly EditorPin[]>([]);

    readonly pinRequested = output<PinRequest>();
    readonly noteEdited = output<{ id: string; note: string }>();
    readonly unpinned = output<{ id: string }>();
  }

  export type CodeEditorLoader = () => Promise<Type<unknown>>;
  export const CODE_EDITOR_LOADER: InjectionToken<CodeEditorLoader>;
  ```

- [ ] **Step 1: Write the failing conventions case**

Add to `conventions.spec.ts`:

```ts
it('R-U8: the editor stylesheet scopes every selector to its host', () => {
  const css = readFileSync(join(APP, 'ui/code-editor/code-editor.css'), 'utf8');
  const selectors = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .map((block) => block.split('{')[0])
    .map((selector) => selector.trim())
    .filter((selector) => selector.length > 0 && !selector.startsWith('@'));
  const unscoped = selectors.filter((selector) =>
    selector.split(',').some((part) => !part.trim().startsWith('morse-code-editor')),
  );
  expect(unscoped).toEqual([]);
});
```

- [ ] **Step 2: Run it and watch it fail**

`cd packages/ui-angular && npx ng test --include src/app/shell/conventions.spec.ts --watch=false`
Expected: FAIL — `code-editor.css` cannot be read.

- [ ] **Step 3: Implement `code-editor-loader.ts`**

```ts
export type CodeEditorLoader = () => Promise<Type<unknown>>;
export const CODE_EDITOR_LOADER = new InjectionToken<CodeEditorLoader>('CODE_EDITOR_LOADER', {
  providedIn: 'root',
  factory: () => () => import('./code-editor').then((m) => m.CodeEditor),
});
```

- [ ] **Step 4: Implement the component shell**

`code-editor.ts`: standalone, `ChangeDetectionStrategy.OnPush`, `encapsulation: ViewEncapsulation.None` (so CM's own DOM is styled by `code-editor.css`), `templateUrl`/`styleUrl` in their own files. `ngAfterViewInit` creates the `EditorView` on `#host` with `editorExtensions()`, the doc from `text()`, and an `updateListener` that emits `pinRequested` when `update.selectionSet` and the selection is non-empty **and** the pill is confirmed (Task 7). An effect sets `view.dispatch({ changes: … })` when `text()` changes and `dispatchEffects` to reveal `line()` (clamped via `clampLine`) with a `lineFlash` line decoration that clears after 900 ms. A second effect loads the grammar once via `loadLanguage(path())` and installs it with a `Compartment`; a rejection leaves the document plain. `ngOnDestroy` destroys the view and clears timers.

`code-editor.html`: `<div class="morse-code-editor" #host></div>` plus a `<div class="morse-code-editor-rail">` placeholder that Task 8 fills.

`code-editor.css`: `morse-code-editor` prefix on every selector; gutters, active line, selection, caret colours from the tokens, fold chevrons only on gutter hover, `.morse-line-flash` animation, `prefers-reduced-motion` disabling the caret transition.

- [ ] **Step 5: Run the conventions test and confirm it passes**

Same command. Expected: PASS (and the pre-existing cases still pass).

- [ ] **Step 6: Typecheck and build**

`cd packages/ui-angular && npx tsc -p tsconfig.app.json --noEmit && npx ng build 2>&1 | tail -25`
Expected: no type errors; the build reports a **separate lazy chunk** containing `@codemirror/state`, and initial size within ~20 kB of Task 1's figure.

- [ ] **Step 7: Commit**

```bash
git add packages/ui-angular/src/app/ui/code-editor/ packages/ui-angular/src/app/shell/conventions.spec.ts
git commit -m "feat(ui): mount a read-only CodeMirror editor"
```

---

### Task 7: Pin creation — gutter drag and the selection pill

**Files:**
- Modify: `packages/ui-angular/src/app/ui/code-editor/code-editor.ts`
- Modify: `packages/ui-angular/src/app/ui/code-editor/code-editor.html`
- Modify: `packages/ui-angular/src/app/ui/code-editor/code-editor.css`
- Test: `packages/ui-angular/src/app/ui/code-editor/code-editor.spec.ts`

**Interfaces:**
- Consumes: `pinFromOffsets` (Task 2), `EditorView`/`gutter` from `@codemirror/view`.
- Produces: `pinRequested` now fires from two gestures; no signature change.

- [ ] **Step 1: Write the failing test**

The gesture needs a view, which jsdom cannot lay out, so the test pins the one decision that can be pure — the pill's bounds — via a new exported helper in `pin-selection.ts`:

```ts
// pin-selection.spec.ts (append)
import { pillAnchoredAt } from './pin-selection';

describe('pillAnchoredAt', () => {
  it('sits below the selection end, inside the viewport', () => {
    expect(pillAnchoredAt({ left: 10, top: 100, bottom: 120 }, { width: 400, height: 300 }, { width: 140, height: 28 }))
      .toEqual({ left: 10, top: 126 });
  });
  it('flips left when it would overflow the right edge', () => {
    expect(pillAnchoredAt({ left: 380, top: 100, bottom: 120 }, { width: 400, height: 300 }, { width: 140, height: 28 }))
      .toEqual({ left: 260, top: 126 });
  });
  it('clamps above when the selection is at the bottom', () => {
    expect(pillAnchoredAt({ left: 10, top: 280, bottom: 300 }, { width: 400, height: 300 }, { width: 140, height: 28 }).top)
      .toBeLessThan(280);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

`cd packages/ui-angular && npx ng test --include src/app/ui/code-editor/pin-selection.spec.ts --watch=false`
Expected: FAIL — `pillAnchoredAt` is not exported.

- [ ] **Step 3: Implement `pillAnchoredAt` and the gestures**

```ts
export function pillAnchoredAt(
  rect: { left: number; top: number; bottom: number },
  viewport: { width: number; height: number },
  pill: { width: number; height: number },
  margin?: number,
): { left: number; top: number };
```
`margin` defaults to 6: `left = Math.min(rect.left, viewport.width - pill.width - margin)`, `top = rect.bottom + margin`, and when `top + pill.height > viewport.height - margin`, `top = rect.top - pill.height - margin`.

In the component: a 6px custom gutter (`gutter({ class: 'morse-gutter-pin', … })`) whose `domEventHandlers` map pointer down/move/up to line numbers via `view.lineBlockAtHeight`, drawing a live `.morse-drag-range` line decoration, and on release calling `pinRequested.emit(pinFromOffsets(doc, from, to, { lineOnly: true }))`. A `ViewPlugin` that, while the selection is non-empty and the view is focused, renders the pill in the component template (`@if (pill(); as p)`) positioned with `pillAnchoredAt`; Enter or click emits `pinFromOffsets(doc, sel.from, sel.to)`; Escape or a click elsewhere clears it. The pill shows the range label (`L14` / `L14-22` / `L14:3-22`).

- [ ] **Step 4: Run the tests and confirm they pass**

Same command. Expected: PASS (all `pin-selection` cases).

- [ ] **Step 5: Commit**

```bash
git add packages/ui-angular/src/app/ui/code-editor/
git commit -m "feat(ui): pin a range by dragging lines or confirming a selection"
```

---

### Task 8: The note rail

**Files:**
- Modify: `packages/ui-angular/src/app/ui/code-editor/code-editor.ts`
- Modify: `packages/ui-angular/src/app/ui/code-editor/code-editor.html`
- Modify: `packages/ui-angular/src/app/ui/code-editor/code-editor.css`

**Interfaces:**
- Consumes: `railSlots` (Task 3), `pins()` input, `Markdown` from `ui/`.
- Produces: no new exports.

- [ ] **Step 1: Implement the rail without a new test**

The rail's math is already covered by Task 3; the DOM is verified in Task 13's manual pass. In the component:

- A `signal` of rail slots recomputed in one `requestMeasure` per frame from `pins()` and `view.coordsAtPos(view.state.doc.line(pin.startLine).from)`; a pin whose line is folded or unmeasurable contributes `null` and is hidden.
- Cards rendered by `@for` over pins with their slot; each card shows the range label and the note through `Markdown`, or the ghost text "Add a note…" when the note is empty.
- A line decoration tints each pinned range (`--morse-accent` at 8%) and marks a 2px lane at the left of the text.
- The rail is 240px wide when the pane allows it, otherwise absolutely positioned over the right edge; both presentations share the same card markup and CSS classes.

- [ ] **Step 2: Typecheck**

`cd packages/ui-angular && npx tsc -p tsconfig.app.json --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/ui-angular/src/app/ui/code-editor/
git commit -m "feat(ui): show pinned ranges as cards beside the code"
```

---

### Task 9: Writing, editing and removing a note

**Files:**
- Modify: `packages/ui-angular/src/app/ui/code-editor/code-editor.ts`
- Modify: `packages/ui-angular/src/app/ui/code-editor/code-editor.html`
- Modify: `packages/ui-angular/src/app/ui/code-editor/code-editor.css`

**Interfaces:**
- Consumes: `PinAnnotation` from `ui/pin-annotation`.
- Produces: `noteEdited` and `unpinned` now fire.

- [ ] **Step 1: Implement without a new test**

The note editor is the existing `morse-pin-annotation` component; its behaviour is already covered by its own spec, and the write-through is covered in Task 10. In the component:

- Each card carries `.morse-card-edit` (✎) and `.morse-card-remove` (⌫). ✎ sets an `editing` signal holding the pin id and the card element; the template renders `<morse-pin-annotation [anchor]="anchorOf(card)" [target]="{ path: path(), range: labelOf(pin) }" [note]="pin.note ?? ''" (save)="emitNote(pin.id, $event)" (cancel)="editing.set(null)" />`.
- `save` emits `noteEdited` with the trimmed note — an empty string is emitted as `''`, and the feature routes it to `setPinNote(id, undefined)`.
- ⌫ emits `unpinned({ id })` and closes an open editor for that pin.

- [ ] **Step 2: Typecheck**

`cd packages/ui-angular && npx tsc -p tsconfig.app.json --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/ui-angular/src/app/ui/code-editor/
git commit -m "feat(ui): write a pinned range's note in its card"
```

---

### Task 10: Wire file-preview to the editor

**Files:**
- Modify: `packages/ui-angular/src/app/features/file-preview/file-preview.ts`
- Modify: `packages/ui-angular/src/app/features/file-preview/file-preview.html`
- Modify: `packages/ui-angular/src/app/features/file-preview/file-preview.css`
- Modify: `packages/ui-angular/src/app/features/file-preview/file-preview.spec.ts`
- Create: `packages/ui-angular/src/app/features/file-preview/fake-code-editor.ts` (spec-only fake, referenced from the spec)

**Interfaces:**
- Consumes: `CODE_EDITOR_LOADER`, `CodeEditor` (Task 6), `editorPins` (Task 2), `PinRequest` (Task 2).
- Produces: `FilePreview` keeps `mode()`, `diffable()`, `toggleChange()`, `pinSelection()` (now taking a `PinRequest`), `reload()`; it stops rendering file content itself.

- [ ] **Step 1: Write the failing spec**

`fake-code-editor.ts` is a standalone component with exactly the `CodeEditor` inputs and outputs, a `@Component`-decorated class and a `file` template `''`, so `By.directive(FakeEditor)` can find it.

Add `{ provide: CODE_EDITOR_LOADER, useValue: async () => FakeEditor }` to the `providers` array of the existing `render()` helper in `file-preview.spec.ts`, then add:

```ts
it('hands a pin request to the store', async () => {
  const { fixture, pins } = render({ content: 'one\ntwo' });
  const editor = fixture.debugElement.query(By.directive(FakeEditor)).componentInstance as FakeEditor;
  editor.pinRequested.emit({ startLine: 2, characters: 3, text: 'two' });
  expect(pins()).toHaveLength(1);
});

it('passes the file and its pins to the editor', () => {
  const { fixture, pins } = render({ content: 'one\ntwo' });
  pins.set([{ id: 'p1', path: 'src/main.ts', startLine: 1 }]);
  fixture.detectChanges();
  const editor = fixture.debugElement.query(By.directive(FakeEditor)).componentInstance as FakeEditor;
  expect(editor.pins().map((p) => p.id)).toEqual(['p1']);
});

it('writes a note edited in a card', () => {
  const { fixture, pins, attachments } = render({ content: 'x' });
  const editor = fixture.debugElement.query(By.directive(FakeEditor)).componentInstance as FakeEditor;
  editor.noteEdited.emit({ id: 'p1', note: 'why' });
  expect(attachments.setPinNote).toHaveBeenCalledWith('p1', 'why');
});

it('unpins from a card', () => {
  const { fixture, attachments } = render({ content: 'x' });
  const editor = fixture.debugElement.query(By.directive(FakeEditor)).componentInstance as FakeEditor;
  editor.unpinned.emit({ id: 'p1' });
  expect(attachments.removePin).toHaveBeenCalledWith('p1');
});

it('renders no editor for a binary file', () => {
  const { fixture } = render({ content: '', binary: true });
  expect(fixture.debugElement.query(By.directive(FakeEditor))).toBeNull();
});

it('keeps the diff modes on highlight.js', () => {
  const { fixture } = render({ diff: 'diff --git a/x b/x' });
  (fixture.componentInstance as unknown as { setMode: (m: string) => void }).setMode('unified');
  fixture.detectChanges();
  expect(fixture.debugElement.query(By.css('.diff'))).not.toBeNull();
  expect(fixture.debugElement.query(By.directive(FakeEditor))).toBeNull();
});
```

`render()` returns `pins` as a signal already; use it directly rather than `TestBed.inject`. The
loader is async, so every case that queries `FakeEditor` awaits `fixture.whenStable()` after
`detectChanges()` before the query; make those tests `async`.

- [ ] **Step 2: Run it and watch it fail**

`cd packages/ui-angular && npx ng test --include src/app/features/file-preview/file-preview.spec.ts --watch=false`
Expected: FAIL — `CODE_EDITOR_LOADER` does not exist.

- [ ] **Step 3: Wire the editor in**

In `file-preview.ts`: inject `CODE_EDITOR_LOADER`, `ViewContainerRef`; keep the resolved class in a `signal<Type<unknown> | null>`; a public `loadEditor()` loads once, caches the class, and sets `editorFailed` on rejection; an `effect` mounts via `viewContainerRef.createComponent` once the template's host exists, subscribing to the three outputs. A second effect pushes `text`/`path`/`line`/`pins` with `setInput`. The effect's cleanup destroys the component. `pinSelection(request: PinRequest)` calls `attachments.pin({ path, ...request }, editingId())` and drops `celebrate`, `mergedId`, `selected` and the confetti. `pins` for the editor is `computed(() => editorPins(this.attachments.pins(), this.tab().path))`.

Delete from `file-preview.ts`: `highlighted`, `source`, `lines`, `lineHeight`, `topOf`, `lineTop`, `heightOf`, `isSelected`, `selected`, `startSelection`, `clearSelection`, `lineAt`, `measureLineHeight`, `revealLine`, `flash`, `pinSelection()`'s old body, `startResizeEdge`, `animateMerge`/`celebrate`, `openBandAnnotation` (file mode), the `AnimationService` inject when nothing else uses it, and the view queries `sourceElement`/`gutterElement`/`wrapElement`/`codeElement`. Keep `highlightCode` for `unifiedView`/`splitView` and the diff band logic.

In `file-preview.html`: replace the whole `@else` file-mode block (the `.code`/`.gutter`/`.source-wrap` markup) with:

```html
@if (mode() === 'file') {
  @if (editorClass() && !tab().binary && !tab().truncated) {
    <ng-container #editorHost></ng-container>
  } @else {
    <!-- While the editor chunk loads, and for anything it cannot show. -->
    <pre class="source-plain">{{ tab().content }}</pre>
    @if (editorFailed()) {
      <button type="button" class="editor-retry" (click)="loadEditor()">Reload the editor</button>
    }
  }
}
```

Keep the diff blocks untouched.

In `file-preview.css`: delete the file-mode and band rules; keep the diff, header and mode rules, and add `.source-plain` (monospace, `--morse-editor-bg`, scrollable, no highlighting).

- [ ] **Step 4: Run the spec and confirm it passes**

Same command. Expected: PASS — the six new cases and the surviving diff cases. Confirm by name that no test still drives `.num`, `.selection`, `.edge` or `.band-annotate`.

- [ ] **Step 5: Build and check the budget**

`cd packages/ui-angular && npx ng build 2>&1 | tail -25`
Expected: build succeeds; initial bundle is within ~20 kB of Task 1's figure; CodeMirror lives in a lazy chunk.

- [ ] **Step 6: Commit**

```bash
git add packages/ui-angular/src/app/features/file-preview/
git commit -m "feat(ui): open files in the CodeMirror editor"
```

---

### Task 11: Remove LSP from the frontend

**Files:**
- Modify: `packages/ui-angular/src/app/features/file-preview/file-preview.ts`
- Modify: `packages/ui-angular/src/app/features/file-preview/file-preview.html`
- Modify: `packages/ui-angular/src/app/features/file-preview/file-preview.css`
- Modify: `packages/ui-angular/src/app/features/file-preview/file-preview.spec.ts`
- Modify: `packages/ui-angular/src/app/features/composer/composer.ts`
- Modify: `packages/ui-angular/src/app/features/composer/composer.html`
- Modify: `packages/ui-angular/src/app/features/composer/composer.spec.ts`
- Modify: `packages/ui-angular/src/app/features/composer/composer.pins.spec.ts`
- Modify: `packages/ui-angular/src/app/state/workspace-tabs.ts` (the `line` doc comment only)

**Interfaces:**
- Consumes: nothing new.
- Produces: `composer` gains `readonly canAnnotateInFile = computed(() => this.morse.capabilities()?.filePreview === true)`; the chip's note button renders only when that is false.

- [ ] **Step 1: Write the failing tests**

In `composer.pins.spec.ts`: a pin chip shows no note button when the `host/ready` payload's
`capabilities` include `filePreview: true` (the browser host), and shows it when they do not (the
existing harness already sends `hostKind: 'vscode'` — add `filePreview: true` for the first case). In
the browser case the chip still shows the note text on hover via `morseNoteHover`, on a `<span>`
rather than a `<button>`.

In `file-preview.spec.ts`: the problems popover, hover card and references card no longer exist — assert by absence (`query(By.css('.problems'))` null, `.hover-card` null), and assert that a file with a `line` still reaches the editor's `line` input.

- [ ] **Step 2: Run them and watch them fail**

`cd packages/ui-angular && npx ng test --include src/app/features/composer/composer.pins.spec.ts --include src/app/features/file-preview/file-preview.spec.ts --watch=false`
Expected: FAIL — the note button is still rendered for browser hosts.

- [ ] **Step 3: Delete the LSP surface**

Remove from `file-preview.ts`: the `lsp*` imports, `lspReady`, `lspAvailable`, `diagnostics`, `diagnosticsBusy`, `marks`, `problems`, `problemCounts`, `problemsOpen`, `toggleProblems`, `problemTitle`, `hoverCard`, `hoverLocked`, `hoverLockMs`, `references`, `referencesOpen`, `referencesBusy`, `referencesNote`, `showReferences`, `closeReferences`, `onSourceMove`, `onSourceLeave`, `onSourceClick`, `pointOf`, `settleHover`, `cancelHoverClose`, `closeHover`, `startLockTimer`, `cancelLockTimer`, `clearHover`, `placeCard`, `jump`, `args`, `scheduleMarks`, `measureMarks`, `HOVER_LOCK_MS`, and the `asDiagnostics/asHover/asLocation/asReferences` imports. `jumpToLine` stays (search/git) but loses the LSP wording in its comment.

Remove from the template: the problems badge/popover, the hover card, the references list, the `lsp-none` badge. Remove the matching CSS blocks.

In `composer.ts`: `openAnnotation` remains but is only reachable from a chip when `canAnnotateInFile()` is false; guard the chip's note button in `composer.html` with `@if (!canAnnotateInFile())`.

In `workspace-tabs.ts`, reword the `line` field's comment so it no longer names language servers.

- [ ] **Step 4: Run both specs and confirm they pass**

Same command. Expected: PASS.

- [ ] **Step 5: Typecheck**

`cd packages/ui-angular && npx tsc -p tsconfig.app.json --noEmit`
Expected: clean. (`capabilities.lsp` is still declared in the protocol; nothing reads it yet.)

- [ ] **Step 6: Commit**

```bash
git add packages/ui-angular/src/app/features/ packages/ui-angular/src/app/state/workspace-tabs.ts
git commit -m "refactor(ui): remove the language-server surface and move notes into cards"
```

---

### Task 12: Remove LSP from ui-runtime, the wire and the server

**Files:**
- Delete: `packages/ui-runtime/src/lsp/` (`guards.ts`, `guards.spec.ts`)
- Delete: `packages/ui-runtime/src/files/positions.ts`, `packages/ui-runtime/src/files/positions.spec.ts`
- Modify: `packages/ui-runtime/src/index.ts`
- Delete: `packages/protocol/src/lsp.ts`
- Modify: `packages/protocol/src/index.ts`, `packages/protocol/src/wire/host.ts`, `packages/protocol/src/dto/host.ts`
- Delete: `packages/server/src/internal/lsp/` (8 files)
- Modify: `packages/server/src/app.module.ts`, `packages/server/src/internal/ws/session-factory.service.ts`, `packages/server/src/app/config.ts`, `packages/server/src/internal/registry.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: no `lsp*` host command, no `capabilities.lsp`, no `MORSE_LSP_*` env var, no language-server module. `readFile`, `searchWorkspace`, `gitLog` and the rest are untouched.

- [ ] **Step 1: Delete the frontend-side leftovers and run their suites**

```bash
git rm -r packages/ui-runtime/src/lsp packages/ui-runtime/src/files/positions.ts packages/ui-runtime/src/files/positions.spec.ts
```
Remove the two `export *` lines from `packages/ui-runtime/src/index.ts`, then:

`cd packages/ui-runtime && npx vitest run`
Expected: PASS. If a spec imported `positions`, delete that spec — it tested a mapping that no longer exists.

- [ ] **Step 2: Remove the wire contract**

```bash
git rm packages/protocol/src/lsp.ts
```
Remove its export from `index.ts`, the four `lsp*` members from `wire/host.ts`, and the `lsp?: boolean` capability with its doc comment from `dto/host.ts`. Then `cd packages/protocol && npx tsc -p tsconfig.json --noEmit` — expected: clean, because Task 11 already stopped reading `capabilities.lsp`.

- [ ] **Step 3: Write the failing server test**

In `registry.spec.ts`, replace the LSP expectations with one that asserts the capability is gone:

```ts
it('advertises no language server', () => {
  expect(capabilitiesFor(context)).not.toHaveProperty('lsp');
});
```
Use whatever helper that file already uses to obtain capabilities. Run `cd packages/server && npx vitest run src/internal/registry.spec.ts` — expected: FAIL, `lsp` is still there.

- [ ] **Step 4: Delete the server module and its wiring**

```bash
git rm -r packages/server/src/internal/lsp
```
Remove the provider/export from `app.module.ts`; from `session-factory.service.ts` remove the `ServerLanguageServers` import and inject, the `lsp: true` capability line, the four `case 'lsp*'` branches, `lspFile()` and `lspPosition()`, and the now-unused `LspPosition`/`LspRange` imports; from `config.ts` remove `lspIdleMs`, `MORSE_LSP_IDLE_MS` and any `MORSE_LSP_*` language map.

- [ ] **Step 5: Run the server suite**

`cd packages/server && npx vitest run`
Expected: PASS, including the new absence test.

- [ ] **Step 6: Full typecheck and the fast suite**

From the root: `npm run check-types && npm run test:fast`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A packages/ui-runtime packages/protocol packages/server
git commit -m "refactor: delete LSP from the host, the wire and the runtime"
```

---

### Task 13: Documentation and the manual pass

**Files:**
- Modify: `docs/CONFIGURATION.md` (remove the `MORSE_LSP_*` rows and the language-server section)
- Modify: `docs/FRONTENDS.md` (remove the `lsp` capability paragraph; state that the browser host's file tabs are a read-only editor)
- Modify: `docs/INSTALL.md` (remove the `MORSE_LSP_*` env list and the resolution paragraph)
- Modify: `docs/ARCHITECTURE.md` only if it names the LSP package

- [ ] **Step 1: Update the three docs**

Grep each for `lsp`/`LSP`/`language server` and remove or reword. In `FRONTENDS.md`, the capability list loses `lsp` and the `filePreview` paragraph gains one sentence: "the browser host renders these in a read-only CodeMirror editor; there is no language server."

- [ ] **Step 2: Prove no stragglers**

```bash
grep -rn "lsp\|LSP\|languageServer\|language-server" --include=*.ts --include=*.html --include=*.css --include=*.json --include=*.md \
  packages/ docs/ scripts/ | grep -v node_modules | grep -v "/dist/" | grep -v ".vscode-test" | grep -v CHANGELOG
```
Expected: no matches outside `packages/extension/CHANGELOG.md` (release-time history) and this plan/spec.

- [ ] **Step 3: Run the manual pass in the browser host**

Start the host (`npm run dev:server` plus `npm run dev:ui`, or the documented browser workflow). Verify, in order:

1. Open a 3,000-line TypeScript file: highlighting appears, caret glides on `↑`/`↓`, the caret row tints, the active gutter line darkens.
2. Scroll a long function: its declaration sticks at the top; fold it and the sticky line disappears.
3. `Mod-f`: search highlights, Enter moves, Escape closes.
4. Drag line numbers 10–14: a range forms and a card appears beside it with "Add a note…".
5. Write a note in the card: it renders markdown; the composer chip shows the same text on hover.
6. Select a sub-range of columns: the pill appears, Enter pins, the chip reads `L10:3-18`.
7. Click a chip: the file opens at the pin's line, the range flashes and its card is beside it.
8. ⌫ on a card: the chip disappears.
9. Open a binary file and a truncated file: no editor, a plain message, no crash.
10. Open `Makefile` and `.env`: plain text, no console error.
11. Throttle the network and open a `.rs` file: the file appears immediately as plain text, then colours in.
12. Open the VS Code host: a pin's chip still offers the ✎ and the note popover works there.

Record the result in the PR body.

- [ ] **Step 4: Final full check**

```bash
npm run check-types && npm run test:fast
cd packages/ui-angular && npx ng build 2>&1 | tail -25
```
Expected: all pass; initial bundle still under the 1.3 MB error threshold with CodeMirror in a lazy chunk.

- [ ] **Step 5: Commit**

```bash
git add docs/
git commit -m "docs: describe the file editor and the removed language servers"
```
