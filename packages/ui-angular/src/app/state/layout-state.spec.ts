import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LayoutState } from './layout-state';

/**
 * The layout is a preference, so it outlives a reload — that is the part worth locking:
 * a column that came back folded, or a width that reset itself, would fail silently.
 */
describe('LayoutState', () => {
  beforeEach(() => {
    // Not a courtesy: a suite that folds a column leaves it folded for the next file, and
    // this one asserts what a first-run layout looks like.
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('starts showing the navigation column, with the git panel closed', () => {
    const layout = TestBed.inject(LayoutState);

    expect(layout.leftCollapsed()).toBe(false);
    expect(layout.rightVisible()).toBe(false);
    expect(layout.rightSize()).toBeUndefined();
  });

  it('folds the navigation column on toggle, and remembers it across a reload', () => {
    const layout = TestBed.inject(LayoutState);
    layout.toggleVisible('left');
    expect(layout.leftCollapsed()).toBe(true);

    // A fresh instance is what a reload builds; the preference has to survive it.
    TestBed.resetTestingModule();
    expect(TestBed.inject(LayoutState).leftCollapsed()).toBe(true);

    // …and unfolding is remembered just as well.
    TestBed.inject(LayoutState).toggleVisible('left');
    TestBed.resetTestingModule();
    expect(TestBed.inject(LayoutState).leftCollapsed()).toBe(false);
  });

  it('hides a region without losing its place in the order or its size', () => {
    const layout = TestBed.inject(LayoutState);
    layout.setSize('right', 520);
    layout.setVisible('right', true);
    layout.setVisible('right', false);

    expect(layout.regions().map((region) => region.id)).toEqual([
      'toolbar',
      'left',
      'main',
      'right',
      'status',
    ]);
    expect(layout.region('right').size).toBe(520);
    expect(layout.rightVisible()).toBe(false);
  });

  it('remembers that the git panel was open', () => {
    TestBed.inject(LayoutState).setVisible('right', true);

    TestBed.resetTestingModule();
    expect(TestBed.inject(LayoutState).rightVisible()).toBe(true);
  });

  it('clamps a column width to a usable range, and remembers it', () => {
    const layout = TestBed.inject(LayoutState);
    layout.setSize('right', 520);
    expect(layout.rightSize()).toBe(520);
    layout.setSize('right', 10);
    expect(layout.rightSize()).toBe(220);
    layout.setSize('right', 5_000);
    expect(layout.rightSize()).toBe(1600);

    TestBed.resetTestingModule();
    expect(TestBed.inject(LayoutState).rightSize()).toBe(1600);

    // A double-click (or a reload after one) goes back to the CSS default.
    TestBed.inject(LayoutState).setSize('right', undefined);
    expect(TestBed.inject(LayoutState).rightSize()).toBeUndefined();
    TestBed.resetTestingModule();
    expect(TestBed.inject(LayoutState).rightSize()).toBeUndefined();
  });

  it('lays the window out as chrome, columns and chrome', () => {
    const layout = TestBed.inject(LayoutState);

    expect(layout.top().map((region) => region.id)).toEqual(['toolbar']);
    expect(layout.columns().map((region) => region.id)).toEqual(['left', 'main', 'right']);
    expect(layout.bottom().map((region) => region.id)).toEqual(['status']);
  });

  it('clamps and remembers the navigation column width too', () => {
    const layout = TestBed.inject(LayoutState);
    expect(layout.leftSize()).toBeUndefined();

    layout.setSize('left', 360);
    expect(layout.leftSize()).toBe(360);
    layout.setSize('left', 10_000);
    expect(layout.leftSize()).toBe(1600);

    TestBed.resetTestingModule();
    expect(TestBed.inject(LayoutState).leftSize()).toBe(1600);
  });

  it('ignores a stored width that is not a number, instead of clamping a NaN', () => {
    localStorage.setItem('morse.git.width', 'wide');

    expect(TestBed.inject(LayoutState).rightSize()).toBeUndefined();
  });

  it('applies a width on every frame of a drag but writes it once', () => {
    const layout = TestBed.inject(LayoutState);

    layout.setSize('right', 520, false);
    expect(layout.rightSize()).toBe(520);
    expect(localStorage.getItem('morse.git.width')).toBeNull();

    layout.setSize('right', 520);
    expect(localStorage.getItem('morse.git.width')).toBe('520');
  });

  it('clamps and remembers a pane height, and forgets it when the reader resets it', () => {
    const layout = TestBed.inject(LayoutState);
    expect(layout.explorerSize()).toBeUndefined();

    layout.setSize('explorer', 300, false);
    expect(layout.explorerSize()).toBe(300);
    expect(localStorage.getItem('morse.explorer.height')).toBeNull();

    layout.setSize('explorer', 300);
    expect(localStorage.getItem('morse.explorer.height')).toBe('300');
    layout.setSize('explorer', 10);
    expect(layout.size('explorer')).toBe(140);

    // A double-click on a handle asks for the stylesheet's default back, so nothing is stored.
    layout.setSize('explorer', undefined);
    expect(layout.explorerSize()).toBeUndefined();
    expect(localStorage.getItem('morse.explorer.height')).toBeNull();

    layout.setSize('changes', 10_000);
    expect(layout.changesSize()).toBe(1200);
    TestBed.resetTestingModule();
    expect(TestBed.inject(LayoutState).changesSize()).toBe(1200);
  });
});
