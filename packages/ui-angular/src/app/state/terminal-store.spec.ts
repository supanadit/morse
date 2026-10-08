import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { TerminalStore } from './terminal-store';

describe('TerminalStore', () => {
  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('opens terminals under their owner and focuses the newest', () => {
    const store = TestBed.inject(TerminalStore);

    const first = store.open('s1');
    const second = store.open('s1');

    expect(store.terminals().map((terminal) => terminal.id)).toEqual([first, second]);
    expect(store.activeFor('s1')).toBe(second);
  });

  it("keeps each session's active terminal apart", () => {
    const store = TestBed.inject(TerminalStore);

    const one = store.open('s1');
    const two = store.open('s2');
    store.focus(one);

    expect(store.activeFor('s1')).toBe(one);
    expect(store.activeFor('s2')).toBe(two);
  });

  it('falls back to a neighbour when the active terminal closes', () => {
    const store = TestBed.inject(TerminalStore);

    const first = store.open('s1');
    const second = store.open('s1');
    store.close(second);

    expect(store.terminals().map((terminal) => terminal.id)).toEqual([first]);
    expect(store.activeFor('s1')).toBe(first);
  });

  it("drops a session's terminals when its tab closes", () => {
    const store = TestBed.inject(TerminalStore);

    store.open('s1');
    const kept = store.open('s2');
    store.forgetOwner('s1');

    expect(store.terminals().map((terminal) => terminal.id)).toEqual([kept]);
    expect(store.activeFor('s1')).toBeUndefined();
  });

  it("moves a draft's terminals to the session it becomes", () => {
    const store = TestBed.inject(TerminalStore);

    const terminal = store.open('draft-1');
    store.rekey('draft-1', 's1');

    expect(store.terminals().map((entry) => ({ id: entry.id, owner: entry.owner }))).toEqual([
      { id: terminal, owner: 's1' },
    ]);
    expect(store.activeFor('s1')).toBe(terminal);
    expect(store.activeFor('draft-1')).toBeUndefined();
  });

  it('follows the shell title until the reader renames it', () => {
    const store = TestBed.inject(TerminalStore);
    const id = store.open('s1');
    expect(store.terminals()[0]?.title).toBe('Terminal 1');

    // No rename: the tab names the running command.
    store.setAutoTitle(id, 'npm run dev');
    expect(store.terminals()[0]?.title).toBe('npm run dev');

    store.rename(id, 'Server');
    expect(store.terminals()[0]?.title).toBe('Server');

    // A later shell title never overrides the reader's name.
    store.setAutoTitle(id, 'vim');
    expect(store.terminals()[0]?.title).toBe('Server');

    // An empty rename clears it and the shell title is back.
    store.rename(id, '  ');
    expect(store.terminals()[0]?.title).toBe('vim');
  });

  it('falls back to Terminal N when a rename is cleared with no shell title', () => {
    const store = TestBed.inject(TerminalStore);
    const id = store.open('s1');

    store.rename(id, 'x');
    store.rename(id, '');

    expect(store.terminals()[0]?.title).toBe('Terminal 1');
  });

  it('splits one terminal into a chip with two panes', () => {
    const store = TestBed.inject(TerminalStore);
    const first = store.open('s1');

    const second = store.split(first);

    expect(second).toBeDefined();
    const group = store.groups()[0]!;
    expect(group.panes.map((pane) => pane.id)).toEqual([first, second]);
    // The chip carries the count and the new pane is in front.
    expect(group.title).toBe('Terminal 1 (2)');
    expect(group.count).toBe(2);
    expect(group.activePane).toBe(second);
    expect(store.activeFor('s1')).toBe(first);
  });

  it('keeps the chip until the last pane of a split is closed', () => {
    const store = TestBed.inject(TerminalStore);
    const first = store.open('s1');
    const second = store.split(first)!;

    store.closePane(second);
    expect(store.groups()[0]?.title).toBe('Terminal 1');
    expect(store.terminals()).toHaveLength(1);

    store.closePane(first);
    expect(store.groups()).toEqual([]);
    expect(store.activeFor('s1')).toBeUndefined();
  });

  it('closing a chip drops every pane in its split', () => {
    const store = TestBed.inject(TerminalStore);
    const first = store.open('s1');
    store.split(first);

    store.close(first);

    expect(store.terminals()).toEqual([]);
  });

  it('focuses a pane and the terminal it belongs to', () => {
    const store = TestBed.inject(TerminalStore);
    const first = store.open('s1');
    const second = store.split(first)!;
    expect(store.groups()[0]!.activePane).toBe(second);

    store.focus(first);

    expect(store.groups()[0]!.activePane).toBe(first);
    expect(store.activeFor('s1')).toBe(first);
  });

  it('keeps a shell directory reported by OSC 7, and ignores an empty one', () => {
    const store = TestBed.inject(TerminalStore);
    const id = store.open('s1');
    expect(store.terminals()[0]?.cwd).toBeUndefined();

    store.setCwd(id, '/repo/packages/api');
    expect(store.terminals()[0]?.cwd).toBe('/repo/packages/api');

    // An empty report is not a directory: it must not wipe the known one.
    store.setCwd(id, '   ');
    expect(store.terminals()[0]?.cwd).toBe('/repo/packages/api');
  });

  it('lists an owner’s panes and reports whether it still holds one', () => {
    const store = TestBed.inject(TerminalStore);
    const first = store.open('s1');
    const second = store.split(first)!;
    const other = store.open('s2');

    expect(store.panesOf('s1')).toEqual([first, second]);
    expect(store.panesOf('s2')).toEqual([other]);
    expect(store.hasOwner('s1')).toBe(true);

    store.forgetOwner('s1');

    expect(store.panesOf('s1')).toEqual([]);
    expect(store.hasOwner('s1')).toBe(false);
    expect(store.hasOwner('s2')).toBe(true);
  });

  it('sizes a split evenly and keeps a drag until the structure changes', () => {
    const store = TestBed.inject(TerminalStore);
    const first = store.open('s1');
    expect(store.groups()[0]!.sizes).toEqual([1]);

    store.split(first);
    expect(store.groups()[0]!.sizes).toEqual([0.5, 0.5]);

    store.setSizes(first, [0.7, 0.3]);
    expect(store.groups()[0]!.sizes).toEqual([0.7, 0.3]);

    // A third pane no longer matches the stored pair: back to an even split.
    store.split(first);
    expect(store.groups()[0]!.sizes).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it('snapshots the panes and every “which is in front” choice', () => {
    const store = TestBed.inject(TerminalStore);
    const first = store.open('s1');
    const second = store.split(first)!;
    store.open('s2');
    store.setSizes(first, [0.6, 0.4]);

    const snapshot = store.snapshot();

    expect(snapshot.panes.map((pane) => pane.id)).toEqual([first, second, 'term-3']);
    expect(snapshot.activeByOwner['s1']).toBe(first);
    expect(snapshot.activePaneByGroup[first]).toBe(second);
    expect(snapshot.sizesByGroup[first]).toEqual([0.6, 0.4]);
  });

  it('restores the layout, and a later terminal does not reuse a restored id', () => {
    const store = TestBed.inject(TerminalStore);

    store.restore({
      panes: [
        { id: 'term-4', owner: 's1', group: 'term-4', title: 'Server', fallbackTitle: 'Terminal 4', custom: 'Server' },
        { id: 'term-5', owner: 's1', group: 'term-4', title: 'Terminal 5', fallbackTitle: 'Terminal 5' },
      ],
      activeByOwner: { s1: 'term-4' },
      activePaneByGroup: { 'term-4': 'term-5' },
      sizesByGroup: { 'term-4': [0.5, 0.5] },
    });

    expect(store.groups().map((group) => group.title)).toEqual(['Server (2)']);
    expect(store.activeFor('s1')).toBe('term-4');
    expect(store.activePaneFor('term-4')).toBe('term-5');

    const next = store.open('s1');
    expect(next).toBe('term-6');
  });

  it('keeps a restored pane’s directory and drops a malformed one', () => {
    const store = TestBed.inject(TerminalStore);

    store.restore({
      panes: [
        { id: 'term-1', owner: 's1', group: 'term-1', title: 'T', fallbackTitle: 'Terminal 1', cwd: '/repo' },
        { id: '', group: 'x' },
      ],
      activeByOwner: { s1: 'term-1', gone: 'term-1' },
      activePaneByGroup: { 'term-1': 'term-1' },
      sizesByGroup: { 'term-1': [1], missing: [0.5, 0.5] },
    });

    expect(store.terminals().map((pane) => pane.cwd)).toEqual(['/repo']);
    // The maps are filtered to what survived: a stale owner never resurrects a pane.
    expect(store.snapshot().activeByOwner).toEqual({ s1: 'term-1' });
    expect(Object.keys(store.snapshot().sizesByGroup)).toEqual(['term-1']);
  });
});