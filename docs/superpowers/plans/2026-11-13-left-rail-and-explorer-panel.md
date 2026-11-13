# Left Rail and Explorer Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the Explorer back on the web shell as the second face of the left column, behind a VS Code-style activity rail.

**Architecture:** A new `morse-activity-rail` occupies a fixed 48px grid area at the far left. The existing left column becomes a wrapper with two mounted views — `morse-session-nav` (always) and `morse-file-explorer` (mounted on first use) — and `ShellState.leftPane` decides which is visible. The Explorer loses its drag-height frame and fills the column. VS Code and the embedded surface never mount the rail or the Explorer.

**Tech Stack:** Angular 20 standalone components, signals, OnPush, Vitest + TestBed, CSS grid areas.

**Spec:** `docs/superpowers/specs/2026-11-13-left-rail-and-explorer-panel-design.md`

## Global Constraints

- Rail only when `capabilities.filePreview === true` **and** the shell is not `embedded`.
- Rail is 48px wide; entries are 40px; order is **Sessions** then **Explorer**; no other entries.
- Panel width stays `--morse-nav-width` (272px base, 288px web) and the `'left'` size, dragged by the wrapper's handle.
- Stored view key is exactly `morse.left.pane`, values `sessions` | `files`, default `sessions`.
- A host without `filePreview` shows no rail and always faces sessions, without overwriting a stored `files`.
- `SessionNav` stays mounted when Files is in front (its `session.new` / `session.search` / `project.filter` bindings).
- `FileExplorer` mounts on the first Files selection and then stays mounted.
- Delete the Explorer's height state: no `'explorer'` in `PaneId`, no `--morse-explorer-height`, no `explorerSize()`.
- No new keyboard shortcut, no third rail entry, no rail in VS Code or the embedded tab.
- Focused test command runs from `packages/ui-angular`: `npm test -- --watch=false --include='<glob>'`.
- Full gate runs from the repo root: `npm run test:fast`.

## Review Focus

- **A VS Code host with a stored `files` view.** It must render no rail and the session list, not a blank column. Pinned in Task 5 (`does not mount the rail without filePreview`).
- **A folded left column.** The rail must stay on screen, and choosing Files must still open the panel. Pinned in Tasks 2 and 5.
- **A narrow window (<760px).** Clicking the active entry must toggle the drawer, and must not rewrite the stored desktop fold. Pinned in Task 2.
- **No session open.** Choosing Files must mount the Explorer and allow opening a file. Pinned in Task 5 (`shows the Explorer with no session in front`).
- **Swapping faces with a search typed.** The session search value must survive Files → Sessions. Pinned in Task 5 (`keeps the session view's state across a swap`).

---

### Task 1: Left pane state

**Files:**
- Modify: `packages/ui-angular/src/app/state/shell-state.ts`
- Test: `packages/ui-angular/src/app/state/shell-state.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export type LeftPane = 'sessions' | 'files'`; `ShellState.leftPane: Signal<LeftPane>`; `ShellState.setLeftPane(pane: LeftPane): void`; storage key `morse.left.pane`.

- [ ] **Step 1: Write the failing test**

Add inside `describe('ShellState')` in `shell-state.spec.ts`:

```ts
it('remembers which face the left column shows', () => {
  const shell = TestBed.inject(ShellState);
  expect(shell.leftPane()).toBe('sessions');

  shell.setLeftPane('files');
  expect(localStorage.getItem('morse.left.pane')).toBe('files');

  TestBed.resetTestingModule();
  expect(TestBed.inject(ShellState).leftPane()).toBe('files');

  // A stored value that names no view falls back to the list.
  localStorage.setItem('morse.left.pane', 'garbage');
  TestBed.resetTestingModule();
  expect(TestBed.inject(ShellState).leftPane()).toBe('sessions');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --watch=false --include='src/app/state/shell-state.spec.ts'`
Expected: FAIL with `shell.leftPane is not a function`.

- [ ] **Step 3: Implement the state**

In `shell-state.ts`, beside `RightPane`:

```ts
export type LeftPane = 'sessions' | 'files';
```

