# File Tree Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every row of the Explorer's file tree a JetBrains-style coloured type icon and drop the `├─` connector lines, so the tree reads as a hierarchy rather than a text outline.

**Architecture:** One `fileIcon(name)` mapping in `ui-runtime` names a kind (`ts`, `folder-open`, …) for a filename. One hidden SVG sprite in the shell template defines a handful of silhouettes, and rows colour them by kind from global CSS. `TreeList` gains an optional `icon` on its nodes and indents by depth instead of drawing connectors.

**Tech Stack:** TypeScript, Angular (standalone components, separate `.html`/`.css` — the conventions spec forbids inline templates), Vitest, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-11-12-file-tree-icons-design.md`

## Global Constraints

- No new dependency. No external asset URL (a `/…` URL does not resolve in the VS Code webview; the sprite must live in the document).
- No inline `template:` or `styles: []` in production sources — `shell/conventions.spec.ts` fails on them.
- `TreeList` is shared with the session tree: the icon must be optional and session rows must be unchanged.
- `fileGlyph()` stays as it is; `tab-strip` still uses it.
- `treePrefix()` and its spec stay in `ui-runtime` even though no UI calls it after Task 2.
- Icons are 14×14 on a `16 16` viewBox, `aria-hidden`, and the row's label already carries the spoken name.
- Brand colours are fixed hex chosen to read on both themes (mid-tone, not near-white or near-black).
- Every task ends green: `npm run test -w @morse/ui-runtime` and/or `npm run test -w @morse/ui-angular`.

## Review Focus

1. `.gitignore` (a dot with no extension) must not be read as a file whose extension is `gitignore` — it is the `git` kind.
2. `README.MD` and `main.TS` — extensions are matched case-insensitively.
3. `package-lock.json` and `pnpm-lock.yaml` are the `lock` kind, not `json`/`yaml`.
4. `foo.xyz` and `Makefile` always get an icon (`generic`), never a blank column.
5. A node with no icon (every session-tree row) reserves the column, so labels stay aligned with the Explorer's rows.

---

### Task 1: `fileIcon()` in `ui-runtime`

**Files:**
- Modify: `packages/ui-runtime/src/files/tree.ts` (below `fileGlyph`, beside it)
- Test: `packages/ui-runtime/src/files/tree.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export type IconKind = 'folder' | 'folder-open' | 'generic' | 'code' | 'data' | 'markdown' | 'image' | 'shell' | 'sql' | 'lock' | 'git'` and `export function fileIcon(name: string): IconKind`. Task 2 renders `#morse-<kind>`; Task 3 passes `'folder'`/`'folder-open'` directly.

- [ ] **Step 1: Write the failing tests**

Append to `packages/ui-runtime/src/files/tree.spec.ts`:

```ts
describe('fileIcon', () => {
  it('maps a language by extension', () => {
    expect(fileIcon('main.ts')).toBe('code');
    expect(fileIcon('app.py')).toBe('code');
  });

  it('matches the extension case-insensitively', () => {
    expect(fileIcon('README.MD')).toBe('markdown');
    expect(fileIcon('main.TS')).toBe('code');
  });

  it('reads a dotfile by its name, not its suffix', () => {
    expect(fileIcon('.gitignore')).toBe('git');
    expect(fileIcon('.env')).toBe('data');
  });

  it('prefers the whole name for a lockfile', () => {
    expect(fileIcon('package-lock.json')).toBe('lock');
    expect(fileIcon('pnpm-lock.yaml')).toBe('lock');
    expect(fileIcon('yarn.lock')).toBe('lock');
  });

  it('gives an unknown or missing extension the generic page', () => {
    expect(fileIcon('foo.xyz')).toBe('generic');
    expect(fileIcon('Makefile')).toBe('generic');
  });

  it('names the remaining shapes', () => {
    expect(fileIcon('logo.png')).toBe('image');
    expect(fileIcon('deploy.sh')).toBe('shell');
    expect(fileIcon('report.sql')).toBe('sql');
    expect(fileIcon('styles.css')).toBe('code');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @morse/ui-runtime`
Expected: FAIL — `fileIcon is not a function` (or a TS error naming the missing export).

- [ ] **Step 3: Implement `IconKind` and `fileIcon` in `packages/ui-runtime/src/files/tree.ts`**

