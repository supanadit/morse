# Prompt Editor Full-Page Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the browser host, the prompt-template editor becomes a full-page toggle — the tab strip and chat are replaced, while the toolbar, sidebar, and git/search columns stay — instead of a tab in the strip.

**Architecture:** A new `ShellState.promptEditorOpen` signal drives the editor. `App` hides the tab strip and renders the editor as the first branch in `<main>` while the flag is set. `WorkspaceTabs` stops owning a prompt tab; its `openPromptEditor()` toggles the flag on a tabbed host and still sends `openPromptEditor` to VS Code. The editor's unsaved draft already persists in `ViewState`, so closing it loses nothing.

**Tech Stack:** Angular 22 signals, TypeScript, Vitest via `ng test`.

**Spec:** the approved design in the conversation (no spec file).

## Global Constraints

- VS Code (`capabilities.filePreview !== true`) must keep opening its own editor panel via the `openPromptEditor` host command.
- The bottom panel must stay mounted while the editor is open (unmounting it kills shells).
- A persisted `workbench.json` from an older version may contain a `prompt` tab; `restore()` must drop it, not crash.
- No new dependencies.

## Review Focus

- The toolbar prompt button must toggle closed as well as open.
- MCP/git/search must stay reachable while the editor is open (the toolbar stays).
- The tab strip must come back when the editor closes.
- The editor must not reappear as a tab after a reload.

---

### Task 1: Full-page prompt editor toggle

**Files:**
- Modify: `packages/ui-angular/src/app/state/shell-state.ts`
- Modify: `packages/ui-angular/src/app/state/workspace-tabs.ts`
- Modify: `packages/ui-angular/src/app/shell/app.ts`
- Modify: `packages/ui-angular/src/app/shell/app.html`
- Modify: `packages/ui-angular/src/app/features/tab-strip/tab-strip.ts`
- Modify: `packages/ui-angular/src/app/features/command-palette/command-palette.ts`
- Modify: `packages/ui-angular/src/app/shell/toolbar/toolbar.ts`
- Modify: `packages/ui-angular/src/app/shell/toolbar/toolbar.html`
- Test: `packages/ui-angular/src/app/shell/app.session-tabs.spec.ts`
- Test: `packages/ui-angular/src/app/state/workspace-tabs.spec.ts`

**Interfaces:**
- Produces: `ShellState.promptEditorOpen: Signal<boolean>` and `ShellState.togglePromptEditor(): void`.
- Produces: `WorkspaceTabs.openPromptEditor(): void` — toggles `promptEditorOpen` when `capabilities.filePreview === true`, otherwise sends `openPromptEditor` to the host.

- [ ] **Step 1: Write the failing app test** in `app.session-tabs.spec.ts`. Add `import { ShellState } from '../state/shell-state';` and:

```ts
it('replaces the tab strip with the prompt editor while it is open', async () => {
  TestBed.configureTestingModule({
    imports: [App],
    providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new TitledSessionTransport() }],
  });
  const fixture = render();
  const shell = TestBed.inject(ShellState);
  expect(fixture.nativeElement.querySelector('morse-tab-strip')).not.toBeNull();

  shell.togglePromptEditor();
  await vi.waitFor(() => {
    expect(fixture.nativeElement.querySelector('morse-prompt-editor')).not.toBeNull();
  });
  fixture.detectChanges();
  expect(fixture.nativeElement.querySelector('morse-tab-strip')).toBeNull();

  shell.togglePromptEditor();
  fixture.detectChanges();
  expect(fixture.nativeElement.querySelector('morse-prompt-editor')).toBeNull();
  expect(fixture.nativeElement.querySelector('morse-tab-strip')).not.toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w @morse/ui-angular -- --include=src/app/shell/app.session-tabs.spec.ts`
Expected: FAIL — `ShellState.togglePromptEditor` is not a function.

- [ ] **Step 3: Write the failing workspace-tabs test.** In `workspace-tabs.spec.ts`, delete the test `'opens one prompt editor tab and re-focuses it instead of stacking a second'`, and replace `'opens the prompt editor as a tab on a host with a tab strip'` with:

```ts
it('toggles the full-page prompt editor on a host with a tab strip', () => {
  const { tabs, fake } = setup(() => undefined, { filePreview: true });
  const shell = TestBed.inject(ShellState);

  tabs.openPromptEditor();

  expect(shell.promptEditorOpen()).toBe(true);
  expect(tabs.tabs().some((tab) => tab.kind === 'prompt')).toBe(false);
  expect(fake.requestHostCommand).not.toHaveBeenCalledWith('openPromptEditor', expect.anything());
});
```