Beside `RIGHT_PANE_KEY`, add `const LEFT_PANE_KEY = 'morse.left.pane';` and the two readers, mirroring `readRightPane` / `storeRightPane`:

```ts
function readLeftPane(): LeftPane {
  try {
    return globalThis.localStorage?.getItem(LEFT_PANE_KEY) === 'files' ? 'files' : 'sessions';
  } catch {
    return 'sessions';
  }
}

function storeLeftPane(pane: LeftPane): void {
  try {
    globalThis.localStorage?.setItem(LEFT_PANE_KEY, pane);
  } catch {
    // Storage is a nicety, not a requirement.
  }
}
```

Beside `rightPaneSignal`, add:

```ts
private readonly leftPaneSignal = signal<LeftPane>(readLeftPane());
readonly leftPane = this.leftPaneSignal.asReadonly();

setLeftPane(pane: LeftPane): void {
  storeLeftPane(pane);
  this.leftPaneSignal.set(pane);
}
```

Update the `rightPane` doc comment only if it claims to be the only stored face; otherwise leave it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --watch=false --include='src/app/state/shell-state.spec.ts'`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui-angular/src/app/state/shell-state.ts packages/ui-angular/src/app/state/shell-state.spec.ts
git commit -m "feat(ui): remember which face the left column shows"
```

---

### Task 2: Activity rail component

**Files:**
- Create: `packages/ui-angular/src/app/features/activity-rail/activity-rail.ts`
- Create: `packages/ui-angular/src/app/features/activity-rail/activity-rail.html`
- Create: `packages/ui-angular/src/app/features/activity-rail/activity-rail.css`
- Test: `packages/ui-angular/src/app/features/activity-rail/activity-rail.spec.ts`

**Interfaces:**
- Consumes: `ShellState.leftPane`, `setLeftPane('sessions' | 'files')`, `openNavigation()`, `toggleNavigation()`, `navigationOpen`; `LayoutState.leftCollapsed`, `setVisible('left', boolean)`, `toggleVisible('left')`; `LeftPane` from Task 1.
- Produces: `ActivityRail`, selector `morse-activity-rail`, no inputs. Renders `nav.views > button.entry` in Sessions-then-Explorer order, with `aria-label` values `Sessions view` and `Explorer view`.

- [ ] **Step 1: Write the failing tests**

Create `activity-rail.spec.ts`:

```ts
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayoutState } from '../../state/layout-state';
import { ShellState } from '../../state/shell-state';
import { ActivityRail } from './activity-rail';

function render(): ComponentFixture<ActivityRail> {
  TestBed.configureTestingModule({ imports: [ActivityRail] });
  const fixture = TestBed.createComponent(ActivityRail);
  fixture.detectChanges();
  return fixture;
}

function entries(fixture: ComponentFixture<ActivityRail>): HTMLButtonElement[] {
  return [...fixture.nativeElement.querySelectorAll('.views .entry')] as HTMLButtonElement[];
}

function stubNarrow(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

describe('ActivityRail', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('lists Sessions then Explorer, with the session list in front', () => {
    const fixture = render();

    expect(entries(fixture).map((entry) => entry.getAttribute('aria-label'))).toEqual([
      'Sessions view',
      'Explorer view',
    ]);
    expect(entries(fixture).map((entry) => entry.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
    ]);
  });

  it('switches to Files and reopens a folded column', () => {
    TestBed.inject(LayoutState).setVisible('left', false);
    const fixture = render();

    entries(fixture)[1].click();
    fixture.detectChanges();

    expect(TestBed.inject(ShellState).leftPane()).toBe('files');
    expect(TestBed.inject(LayoutState).leftCollapsed()).toBe(false);
    expect(entries(fixture)[1].getAttribute('aria-pressed')).toBe('true');
  });

  it('folds and unfolds the panel when the active view is chosen again', () => {
    const fixture = render();
    const layout = TestBed.inject(LayoutState);

    entries(fixture)[0].click();
    fixture.detectChanges();
    expect(layout.leftCollapsed()).toBe(true);
    expect(fixture.nativeElement.querySelector('.views')).not.toBeNull();

    entries(fixture)[0].click();
    fixture.detectChanges();
    expect(layout.leftCollapsed()).toBe(false);
  });

  it('drives the drawer on a narrow layout, leaving the stored fold alone', () => {
    stubNarrow();
    const fixture = render();
    const shell = TestBed.inject(ShellState);
    const layout = TestBed.inject(LayoutState);

    entries(fixture)[0].click();
    fixture.detectChanges();
    expect(shell.navigationOpen()).toBe(true);
    expect(layout.leftCollapsed()).toBe(false);

    entries(fixture)[1].click();
    fixture.detectChanges();
    expect(shell.leftPane()).toBe('files');
    expect(shell.navigationOpen()).toBe(true);

    entries(fixture)[1].click();
    fixture.detectChanges();
    expect(shell.navigationOpen()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --watch=false --include='src/app/features/activity-rail/activity-rail.spec.ts'`
