import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { PanelState } from './panel-state';

/**
 * The bottom panel is a shell preference — folded first, then opened, moved and
 * resized — so what matters is that the fold, the chosen chip and the dragged
 * height all outlive a reload.
 */
describe('PanelState', () => {
  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('starts folded to its chip row with no tool chosen', () => {
    const panel = TestBed.inject(PanelState);
    expect(panel.expanded()).toBe(false);
    expect(panel.activeView()).toBeUndefined();
  });

  it('opens the clicked chip, and folds again when it is clicked once more', () => {
    const panel = TestBed.inject(PanelState);

    panel.toggle('terminal');
    expect(panel.activeView()).toBe('terminal');
    expect(panel.expanded()).toBe(true);

    panel.toggle('terminal');
    expect(panel.expanded()).toBe(false);
    // The tool stays chosen, so the chevron can re-open what was last shown.
    expect(panel.activeView()).toBe('terminal');
  });

  it('clamps the dragged height to a usable range', () => {
    const panel = TestBed.inject(PanelState);

    panel.setHeight(20);
    expect(panel.height()).toBe(120);

    panel.setHeight(5_000);
    expect(panel.height()).toBe(900);
  });

  it('publishes the active tool’s bar actions', () => {
    const panel = TestBed.inject(PanelState);
    panel.registerActions('terminal', [
      { label: '+', title: 'New terminal', run: () => undefined },
    ]);

    panel.toggle('terminal');
    expect(panel.actions().map((action) => action.label)).toEqual(['+']);

    panel.clearActions('terminal');
    expect(panel.actions()).toEqual([]);
  });

  it('remembers the tool, the fold and the height across a reload', () => {
    const panel = TestBed.inject(PanelState);
    panel.toggle('terminal');
    panel.setHeight(320);

    TestBed.resetTestingModule();
    const restored = TestBed.inject(PanelState);
    expect(restored.activeView()).toBe('terminal');
    expect(restored.expanded()).toBe(true);
    expect(restored.height()).toBe(320);
  });
});