```ts
/** The shape a tree row draws. The colour is the stylesheet's, keyed by this name. */
export type IconKind =
  | 'folder'
  | 'folder-open'
  | 'generic'
  | 'code'
  | 'data'
  | 'markdown'
  | 'image'
  | 'shell'
  | 'sql'
  | 'lock'
  | 'git';

export function fileIcon(name: string): IconKind;
```

Rules, checked in this order, extension lowercased:

1. whole name is one of `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, or ends in `.lock` → `lock`
2. whole name is `.gitignore` or `.gitattributes` → `git`
3. whole name starts with `.env` → `data`
4. extension in `json yaml yml toml ini` → `data`
5. extension in `sh bash zsh` → `shell`
6. extension in `sql` → `sql`
7. extension in `md markdown rst txt` → `markdown`
8. extension in `png jpg jpeg gif webp svg ico` → `image`
9. extension in `ts tsx js jsx mjs cjs py go php rb rs java kt c h cpp cs swift dart html htm css scss less xml` → `code`
10. anything else → `generic`

`'lock'` and `'git'` and `'folder'`/`'folder-open'` are never produced from an extension. A name with no dot, and a name whose only dot is at index 0, are matched by rules 1–3 only.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @morse/ui-runtime`
Expected: PASS — the existing `fileGlyph` suite and the new `fileIcon` suite.

- [ ] **Step 5: Commit**

```bash
git add packages/ui-runtime/src/files/tree.ts packages/ui-runtime/src/files/tree.spec.ts
git commit -m "feat(ui-runtime): name a file's icon kind"
```

---

### Task 2: Icon rows without connectors

**Files:**
- Modify: `packages/ui-runtime/src/ui/tree-list.ts` (`TreeNode`)
- Modify: `packages/ui-angular/src/app/shell/app.html` (sprite)
- Modify: `packages/ui-angular/src/styles.css` (kind colours)
- Modify: `packages/ui-angular/src/app/ui/tree-list/tree-list.html`, `tree-list.css`, `tree-list.ts`
- Test: `packages/ui-angular/src/app/ui/tree-list/tree-list.spec.ts`

**Interfaces:**
- Consumes: `IconKind` from Task 1 (`@morse/ui-runtime`).
- Produces: `TreeNode<T>` gains `readonly icon?: IconKind`; markup contract is `<svg class="file-icon <kind>"><use href="#morse-<kind>"/>`; `.line` carries `padding-left: depth * 12px`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/ui-angular/src/app/ui/tree-list/tree-list.spec.ts`, using the `render()` and `node()` helpers already there:

```ts
/** The tree with its own nodes, so one row's icon can be judged on its own. */
function withNodes(nodes: TreeNode<Item>[]): HTMLElement {
  const { host, fixture } = render();
  fixture.componentInstance.nodes.set(nodes);
  fixture.detectChanges();
  return host;
}