Expected: FAIL to resolve `./activity-rail`.

- [ ] **Step 3: Write the component**

`activity-rail.ts`:

```ts
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LayoutState } from '../../state/layout-state';
import { ShellState, type LeftPane } from '../../state/shell-state';

@Component({
  selector: 'morse-activity-rail',
  templateUrl: './activity-rail.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './activity-rail.css',
})
export class ActivityRail {
  private readonly shell = inject(ShellState);
  private readonly layout = inject(LayoutState);

  protected readonly leftPane = this.shell.leftPane;

  protected select(pane: LeftPane): void {
    // CSS decides which toggle is on screen; the handler only has to match it.
    const wide = globalThis.matchMedia?.('(min-width: 760px)').matches ?? true;
    if (pane !== this.shell.leftPane()) {
      this.shell.setLeftPane(pane);
      if (wide) {
        this.layout.setVisible('left', true);
      } else {
        this.shell.openNavigation();
      }
      return;
    }
    if (wide) {
      this.layout.toggleVisible('left');
    } else {
      this.shell.toggleNavigation();
    }
  }
}
```

`activity-rail.html`:

```html
<nav class="views" aria-label="Views">
  <button
    type="button"
    class="entry"
    [class.active]="leftPane() === 'sessions'"
    [attr.aria-pressed]="leftPane() === 'sessions'"
    aria-label="Sessions view"
    title="Sessions"
    (click)="select('sessions')"
  >
    <svg class="mark" viewBox="0 0 16 16" aria-hidden="true">
      <use href="#morse-session" />
    </svg>
  </button>
  <button
    type="button"
    class="entry"
    [class.active]="leftPane() === 'files'"
    [attr.aria-pressed]="leftPane() === 'files'"
    aria-label="Explorer view"
    title="Explorer"
    (click)="select('files')"
  >
    <svg class="mark" viewBox="0 0 16 16" aria-hidden="true">
      <use href="#morse-folder" />
    </svg>
  </button>
</nav>
```

`activity-rail.css`:

```css
:host {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--morse-bg);
  border-right: 1px solid var(--morse-border);
}

.views {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 0;
}

.entry {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 0;
  border-radius: var(--morse-radius-md);
  background: transparent;
  color: var(--morse-fg-muted);
  cursor: pointer;
}

.entry:hover,
.entry:focus-visible {
  background: var(--morse-hover);
  color: var(--morse-fg);
}

.entry.active {
  color: var(--morse-fg);
}

.entry.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 2px;
  background: var(--morse-accent);
}

.mark {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.3;
  stroke-linecap: round;
  stroke-linejoin: round;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --watch=false --include='src/app/features/activity-rail/activity-rail.spec.ts'`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui-angular/src/app/features/activity-rail
git commit -m "feat(ui): add the left activity rail"
```

---

### Task 3: The Explorer becomes a column panel

**Files:**
- Modify: `packages/ui-angular/src/app/features/file-explorer/file-explorer.ts`
- Modify: `packages/ui-angular/src/app/features/file-explorer/file-explorer.html`
- Modify: `packages/ui-angular/src/app/features/file-explorer/file-explorer.css`
- Test: `packages/ui-angular/src/app/features/file-explorer/file-explorer.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `FileExplorer` keeps selector `morse-file-explorer`, inputs/outputs unchanged (none), and no longer exposes a fold or a height. It fills its parent.

