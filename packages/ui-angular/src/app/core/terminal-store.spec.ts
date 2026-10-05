import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { TerminalStore } from './terminal-store';

describe('TerminalStore', () => {
  afterEach(() => TestBed.resetTestingModule());

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
});
