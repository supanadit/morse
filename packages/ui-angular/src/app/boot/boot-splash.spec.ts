import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BootSplash } from './boot-splash';

describe('BootSplash', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [BootSplash] }).compileComponents();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the wordmark and the status the host reports', () => {
    const fixture = TestBed.createComponent(BootSplash);
    fixture.componentRef.setInput('status', 'Starting the pi agent…');
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.wordmark')?.textContent).toContain('Morse');
    expect(element.textContent).toContain('Starting the pi agent…');
  });

  /**
   * The overlay is purely decorative: even when the motion engine never ticks,
   * it must still hand the app back once the host is ready.
   */
  it('emits dismissed and leaves the screen once ready', () => {
    vi.useFakeTimers();
    const fixture = TestBed.createComponent(BootSplash);
    fixture.detectChanges();

    const dismissed = vi.fn();
    fixture.componentInstance.dismissed.subscribe(dismissed);

    fixture.componentRef.setInput('ready', true);
    fixture.detectChanges();
    // The intro is held for its minimum, then the outro runs and settles.
    vi.advanceTimersByTime(4_000);

    expect(dismissed).toHaveBeenCalledTimes(1);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.boot')?.classList.contains('leaving'),
    ).toBe(true);
  });
});
