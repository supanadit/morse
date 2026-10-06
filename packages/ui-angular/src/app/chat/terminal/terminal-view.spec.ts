import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The view mounts real Terminal components, which build xterm emulators; jsdom
// has no layout or canvas, so the emulator is mocked here. The mocks carry the
// production shape — the CJS module under `default` — so the lazy import's
// unwrapping is exercised, not bypassed.
vi.mock('@xterm/xterm', () => ({
  default: {
    Terminal: class {
      cols = 80;
      rows = 24;
      open(): void {}
      loadAddon(): void {}
      onData() {
        return { dispose: () => undefined };
      }
      onResize() {
        return { dispose: () => undefined };
      }
      onTitleChange() {
        return { dispose: () => undefined };
      }
      write(): void {}
      reset(): void {}
      focus(): void {}
      dispose(): void {}
    },
  },
}));
vi.mock('@xterm/addon-fit', () => ({ default: { FitAddon: class { fit(): void {} } } }));
vi.mock('@xterm/addon-webgl', () => ({
  default: {
    WebglAddon: class {
      onContextLoss(): void {}
      dispose(): void {}
    },
  },
}));

import { MorseService } from '../../core/morse.service';
import { TerminalStore } from '../../core/terminal-store';
import { WorkspaceTabs } from '../../core/workspace-tabs';
import { TerminalView } from './terminal-view';

type SessionState = {
  sessionId: string | undefined;
  workspace: { cwd: string; name: string };
};

function setup(): {
  fixture: ComponentFixture<TerminalView>;
  host: HTMLElement;
  state: ReturnType<typeof signal<SessionState>>;
  morse: {
    openTerminal: ReturnType<typeof vi.fn>;
    closeTerminal: ReturnType<typeof vi.fn>;
    sendTerminal: ReturnType<typeof vi.fn>;
    resizeTerminal: ReturnType<typeof vi.fn>;
  };
} {
  const state = signal<SessionState>({
    sessionId: 's1',
    workspace: { cwd: '/w', name: 'w' },
  });
  const morse = {
    state,
    activateSession: vi.fn(),
    newSession: vi.fn(),
    requestHostCommand: vi.fn(() => Promise.resolve(undefined)),
    sessionActivity: signal(new Map()),
    openTerminal: vi.fn(),
    sendTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    resizeTerminal: vi.fn(),
    hostEpoch: signal(0),
    onTerminalOutput: () => () => undefined,
    onTerminalExit: () => () => undefined,
  };
  TestBed.configureTestingModule({
    imports: [TerminalView],
    providers: [{ provide: MorseService, useValue: morse }],
  });
  const fixture = TestBed.createComponent(TerminalView);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement, state, morse };
}

/** Opens a terminal the way the panel's `+` action does. */
function open(owner = 's1'): string {
  return TestBed.inject(TerminalStore).open(owner);
}

function chips(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.ttab .label')].map((node) => node.textContent?.trim() ?? '');
}

function paneTabs(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll('.pane-tab')] as HTMLElement[];
}

