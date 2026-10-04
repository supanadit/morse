import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DisplayPrefs, readToolDisplay } from './display-prefs';

/**
 * The display choice is a reader preference, so it must outlive a reload — a
 * toggle nobody can see again would fail silently. The default is the compact
 * tree; the detailed timeline is the opt-in legacy view.
 */
describe('DisplayPrefs', () => {
  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('defaults to the compact tree', () => {
    expect(readToolDisplay()).toBe('compact');
    expect(TestBed.inject(DisplayPrefs).toolDisplay()).toBe('compact');
  });

  it('toggles between compact and timeline', () => {
    const prefs = TestBed.inject(DisplayPrefs);

    prefs.toggleToolDisplay();
    expect(prefs.toolDisplay()).toBe('timeline');

    prefs.toggleToolDisplay();
    expect(prefs.toolDisplay()).toBe('compact');
  });

  it('remembers the choice across a reload', () => {
    TestBed.inject(DisplayPrefs).setToolDisplay('timeline');

    // A fresh instance is what a reload builds; the choice has to survive it.
    TestBed.resetTestingModule();
    expect(TestBed.inject(DisplayPrefs).toolDisplay()).toBe('timeline');
  });

  it('falls back to compact for a stored value it does not know', () => {
    localStorage.setItem('morse.chat.toolDisplay', 'fancy');
    expect(readToolDisplay()).toBe('compact');
  });
});
