import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionNavPrefs } from './session-nav-prefs';

/**
 * The session list's folds are the reader's: a project they shut stays shut, one
 * they opened stays open, and the whole list's fold survives too. The one default
 * is not theirs — until something is on record, only the project they are in is
 * unfolded — and it is written down the first time so undoing it is not undone.
 */
describe('SessionNavPrefs', () => {
  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  function prefs(): SessionNavPrefs {
    return TestBed.inject(SessionNavPrefs);
  }

  it('starts with nothing on record', () => {
    expect(prefs().remembered()).toBe(false);
    expect(prefs().folds()).toEqual({});
    expect(prefs().listFolded()).toBe(false);
  });

  it('seeds a default that opens the one project and shuts the rest', () => {
    prefs().seedFolds(['/w/morse', '/w/other', '/w/third'], '/w/other');

    expect(prefs().folds()).toEqual({ '/w/morse': true, '/w/third': true });
    // Writing the default counts as on record: a project added later must not
    // re-fold everything the reader has opened since.
    expect(prefs().remembered()).toBe(true);
  });

  it('unfolds a project the default shut, and keeps it open across a reload', () => {
    prefs().seedFolds(['/w/morse', '/w/other'], '/w/morse');
    prefs().toggleProject('/w/other');
    expect(prefs().folds()).toEqual({});

    TestBed.resetTestingModule();
    expect(prefs().folds()).toEqual({});
    expect(prefs().remembered()).toBe(true);
  });

  it('remembers a fold across a reload', () => {
    prefs().toggleProject('/w/morse');
    expect(prefs().folds()).toEqual({ '/w/morse': true });

    TestBed.resetTestingModule();
    expect(prefs().folds()).toEqual({ '/w/morse': true });
  });

  it('remembers the whole list being folded', () => {
    prefs().setListFolded(true);

    TestBed.resetTestingModule();
    expect(prefs().listFolded()).toBe(true);
    expect(prefs().folds()).toEqual({});
  });

  it('ignores a stored fold map it cannot read', () => {
    localStorage.setItem('morse.view.sessionNav.folds', '["/w/morse"]');
    expect(prefs().folds()).toEqual({});
    expect(prefs().remembered()).toBe(false);
  });
});