- [ ] **Step 1: Replace the height/fold tests with the column test**

In `file-explorer.spec.ts`, delete the tests `offers a resize handle only while the pane is open` and `takes its height from the shell, never from its own template` (around lines 433-462). Remove the now-unused `LayoutState` import. Add:

```ts
it('fills its column with no resize handle and no fold control', async () => {
  const { fixture } = setup(['a.ts']);
  await flush();
  fixture.detectChanges();

  expect(fixture.nativeElement.querySelector('.resize')).toBeNull();
  expect(fixture.nativeElement.querySelector('.pane-fold')).toBeNull();
  expect(fixture.nativeElement.style.height).toBe('');
  expect(fixture.nativeElement.querySelector('morse-pane .pane-title')?.textContent).toBe(
    'Explorer',
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --watch=false --include='src/app/features/file-explorer/file-explorer.spec.ts'`
Expected: FAIL: `.resize` is found and/or `.pane-fold` exists.

- [ ] **Step 3: Strip the frame**

In `file-explorer.ts`:

- Remove the `Splitter` import, `MIN_EXPLORER_HEIGHT`, the `folded` signal, the `collapsed` getter, the `toggleFold()` method and the `explorerMax` field.
- Remove the `host` metadata block (`[class.folded]`).
- Remove `Splitter` from `imports`, and remove the unused `ShellState` injection and its import.
- Keep `rowsEl`, `refresh()`, all tree/filter logic unchanged.

In `file-explorer.html`:

- Delete the opening `@if (!collapsed()) { <div class="resize" ...>...</div> }` block.
- Remove `[folded]="collapsed()"` and `(foldToggle)="toggleFold()"` from `<morse-pane>`.
- Remove both `@if (!collapsed()) {` wrappers around the filter and the rows, and their closing braces.

In `file-explorer.css`, replace the host block and remove `.resize`:

```css
:host {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: var(--morse-nav-bg);
  border-right: 1px solid var(--morse-border);
}

morse-pane {
  flex: 1;
  min-height: 0;
}
```

Keep `.icon`, `.rows`, `.filter`, `.row`, `.name`, `.dir`, `.hint` rules as they are.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --watch=false --include='src/app/features/file-explorer/file-explorer.spec.ts'`
Expected: PASS (all remaining tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui-angular/src/app/features/file-explorer
git commit -m "refactor(ui): make the Explorer fill a column"
```

---

### Task 4: Retire the Explorer's height state

**Files:**
- Modify: `packages/ui-angular/src/app/state/layout-state.ts`
- Modify: `packages/ui-angular/src/app/shell/app.ts`
- Modify: `packages/ui-angular/src/app/shell/app.html`
- Modify: `packages/ui-angular/src/app/state/layout-state.spec.ts`
- Modify: `packages/ui-angular/src/app/ui/splitter/splitter.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PaneId = 'changes' | 'detail'`; `SizeId` no longer accepts `'explorer'`; `explorerSize()` is gone.

- [ ] **Step 1: Update the tests to the smaller pane set**

In `layout-state.spec.ts`, rewrite the test that starts `clamps and remembers a pane height` so it uses `'changes'` only (drop the Explorer assertions), keeping the non-persisting preview, the stored value, the lower clamp (`setSize('changes', 10)` → `48`), and the double-click reset (`setSize('changes', undefined)` → `undefined`, key `morse.git.changesHeight` removed).

In `splitter.spec.ts`, change the host template and assertions from `'explorer'` to `'changes'`:

```ts
[morseSplitter]="'changes'"
edge="top"
[min]="48"
[max]="400"
label="Resize the changes section"
```

