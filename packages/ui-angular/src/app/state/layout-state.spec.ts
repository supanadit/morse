import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { LayoutState } from './layout-state';

/**
 * The layout is a preference, so it outlives a reload — that is the part worth locking:
 * a column that came back folded, or a width that reset itself, would fail silently.
 */
describe('LayoutState', () => {
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

    expect(layout.regions().map((region) => region.id)).toEqual(['left', 'main', 'right']);
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
});
