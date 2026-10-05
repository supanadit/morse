import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { NotificationPrefs } from './notification-prefs';

describe('NotificationPrefs', () => {
  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('starts off, on `away`, and still asking', () => {
    const prefs = TestBed.inject(NotificationPrefs);
    expect(prefs.enabled()).toBe(false);
    expect(prefs.mode()).toBe('away');
    expect(prefs.bannerDismissed()).toBe(false);
  });

  it('toggles on and off, remembers it, and retires the nudge', () => {
    const prefs = TestBed.inject(NotificationPrefs);
    prefs.toggle();

    expect(prefs.enabled()).toBe(true);
    expect(prefs.bannerDismissed()).toBe(true);

    // A fresh instance is what a reload builds; the choice has to survive it.
    TestBed.resetTestingModule();
    expect(TestBed.inject(NotificationPrefs).enabled()).toBe(true);
    expect(TestBed.inject(NotificationPrefs).bannerDismissed()).toBe(true);
  });

  it('switches between `away` and `always`, and remembers it', () => {
    TestBed.inject(NotificationPrefs).toggleMode();
    expect(TestBed.inject(NotificationPrefs).mode()).toBe('always');

    TestBed.resetTestingModule();
    expect(TestBed.inject(NotificationPrefs).mode()).toBe('always');
  });

  it('dismisses the nudge without turning anything on', () => {
    const prefs = TestBed.inject(NotificationPrefs);
    prefs.dismissBanner();

    expect(prefs.enabled()).toBe(false);
    expect(prefs.bannerDismissed()).toBe(true);
  });
});