Use `changesSize()`, key `morse.git.changesHeight`, and expect the lower clamp `48`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --watch=false --include='src/app/state/layout-state.spec.ts' --include='src/app/ui/splitter/splitter.spec.ts'`
Expected: FAIL: `setSize('explorer', …)` no longer typed / lower clamp still 140.

- [ ] **Step 3: Remove the pane**

In `layout-state.ts`:

- `PaneId` → `'changes' | 'detail'`.
- `PANE_MIN` / `PANE_MAX` lose their `explorer` entries.
- `isPane()` drops `id === 'explorer'`.
- `SIZE_KEYS` drops `explorer: 'morse.explorer.height'`.
- The `panes` signal and its initializer drop `explorer`.
- Delete the `explorerSize` computed.
- Update the comments that list the Explorer as a sized pane (the `PaneId` doc and the stored-keys doc).

In `app.ts`, delete the `explorerHeight` computed.

In `app.html`, remove `[style.--morse-explorer-height]="explorerHeight()"` from `.shell`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --watch=false --include='src/app/state/layout-state.spec.ts' --include='src/app/ui/splitter/splitter.spec.ts'`
Expected: PASS (11 + 3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui-angular/src/app/state/layout-state.ts packages/ui-angular/src/app/state/layout-state.spec.ts \
  packages/ui-angular/src/app/ui/splitter/splitter.spec.ts packages/ui-angular/src/app/shell/app.ts \
  packages/ui-angular/src/app/shell/app.html
git commit -m "refactor(ui): retire the Explorer's drag height"
```

---

### Task 5: Shell wiring — rail, two-face panel, moved handle

**Files:**
- Modify: `packages/ui-angular/src/app/shell/app.ts`
- Modify: `packages/ui-angular/src/app/shell/app.html`
- Modify: `packages/ui-angular/src/app/shell/app.css`
- Modify: `packages/ui-angular/src/app/features/session-nav/session-nav.ts`
- Modify: `packages/ui-angular/src/app/features/session-nav/session-nav.html`
- Modify: `packages/ui-angular/src/app/features/session-nav/session-nav.css`
- Modify: `packages/ui-angular/src/app/shell/app.bottom-panel.spec.ts`
- Modify: `packages/ui-angular/src/app/shell/app.embedded.spec.ts`
- Test: `packages/ui-angular/src/app/shell/app.rail.spec.ts` (create)

**Interfaces:**
- Consumes: `ActivityRail` (Task 2), `LeftPane`/`ShellState.leftPane` (Task 1), `FileExplorer` (Task 3), `LayoutState` without `explorer` (Task 4).
- Produces: `.shell.with-rail`; `.nav` wrapper containing `.edge-resize[:morseSplitter='left']` and `.left-view` children; App's `filesEnabled`, `leftPane`, `filesMounted` signals.

- [ ] **Step 1: Write the failing shell tests**

Create `app.rail.spec.ts` with a host that can switch the three facts the rail cares about:

```ts
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { PROTOCOL_VERSION, type ClientToHostMessage } from '@morse/protocol';
import { BaseHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './app';
import { LayoutState } from '../state/layout-state';
import { ShellState } from '../state/shell-state';
import { MORSE_TRANSPORT } from '../host/transport.token';

class RailHostTransport extends BaseHostTransport {
  readonly kind = 'memory' as const;

  constructor(
    private readonly sessionId: string | null = 'session-1',
    private readonly filePreview = true,
  ) {
    super();
  }

  connect(): void {
    this.emitStatus('open');
  }

  dispose(): void {
    this.emitStatus('closed');
  }

  send(message: ClientToHostMessage): void {
    if (message.type !== 'client/ready') {
      return;
    }
    this.emitMessage({
      type: 'host/ready',
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          hostKind: 'server',
          scope: 'global',
          editorContext: false,
          nativeDialogs: false,
          insertIntoEditor: false,
          revealFile: false,
          ...(this.filePreview ? { filePreview: true } : {}),
        },
        state: {
          ...(this.sessionId ? { sessionId: this.sessionId } : {}),
          workspace: { cwd: '/work/morse', name: 'morse' },
          thinkingLevel: 'off',
          availableModels: [],
          availableThinkingLevels: [],
          availableCommands: [],
          streaming: false,
          busy: false,
          agentReady: true,
          agentStarting: false,
        },
      },
    });
  }
}