In `'asks the host to open its own editor panel where there is no tab strip'`, also assert `TestBed.inject(ShellState).promptEditorOpen()` is `false`. Add `import { ShellState } from './shell-state';`.

- [ ] **Step 4: Run it to verify it fails**

Run: `npm run test -w @morse/ui-angular -- --include=src/app/state/workspace-tabs.spec.ts`
Expected: FAIL — `ShellState` has no `promptEditorOpen`.

- [ ] **Step 5: Add the flag to `ShellState`.** Near the MCP manager flag:

```ts
private readonly promptEditor = signal(false);
readonly promptEditorOpen = this.promptEditor.asReadonly();

togglePromptEditor(): void {
  this.promptEditor.update((open) => !open);
}
```

- [ ] **Step 6: Remove the prompt tab from `WorkspaceTabs`.**
  - Delete `PromptTab`, `PersistedPromptTab`, `PROMPT_TAB_ID`, and `openPrompt()`.
  - Remove `PromptTab` from the `WorkspaceTab` union, `'prompt'` from `PersistedTabBase['kind']`, and `PersistedPromptTab` from the `PersistedTab` union.
  - Remove the `prompt` branches in `snapshot()`, `restore()`, `menuScope()`, and `asPersistedTab()`.
  - Inject `ShellState` and rewrite `openPromptEditor()`:

```ts
openPromptEditor(): void {
  if (this.morse.capabilities()?.filePreview === true) {
    this.shell.togglePromptEditor();
  } else {
    void this.morse.requestHostCommand('openPromptEditor', {}).catch(() => undefined);
  }
}
```

- [ ] **Step 7: Wire `App`.**
  - Delete the `activePrompt` computed; add `protected readonly promptEditorOpen = this.shell.promptEditorOpen;`.
  - Change the lazy-load effect to read `this.promptEditorOpen()`.
  - In `app.html`, change the tab strip to `@if (tabsEnabled() && !promptEditorOpen())`.
  - In the content chain, replace `@else if (activePrompt()) { … }` with a first branch `@if (promptEditorOpen()) { <ng-container [ngComponentOutlet]="promptEditorComponent()" /> } @else if (activeMcp()) { … }`.

- [ ] **Step 8: Drop the prompt cases in `tab-strip.ts` and `command-palette.ts`.**
  - `glyph()`: remove the `tab.kind === 'prompt'` branch.
  - `tabEntries`: collapse the `prompt` fallbacks so only `session`/`mcp`/`file` remain.

- [ ] **Step 9: Toolbar.**
  - `toolbar.ts`: `promptsOpen` becomes `this.shell.promptEditorOpen`.
  - `toolbar.html`: title becomes `[title]="promptsOpen() ? 'Prompt templates — open' : 'Edit prompt templates'"`.

- [ ] **Step 10: Run the tests**

Run: `npm run test -w @morse/ui-angular`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/ui-angular/src/app
git commit -m "feat(ui): make the prompt editor a full-page toggle"
```

---

### Task 2: Docs and comments

**Files:**
- Modify: `docs/CONFIGURATION.md:178`
- Modify: `packages/ui-angular/src/app/features/prompt-editor/prompt-editor.ts` (class doc comment)
- Modify: `packages/ui-angular/src/app/features/prompt-editor/prompt-editor-page.ts` (class doc comment)
- Modify: `packages/ui-angular/src/app/shell/app.ts` (shortcut and restore comments)

- [ ] **Step 1: Update `docs/CONFIGURATION.md`.** Replace "the browser host opens a **Prompt templates** tab next to the sessions" with wording that the browser host replaces the tab strip and chat with the full-page editor, toggled again to go back.

- [ ] **Step 2: Update the doc comments** so they say the browser host shows the editor full-page, not in a tab.

- [ ] **Step 3: Commit**

```bash
git add docs/CONFIGURATION.md packages/ui-angular/src/app
git commit -m "docs: describe the full-page prompt editor"
```

---

## Self-review

- **Spec coverage:** full-page toggle (Task 1), toolbar stays (Task 1 Step 9), no tab (Task 1 Step 6), VS Code unchanged (Task 1 Step 6), draft preserved (already in `ViewState`), docs (Task 2).
- **Step scan:** each step is one action with a checkable result; no step decides nothing.
- **Type consistency:** `promptEditorOpen` / `togglePromptEditor` are defined in Task 1 Step 5 and used in Steps 6–9.
- **Review Focus:** toggle-closed (Step 1), MCP/git/search reachable (Step 9 leaves the toolbar), strip returns (Step 1), no tab after reload (Step 6 drops persisted prompt tabs).
- **Proportion:** the plan is shorter than the code it describes; no bodies beyond the two small signatures the tests pin.
