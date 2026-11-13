import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelState } from './panel-state';
import { WorkspaceTabs } from './workspace-tabs';

/**
 * The panel's ceiling comes from the window it is in, so every spec here states the
 * window it means: jsdom's own 768 would cap the heights these tests drag to.
 */
function sizeWindow(px: number): void {
  vi.stubGlobal('innerHeight', px);
  globalThis.dispatchEvent(new Event('resize'));
}

/**
 * The bottom panel is a shell preference — folded first, then opened, moved and
 * resized — but the fold, the chosen tool and full screen belong to the session,
 * because the terminals themselves do.
 */
function setup(owner = 's1'): {
  panel: PanelState;
  composerKey: WritableSignal<string | undefined>;
} {
  TestBed.resetTestingModule();
  const composerKey = signal<string | undefined>(owner);
  TestBed.configureTestingModule({
    providers: [{ provide: WorkspaceTabs, useValue: { composerKey } }],
  });
  return { panel: TestBed.inject(PanelState), composerKey };
}

beforeEach(() => {
  sizeWindow(1_200);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  TestBed.resetTestingModule();
});

describe('PanelState', () => {
  it('starts folded to its chip row with no tool chosen', () => {
    const { panel } = setup();
    expect(panel.expanded()).toBe(false);
    expect(panel.activeView()).toBeUndefined();
  });

  it('opens the clicked chip, and folds again when it is clicked once more', () => {
    const { panel } = setup();

    panel.toggle('terminal');
    expect(panel.activeView()).toBe('terminal');
    expect(panel.expanded()).toBe(true);

    panel.toggle('terminal');
    expect(panel.expanded()).toBe(false);
    // The tool stays chosen, so the chevron can re-open what was last shown.
    expect(panel.activeView()).toBe('terminal');
  });

  it('keeps the fold per session, so one opened panel does not open another', () => {
    const { panel, composerKey } = setup('s1');

    panel.toggle('terminal');
    expect(panel.expanded()).toBe(true);

    composerKey.set('s2');
    expect(panel.expanded()).toBe(false);
    expect(panel.activeView()).toBeUndefined();

    // Back to s1: its own open state is still there.
    composerKey.set('s1');
    expect(panel.expanded()).toBe(true);
    expect(panel.activeView()).toBe('terminal');

    // s2 opens its own, independently of s1.
    composerKey.set('s2');
    panel.toggle('terminal');
    expect(panel.expanded()).toBe(true);
    composerKey.set('s1');
    expect(panel.expanded()).toBe(true);
  });

  it('clamps the dragged height to a usable range', () => {
    const { panel } = setup();

    panel.setHeight(20);
    expect(panel.height()).toBe(120);

    // 1200px of window, less the chrome and the conversation's floor: 850.
    panel.setHeight(5_000);
    expect(panel.height()).toBe(850);
  });

  it('never takes the room the conversation needs, and gives the height back', () => {
    const { panel } = setup();
    panel.setHeight(700);
    expect(panel.height()).toBe(700);

    // A window of 600 leaves the panel 250: the chat keeps its floor instead of
    // collapsing to nothing (the bug: no transcript scroll, clicks on the log lost).
    sizeWindow(600);
    expect(panel.height()).toBe(250);

    // The reader's own height was never overwritten: the taller window has it back.
    sizeWindow(1_200);
    expect(panel.height()).toBe(700);
  });

  it('returns to the default height when the choice is reset', () => {
    const { panel } = setup();
    panel.setHeight(320);

    panel.resetHeight();
    expect(panel.height()).toBeUndefined();

    expect(setup().panel.height()).toBeUndefined();
  });

  it('goes full screen only with a tool open, and leaves it on collapse', () => {
    const { panel } = setup();

    // Nothing open: there is no panel to hand the whole column to.
    panel.toggleFull();
    expect(panel.full()).toBe(false);

    panel.toggle('terminal');
    panel.toggleFull();
    expect(panel.full()).toBe(true);

    // Folding the panel ends full screen with it.
    panel.collapse();
    expect(panel.full()).toBe(false);
    expect(panel.expanded()).toBe(false);
  });

  it('remembers full screen across a reload', () => {
    const { panel } = setup();
    panel.toggle('terminal');
    panel.toggleFull();

    const restored = setup().panel;
    expect(restored.expanded()).toBe(true);
    expect(restored.full()).toBe(true);
  });

  it('publishes the active tool’s bar actions', () => {
    const { panel } = setup();
    panel.registerActions('terminal', [
      { label: '+', title: 'New terminal', run: () => undefined },
    ]);

    panel.toggle('terminal');
    expect(panel.actions().map((action) => action.label)).toEqual(['+']);

    panel.clearActions('terminal');
    expect(panel.actions()).toEqual([]);
  });

  it('remembers the tool, the fold and the height across a reload', () => {
    const { panel } = setup();
    panel.toggle('terminal');
    panel.setHeight(320);

    const restored = setup().panel;
    expect(restored.activeView()).toBe('terminal');
    expect(restored.expanded()).toBe(true);
    expect(restored.height()).toBe(320);
  });

  it('snapshots the open tool, its state and the dragged height', () => {
    const { panel } = setup();
    panel.toggle('terminal');
    panel.setHeight(320);

    expect(panel.snapshot()).toEqual({
      owners: { s1: { view: 'terminal', expanded: true, full: false } },
      height: 320,
    });
  });

  it('restores a saved panel, including full screen and the height', () => {
    const { panel } = setup();

    panel.restore({
      owners: { s1: { view: 'terminal', expanded: true, full: true } },
      height: 420,
    });

    expect(panel.activeView()).toBe('terminal');
    expect(panel.expanded()).toBe(true);
    expect(panel.full()).toBe(true);
    expect(panel.height()).toBe(420);

    // The choice is written to storage too, so a later host-less reload keeps it.
    const restored = setup().panel;
    expect(restored.expanded()).toBe(true);
    expect(restored.full()).toBe(true);
    expect(restored.height()).toBe(420);
  });

  it('attributes a pre-per-session layout to the session in front', () => {
    const { panel } = setup('s1');

    panel.restore({ view: 'terminal', expanded: true, full: true, height: 300 });

    // A flat layout has no owner; the conversation in front is the one it meant.
    expect(panel.expanded()).toBe(true);
    expect(panel.activeView()).toBe('terminal');
    expect(panel.full()).toBe(true);
    expect(panel.height()).toBe(300);
  });

  it('ignores a malformed panel snapshot', () => {
    const { panel } = setup();
    panel.restore('nope');

    expect(panel.expanded()).toBe(false);
    expect(panel.activeView()).toBeUndefined();
  });
});