describe('morse-tree icon column', () => {
  it('draws the node icon as a sprite reference', () => {
    const host = withNodes([{ ...node('src'), icon: 'folder' }]);
    const icon = host.querySelector('svg.file-icon');
    expect(icon?.getAttribute('class')).toBe('file-icon folder');
    expect(icon?.querySelector('use')?.getAttribute('href')).toBe('#morse-folder');
  });

  it('reserves the column when a node has no icon', () => {
    const host = withNodes([node('s1')]);
    expect(host.querySelector('svg.file-icon')).toBeNull();
    expect(host.querySelector('.icon-blank')).not.toBeNull();
  });

  it('indents a row by its depth instead of drawing connectors', () => {
    const { host, fixture } = render();
    fixture.componentInstance.expanded.set(new Set(['morse']));
    fixture.detectChanges();
    const lines = host.querySelectorAll<HTMLElement>('.line');
    expect(lines[0].style.paddingLeft).toBe('0px');
    expect(lines[1].style.paddingLeft).toBe('12px');
    expect(host.querySelector('.prefix')).toBeNull();
    expect(host.textContent).not.toContain('├');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @morse/ui-angular`
Expected: FAIL — no `svg.file-icon`, `.prefix` still present, `paddingLeft` is `''`.

- [ ] **Step 3: Add `icon` to `TreeNode`**

In `packages/ui-runtime/src/ui/tree-list.ts`, beside `badge`, with the same "data, not markup" comment:

```ts
  /**
   * The row's icon, as one of the shipped silhouettes. Absent on a row that has no
   * file behind it (a session), which keeps the column so both trees line up.
   */
  readonly icon?: IconKind;
```

Import `type { IconKind } from '../files/tree.js'`.

- [ ] **Step 4: Draw the row icon and indentation**

In `tree-list.html`, add `[style.padding-left.px]="row.depth * 12"` to `<div class="line">`, replace the `<span class="prefix">…</span>` block with nothing, and after the chevron/caret slot insert:

```html
        @if (row.node.icon; as icon) {
          <svg [class]="'file-icon ' + icon" viewBox="0 0 16 16" aria-hidden="true"
               focusable="false"><use [attr.href]="'#morse-' + icon" /></svg>
        } @else {
          <span class="icon-blank" aria-hidden="true"></span>
        }
```

(The caret keeps its own leading column: that is the root's fold mark and is not part of the indent.)

In `tree-list.ts`, delete the `prefix()` method and drop `treePrefix` from the `@morse/ui-runtime` import.

In `tree-list.css`, delete the `.prefix` rule and add:

```css
/* The icon column: 14px for every row, blank on a row with no file behind it. */
.file-icon,
.icon-blank {
  flex: none;
  width: 14px;
  height: 14px;
}
```

- [ ] **Step 5: Add the sprite and the kind colours**

In `packages/ui-angular/src/app/shell/app.html`, as the first child of the `.shell` div:

```html
  <!-- Every file-type mark the tree draws. One copy in the document, because the
       VS Code webview cannot fetch an external sprite; `hidden` keeps it out of flow. -->
  <svg class="icon-sprite" hidden aria-hidden="true">
    <symbol id="morse-folder" viewBox="0 0 16 16">…</symbol>
    <symbol id="morse-folder-open" viewBox="0 0 16 16">…</symbol>
    <symbol id="morse-generic" viewBox="0 0 16 16">…</symbol>
    <symbol id="morse-code" viewBox="0 0 16 16">…</symbol>
    <symbol id="morse-data" viewBox="0 0 16 16">…</symbol>
    <symbol id="morse-markdown" viewBox="0 0 16 16">…</symbol>
    <symbol id="morse-image" viewBox="0 0 16 16">…</symbol>
    <symbol id="morse-shell" viewBox="0 0 16 16">…</symbol>
    <symbol id="morse-sql" viewBox="0 0 16 16">…</symbol>
    <symbol id="morse-lock" viewBox="0 0 16 16">…</symbol>
    <symbol id="morse-git" viewBox="0 0 16 16">…</symbol>
  </svg>
```

Each `…` is one 16×16 shape, `fill="none" stroke="currentColor" stroke-width="1.2"` throughout so the kind's colour comes from CSS: `folder` a closed tab-topped folder; `folder-open` the same with its lid tilted; `generic` a page with a folded corner; `code` a page with `</>` as two chevrons; `data` a page with two horizontal bars (braces); `markdown` a page with a short down-arrow and bar (`↓│`); `image` a page with a mountain and a dot; `shell` a page with `>_`; `sql` a database drum (three stacked ellipses); `lock` a padlock; `git` a branch (a node, a curve, a second node).

In `packages/ui-angular/src/styles.css`, after the theme variables:

```css
/* The file-type marks. One colour per kind, read on both the light and the dark theme. */
.file-icon {
  color: var(--morse-fg-muted);
}
.file-icon.code { color: #4b9fd5; }
.file-icon.data { color: #b08d3f; }
.file-icon.markdown { color: #7aa2c8; }
.file-icon.image { color: #3fae90; }
.file-icon.shell { color: #6aa84f; }
.file-icon.sql { color: #c8843f; }
.file-icon.lock { color: #9a8fb5; }
.file-icon.git { color: #d1603f; }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -w @morse/ui-angular`
Expected: PASS — including `shell/conventions.spec.ts` (no inline templates were added).

- [ ] **Step 7: Commit**

```bash
git add packages/ui-runtime/src/ui/tree-list.ts packages/ui-angular/src/app/shell/app.html \
  packages/ui-angular/src/styles.css packages/ui-angular/src/app/ui/tree-list
git commit -m "feat(ui): draw an icon per tree row and indent instead of connecting"
```

---

### Task 3: The Explorer passes a kind per node

**Files:**
- Modify: `packages/ui-angular/src/app/features/file-explorer/file-explorer.ts`
- Modify: `packages/ui-angular/src/app/features/file-explorer/file-explorer.html`
- Test: `packages/ui-angular/src/app/features/file-explorer/file-explorer.spec.ts`

**Interfaces:**
- Consumes: `fileIcon()` and `IconKind` from Task 1; `TreeNode.icon` and the `svg.file-icon` contract from Task 2.
- Produces: nothing later tasks use.

- [ ] **Step 1: Write the failing tests**

Append to `packages/ui-angular/src/app/features/file-explorer/file-explorer.spec.ts`, using the helpers already there (`setup`, `settleTree`, `typeFilter`):

```ts
  it('marks a folder closed, then open, then closed again', async () => {
    const { fixture } = setup(['src/main.ts']);
    await settleTree(fixture);
    const folder = (): string | null =>
      fixture.nativeElement.querySelector('.row.group svg.file-icon')?.getAttribute('class') ?? null;
    expect(folder()).toBe('file-icon folder');
    (fixture.nativeElement.querySelector('.row.group') as HTMLElement).click();
    await settleTree(fixture);
    expect(folder()).toBe('file-icon folder-open');
    (fixture.nativeElement.querySelector('.row.group') as HTMLElement).click();
    await settleTree(fixture);
    expect(folder()).toBe('file-icon folder');
  });

  it('marks a file with its extension kind', async () => {
    const { fixture } = setup(['src/main.ts']);
    await settleTree(fixture);
    (fixture.nativeElement.querySelector('.row.group') as HTMLElement).click();
    await settleTree(fixture);
    const row = [...fixture.nativeElement.querySelectorAll('.row')].find((node: Element) =>
      node.textContent?.includes('main.ts'),
    );
    expect(row?.querySelector('svg.file-icon')?.getAttribute('class')).toBe('file-icon code');
  });

  it('gives a search hit the same icon as its tree row', async () => {
    const { fixture } = setup(['src/main.ts']);
    await settleTree(fixture);
    typeFilter(fixture, 'main');
    const hit = fixture.nativeElement.querySelector('.row .name')?.closest('.row');
    expect(hit?.querySelector('svg.file-icon')?.getAttribute('class')).toBe('file-icon code');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @morse/ui-angular`
Expected: FAIL — no `svg.file-icon` inside an Explorer row.

- [ ] **Step 3: Pass the kind from `toNodes()`**

In `file-explorer.ts`: import `fileIcon` from `@morse/ui-runtime`, add `icon: node.kind === 'dir' ? (this.expanded().has(node.path) ? 'folder-open' : 'folder') : fileIcon(node.name),` to the node literal in `toNodes()`, and add `this.expanded()` to that computed's dependency by reading it once in `toNodes` — `const open = this.expanded();` — then using `open.has(...)`. The `nodes` computed now re-runs when a folder folds, which is the point.

- [ ] **Step 4: Draw the icon in the filtered list**

In `file-explorer.html`, replace the `<span class="glyph" …>{{ glyphFor(match.name) }}</span>` with:

```html
            <svg [class]="'file-icon ' + iconFor(match.name)" viewBox="0 0 16 16"
                 aria-hidden="true" focusable="false"><use [attr.href]="'#morse-' + iconFor(match.name)" /></svg>
```

and in `file-explorer.ts` add `protected iconFor = fileIcon;` in place of `protected glyphFor = fileGlyph;` (dropping the now-unused `fileGlyph` import), then delete the `.glyph` rule from `file-explorer.css`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -w @morse/ui-angular`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ui-angular/src/app/features/file-explorer
git commit -m "feat(ui): give the Explorer's rows their file-type icons"
```

---

### Task 4: Whole-suite check

- [ ] **Step 1: Run the fast suite**

Run: `npm run test:fast`
Expected: PASS in `@morse/system`, `@morse/ui-runtime`, `@morse/server`, `@morse/ui-angular`.

- [ ] **Step 2: Run types and lint**

Run: `npm run check-types && npm run lint`
Expected: no output from either.

- [ ] **Step 3: Look at it**

Run: `npm run dev:ui` and open the Explorer. Expected: folders show a closed folder that opens on click; `.ts` files show the code page in blue; no `├─` connectors anywhere; session rows still line up with the file rows.

- [ ] **Step 4: Commit any fix the look demands**

```bash
git add -A packages/ui-angular packages/ui-runtime
git commit -m "fix(ui): tune the file icons against the running app"
```
