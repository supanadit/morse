import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RestoreState } from './restore-state';

describe('RestoreState', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('starts at rest', () => {
    const restore = TestBed.inject(RestoreState);
    expect(restore.isRestoring()).toBe(false);
  });

  it('raises and lowers the flag', () => {
    const restore = TestBed.inject(RestoreState);
    restore.begin();
    expect(restore.isRestoring()).toBe(true);
    restore.end();
    expect(restore.isRestoring()).toBe(false);
  });

  it('fails open: the watchdog gives the panel back', () => {
    vi.useFakeTimers();
    const restore = TestBed.inject(RestoreState);
    restore.begin();
    vi.advanceTimersByTime(RestoreState.WATCHDOG_MS - 1);
    expect(restore.isRestoring()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(restore.isRestoring()).toBe(false);
  });

  it('re-arming the watchdog restarts the clock instead of ending early', () => {
    vi.useFakeTimers();
    const restore = TestBed.inject(RestoreState);
    restore.begin();
    vi.advanceTimersByTime(RestoreState.WATCHDOG_MS - 100);
    restore.begin();
    vi.advanceTimersByTime(RestoreState.WATCHDOG_MS - 200);
    // The first watchdog would have fired by now; the second still holds.
    expect(restore.isRestoring()).toBe(true);
    restore.end();
    // Ending disarms the pending watchdog: time passing stays harmless.
    vi.advanceTimersByTime(RestoreState.WATCHDOG_MS * 2);
    expect(restore.isRestoring()).toBe(false);
  });
});