describe('TerminalView', () => {
  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('starts empty for the session in front', () => {
    const { host } = setup();
    expect(chips(host)).toEqual([]);
    // Nothing to list, so the chip row is not rendered at all.
    expect(host.querySelector('.tabbar')).toBeNull();
    expect(host.querySelector('.empty')).not.toBeNull();
    expect(host.querySelectorAll('morse-terminal')).toHaveLength(0);
  });

  it('shows one chip per terminal and keeps them all mounted', async () => {
    const { fixture, host } = setup();

    open();
    fixture.detectChanges();
    open();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(host.querySelector('.tabbar')).not.toBeNull();
    expect(chips(host)).toEqual(['Terminal 1', 'Terminal 2']);
    expect(host.querySelector('.ttab.active .label')?.textContent?.trim()).toBe('Terminal 2');
    // Both emulators are mounted; only the group in front takes space.
    const groups = [...host.querySelectorAll('.group')] as HTMLElement[];
    expect(groups).toHaveLength(2);
    expect(groups[0]!.classList.contains('hidden')).toBe(true);
    expect(groups[1]!.classList.contains('hidden')).toBe(false);
    expect(host.querySelectorAll('morse-terminal')).toHaveLength(2);
    expect(host.querySelector('.empty')).toBeNull();
  });

  it("shows only the session's terminals, and keeps the others alive", async () => {
    const { fixture, host, state, morse } = setup();
    open();
    fixture.detectChanges();
    await fixture.whenStable();

    // Another session in front: its own (empty) chip row, but the first
    // session's shell is still mounted and running behind the scenes.
    state.set({ sessionId: 's2', workspace: { cwd: '/other', name: 'other' } });
    fixture.detectChanges();

    expect(host.querySelector('.tabbar')).toBeNull();
    expect(chips(host)).toEqual([]);
    // The other session's shell stays mounted, only its group loses the space.
    expect(host.querySelectorAll('morse-terminal')).toHaveLength(1);
    expect(host.querySelector('.group')?.classList.contains('hidden')).toBe(true);
    // Switching sessions must not end the hidden session's shell: it is the
    // reader's running command, not a view state.
    expect(morse.closeTerminal).not.toHaveBeenCalled();

    // …and coming back shows the same terminal, shell intact.
    state.set({ sessionId: 's1', workspace: { cwd: '/w', name: 'w' } });
    fixture.detectChanges();
    expect(chips(host)).toEqual(['Terminal 1']);
    expect(host.querySelectorAll('morse-terminal')).toHaveLength(1);
    expect(morse.closeTerminal).not.toHaveBeenCalled();
  });

  it('shows the shell title and renames a tab inline', async () => {
    const { fixture, host } = setup();
    const store = TestBed.inject(TerminalStore);
    const id = open();
    fixture.detectChanges();
    await fixture.whenStable();

    // No rename yet: the tab follows the command the shell is running.
    store.setAutoTitle(id, 'npm run dev');
    fixture.detectChanges();
    expect(chips(host)).toEqual(['npm run dev']);

    // Double-clicking the tab opens the rename field, pre-filled.
    const tab = host.querySelector('.ttab') as HTMLElement;
    tab.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    fixture.detectChanges();
    const input = host.querySelector('.rename') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe('npm run dev');

    input.value = 'Dev server';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    expect(host.querySelector('.rename')).toBeNull();
    expect(chips(host)).toEqual(['Dev server']);

    // A later shell title leaves the reader's name alone.
    store.setAutoTitle(id, 'vim');
    fixture.detectChanges();
    expect(chips(host)).toEqual(['Dev server']);
  });

  it('splits a terminal into two panes and lists them beside it', async () => {
    const { fixture, host } = setup();
    const store = TestBed.inject(TerminalStore);
    const first = open();
    fixture.detectChanges();
    await fixture.whenStable();

    // A plain terminal: one chip, no split tab row.
    expect(host.querySelector('.pane-strip')).toBeNull();

    (host.querySelector('.split-button') as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();

    // The chip carries the count and both panes are mounted side by side.
    expect(chips(host)).toEqual(['Terminal 1']);
    expect(host.querySelector('.ttab .count')?.textContent?.trim()).toBe('(2)');
    expect(host.querySelectorAll('.pane')).toHaveLength(2);
    expect(host.querySelectorAll('morse-terminal')).toHaveLength(2);

    // The split's own tab row names both panes, the new one in front.
    const items = paneTabs(host);
    expect(items).toHaveLength(2);
    const group = store.groups()[0]!;
    const second = group.panes[1]!.id;
    expect(group.activePane).toBe(second);
    expect(items[1]!.classList.contains('active')).toBe(true);

    // Clicking a row brings that pane in front.
    items[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    expect(store.groups()[0]!.activePane).toBe(first);

    // Closing one pane leaves the terminal whole again.
    (paneTabs(host)[1]!.querySelector('.close') as HTMLElement).click();
    fixture.detectChanges();

    expect(chips(host)).toEqual(['Terminal 1']);
    expect(host.querySelector('.ttab .count')).toBeNull();
    expect(host.querySelector('.pane-strip')).toBeNull();
    expect(store.terminals()).toHaveLength(1);
  });

  it('resizes two panes by dragging the seam between them', async () => {
    const { fixture, host } = setup();
    const store = TestBed.inject(TerminalStore);
    const first = open();
    store.split(first);
    fixture.detectChanges();
    await fixture.whenStable();

    // jsdom has no layout: give the split a width so the drag has a scale.
    const container = host.querySelector('.group') as HTMLElement;
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ width: 400 } as DOMRect);
    const splitter = host.querySelector('.splitter') as HTMLElement;
    expect(splitter).not.toBeNull();

    splitter.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 200 }));
    splitter.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 260 }));
    splitter.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 260 }));
    fixture.detectChanges();

    // 60px of 400 = 0.15, moved from the right pane to the left one.
    const sizes = store.groups()[0]!.sizes;
    expect(sizes[0]).toBeCloseTo(0.65);
    expect(sizes[1]).toBeCloseTo(0.35);
  });

  it('ends a pane shell when one pane of a split is closed', async () => {
    const { fixture, host, morse } = setup();
    const store = TestBed.inject(TerminalStore);
    const first = open();
    fixture.detectChanges();
    await fixture.whenStable();
    (host.querySelector('.split-button') as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    const second = store.groups()[0]!.panes[1]!.id;
    expect(second).not.toBe(first);

    // Closing one pane ends exactly its shell; the split's other shell lives.
    (paneTabs(host)[1]!.querySelector('.close') as HTMLElement).click();
    fixture.detectChanges();

    expect(morse.closeTerminal).toHaveBeenCalledTimes(1);
    expect(morse.closeTerminal).toHaveBeenCalledWith(second);
    expect(store.terminals().map((pane) => pane.id)).toEqual([first]);
  });

  it('closing a split chip takes every pane with it', async () => {
    const { fixture, host } = setup();
    const store = TestBed.inject(TerminalStore);
    open();
    fixture.detectChanges();
    await fixture.whenStable();
    (host.querySelector('.split-button') as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(store.terminals()).toHaveLength(2);

    (host.querySelector('.ttab .close') as HTMLElement).click();
    fixture.detectChanges();

    expect(chips(host)).toEqual([]);
    expect(store.terminals()).toHaveLength(0);
    expect(host.querySelector('.empty')).not.toBeNull();
  });

  it('closes a terminal from its chip', async () => {
    const { fixture, host, morse } = setup();
    const id = open();
    fixture.detectChanges();
    await fixture.whenStable();

    (host.querySelector('.ttab .close') as HTMLElement).click();
    fixture.detectChanges();

    expect(chips(host)).toEqual([]);
    expect(host.querySelector('.tabbar')).toBeNull();
    expect(host.querySelectorAll('morse-terminal')).toHaveLength(0);
    // The reader asked for it, so the host shell ends too.
    expect(morse.closeTerminal).toHaveBeenCalledWith(id);
  });

  it("drops the session's terminals and ends their shells when its tab is closed", async () => {
    const { fixture, host, morse } = setup();
    const id = open();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(host.querySelectorAll('morse-terminal')).toHaveLength(1);

    // Closing the session tab is what owns the shell.
    TestBed.inject(WorkspaceTabs).focusSession({ id: 's1', title: 'One' });
    TestBed.inject(WorkspaceTabs).close('s1');
    fixture.detectChanges();

    expect(host.querySelectorAll('morse-terminal')).toHaveLength(0);
    expect(host.querySelector('.empty')).not.toBeNull();
    expect(morse.closeTerminal).toHaveBeenCalledWith(id);
  });
});