function render(sessionId: string | null = 'session-1', filePreview = true) {
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      { provide: MORSE_TRANSPORT, useFactory: () => new RailHostTransport(sessionId, filePreview) },
    ],
  });
  const fixture = TestBed.createComponent(App);
  fixture.detectChanges();
  return fixture;
}

function entries(fixture: ComponentFixture<App>): HTMLButtonElement[] {
  return [
    ...(fixture.nativeElement as HTMLElement).querySelectorAll('morse-activity-rail .entry'),
  ] as HTMLButtonElement[];
}

describe('App left rail', () => {
  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('opens on the session list behind the rail', () => {
    const fixture = render();
    const host = fixture.nativeElement as HTMLElement;
    const nav = host.querySelector('morse-session-nav') as HTMLElement;

    expect(host.querySelector('morse-activity-rail')).not.toBeNull();
    expect(nav).not.toBeNull();
    expect(nav.hasAttribute('hidden')).toBe(false);
    expect(host.querySelector('morse-file-explorer')).toBeNull();
  });

  it('swaps the column to Files and back, keeping the handle', () => {
    const fixture = render();
    const host = fixture.nativeElement as HTMLElement;

    entries(fixture)[1].click();
    fixture.detectChanges();
    const explorer = host.querySelector('morse-file-explorer') as HTMLElement;
    expect(explorer).not.toBeNull();
    expect(explorer.hasAttribute('hidden')).toBe(false);
    expect((host.querySelector('morse-session-nav') as HTMLElement).hasAttribute('hidden')).toBe(true);
    expect(host.querySelector('.nav .edge-resize')).not.toBeNull();

    entries(fixture)[0].click();
    fixture.detectChanges();
    expect((host.querySelector('morse-session-nav') as HTMLElement).hasAttribute('hidden')).toBe(false);
  });

  it('keeps the rail when the column folds', () => {
    const fixture = render();
    TestBed.inject(LayoutState).setVisible('left', false);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('morse-activity-rail')).not.toBeNull();
    expect((host.querySelector('morse-session-nav') as HTMLElement).hasAttribute('hidden')).toBe(false);

    entries(fixture)[1].click();
    fixture.detectChanges();
    expect(TestBed.inject(LayoutState).leftCollapsed()).toBe(false);
    expect(host.querySelector('morse-file-explorer')).not.toBeNull();
  });

  it('applies a stored Files view', () => {
    localStorage.setItem('morse.left.pane', 'files');
    const fixture = render();
    const host = fixture.nativeElement as HTMLElement;

    expect(TestBed.inject(ShellState).leftPane()).toBe('files');
    expect((host.querySelector('morse-file-explorer') as HTMLElement).hasAttribute('hidden')).toBe(false);
  });

  it('does not mount the rail without filePreview, even with a stored Files view', () => {
    localStorage.setItem('morse.left.pane', 'files');
    const fixture = render('session-1', false);
    const host = fixture.nativeElement as HTMLElement;
    const nav = host.querySelector('morse-session-nav') as HTMLElement;

    expect(host.querySelector('morse-activity-rail')).toBeNull();
    expect(nav).not.toBeNull();
    expect(nav.hasAttribute('hidden')).toBe(false);
    expect(host.querySelector('morse-file-explorer')).toBeNull();
  });

  it('shows the Explorer with no session in front', () => {
    const fixture = render(null);
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('morse-empty-session')).not.toBeNull();
    entries(fixture)[1].click();
    fixture.detectChanges();
    expect(host.querySelector('morse-file-explorer')).not.toBeNull();
  });

  it("keeps the session view's state across a swap", () => {
    const fixture = render();
    const host = fixture.nativeElement as HTMLElement;
    const search = host.querySelector('morse-session-nav input[type="search"]') as HTMLInputElement;

    search.value = 'rail';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    entries(fixture)[1].click();
    fixture.detectChanges();
    entries(fixture)[0].click();
    fixture.detectChanges();

    const again = host.querySelector('morse-session-nav input[type="search"]') as HTMLInputElement;
    expect(again.value).toBe('rail');
  });
});
```

Add to `app.embedded.spec.ts`, in `does not render the Morse sidebar the window already has`:

```ts
expect(host.querySelector('morse-activity-rail')).toBeNull();
```

In `app.bottom-panel.spec.ts`, update the two Explorer assertions to say "not mounted until Files is chosen" (keep `toBeNull()`; change the comments), and assert the rail is present in the filePreview host:

```ts
expect(host.querySelector('morse-activity-rail')).not.toBeNull();
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --watch=false --include='src/app/shell/**/*.spec.ts'`
Expected: FAIL: no `morse-activity-rail`, no `.nav .edge-resize`, the Explorer never mounts.

- [ ] **Step 3: Wire the shell**

`app.ts`:

- Import `ActivityRail`, `FileExplorer`, `Splitter`, and `type LeftPane`.
- Add `ActivityRail`, `FileExplorer`, `Splitter` to `imports`.
- Add:

```ts
protected readonly filesEnabled = computed(
  () => this.morse.capabilities()?.filePreview === true,
);
/** The face the column shows: no files view means the list, whatever was stored. */
protected readonly leftPane = computed<LeftPane>(() =>
  this.filesEnabled() ? this.shell.leftPane() : 'sessions',
);
private readonly filesSeen = signal(false);
protected readonly filesMounted = computed(
  () => this.filesEnabled() && (this.leftPane() === 'files' || this.filesSeen()),
);
```

- In the constructor, after `inject(WorkbenchPersistence)`:

```ts
// Once Files has been opened, it stays mounted (hidden) so its tree, filter and
// scroll survive a swap back to the session list.
effect(() => {
  const files = this.leftPane() === 'files';
  untracked(() => {
    if (files) {
      this.filesSeen.set(true);
    }
  });
});
```

Add `untracked` to the `@angular/core` import list.

`app.html`:

- On `.shell`, add `[class.with-rail]="filesEnabled() && !embedded()"`.
- Replace the single `<morse-session-nav class="nav" [class.open]="navigationOpen()" />` with:

```html
@if (filesEnabled() && !embedded()) {
  <morse-activity-rail class="rail" />
}

@if (!embedded()) {
  <div class="nav" [class.open]="navigationOpen()">
    <div
      class="edge-resize"
      [morseSplitter]="'left'"
      edge="right"
      [min]="220"
      label="Resize the navigation column"
      title="Drag to resize"
    ></div>
    <morse-session-nav class="left-view" [hidden]="leftPane() !== 'sessions'" />
    @if (filesMounted()) {
      <morse-file-explorer class="left-view" [hidden]="leftPane() !== 'files'" />
    }
  </div>
}
```

`session-nav.html`: delete the top `.edge-resize` block. `session-nav.ts`: remove `Splitter` from the imports array and its import. `session-nav.css`: delete `.edge-resize`, `.edge-resize:hover`, `.edge-resize:active`; move them to `app.css` (next rule).

`app.css`:

- Add `--morse-rail-width: 48px;` to `styles.css` beside `--morse-nav-width`.
- Replace the grid templates with named areas. The matrix:

```css
.shell {
  grid-template-areas: "nav main";
  grid-template-columns: var(--morse-nav-width) minmax(0, 1fr);
}
.shell.with-git,
.shell.with-search {
  grid-template-areas: "nav main git";
  grid-template-columns: var(--morse-nav-width) minmax(0, 1fr) var(--morse-git-width);
}
.shell.with-rail {
  grid-template-areas: "rail nav main";
  grid-template-columns: var(--morse-rail-width) var(--morse-nav-width) minmax(0, 1fr);
}
.shell.with-rail.with-git,
.shell.with-rail.with-search {
  grid-template-areas: "rail nav main git";
  grid-template-columns:
    var(--morse-rail-width) var(--morse-nav-width) minmax(0, 1fr) var(--morse-git-width);
}
.shell.git-expanded {
  grid-template-areas: "nav git";
  grid-template-columns: var(--morse-nav-width) minmax(0, 1fr);
}
.shell.with-rail.git-expanded {
  grid-template-areas: "rail nav git";
  grid-template-columns: var(--morse-rail-width) var(--morse-nav-width) minmax(0, 1fr);
}
.shell.embedded,
.shell.embedded.with-rail,
.shell.embedded.with-git,
.shell.embedded.with-search,
.shell.embedded.git-expanded,
.shell.embedded.with-rail.with-git,
.shell.embedded.with-rail.with-search,
.shell.embedded.with-rail.git-expanded,
.shell.embedded.collapsed,
.shell.embedded.collapsed.with-rail,
.shell.embedded.collapsed.with-git,
.shell.embedded.collapsed.with-search,
.shell.embedded.collapsed.git-expanded,
.shell.embedded.collapsed.with-rail.with-git,
.shell.embedded.collapsed.with-rail.with-search,
.shell.embedded.collapsed.with-rail.git-expanded {
  grid-template-areas: "main";
  grid-template-columns: minmax(0, 1fr);
}
```

- Replace the `.nav, .chat, .git-panel, .search-panel { grid-row: 2 }` block with area assignments:

```css
.rail {
  grid-area: rail;
}
.nav {
  grid-area: nav;
  display: flex;
  flex-direction: column;
  position: relative;
  min-width: 0;
  min-height: 0;
  height: 100%;
}
.chat {
  grid-area: main;
}
.git-panel,
.search-panel {
  grid-area: git;
  min-width: 0;
}
.left-view {
  flex: 1;
  min-height: 0;
}
.left-view[hidden] {
  display: none;
}
.edge-resize {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  width: 6px;
  z-index: 3;
  cursor: ew-resize;
}
.edge-resize:hover,
.edge-resize:active {
  background: color-mix(in srgb, var(--morse-accent) 45%, transparent);
}
```

- In the `@media (min-width: 760px)` block, add the rail variants after the existing collapsed rules:

```css
.shell.collapsed.with-rail {
  grid-template-columns: var(--morse-rail-width) 0 minmax(0, 1fr);
}
.shell.collapsed.with-rail.with-git,
.shell.collapsed.with-rail.with-search {
  grid-template-columns:
    var(--morse-rail-width) 0 minmax(0, 1fr) var(--morse-git-width);
}
.shell.collapsed.with-rail.git-expanded {
  grid-template-columns: var(--morse-rail-width) 0 minmax(0, 1fr);
}
```

- In the `@media (max-width: 759px)` block: replace `grid-row: auto` on `.nav`, `.git-panel` and `.search-panel` with `grid-area: auto`, and add:

```css
.shell.with-rail .nav {
  left: var(--morse-rail-width);
  width: min(100% - 96px, 420px);
}
.rail {
  position: relative;
  z-index: 25;
}
```

- In the narrow `.git-panel, .search-panel` rule, `grid-row: auto` becomes `grid-area: auto`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --watch=false --include='src/app/shell/**/*.spec.ts'`
Expected: PASS (9 files, all tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui-angular/src/app/shell packages/ui-angular/src/app/features/session-nav \
  packages/ui-angular/src/styles.css
git commit -m "feat(ui): put the Explorer behind a left activity rail"
```

---

### Task 6: Point the old design note here, run the full gate

**Files:**
- Modify: `docs/superpowers/specs/2026-11-13-web-shell-redesign-design.md`
- Test: whole repo

**Interfaces:**
- Consumes: everything above.
- Produces: no code; a closed loop in the docs.

- [ ] **Step 1: Update the old note**

In `docs/superpowers/specs/2026-11-13-web-shell-redesign-design.md`, under "What's left to the builder", replace the Explorer bullet with:

```md
- ~~Whether the unmounted Explorer becomes a `Files` mode in the bar or is deleted.~~ It became the rail's
  `Files` view: `2026-11-13-left-rail-and-explorer-panel-design.md`.
```

- [ ] **Step 2: Run the full gate**

Run (repo root): `npm run test:fast`
Expected: every workspace suite passes, including the new `activity-rail.spec.ts` and `app.rail.spec.ts`.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-11-13-web-shell-redesign-design.md
git commit -m "docs: record where the Explorer went"
```
