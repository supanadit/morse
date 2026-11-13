import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayoutState } from '../../state/layout-state';
import { ShellState } from '../../state/shell-state';
import { ActivityRail } from './activity-rail';

function render(): ComponentFixture<ActivityRail> {
  TestBed.configureTestingModule({ imports: [ActivityRail] });
  const fixture = TestBed.createComponent(ActivityRail);
  fixture.detectChanges();
  return fixture;
}

function entries(fixture: ComponentFixture<ActivityRail>): HTMLButtonElement[] {
  return [...fixture.nativeElement.querySelectorAll('.views .entry')] as HTMLButtonElement[];
}

function stubNarrow(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

describe('ActivityRail', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('lists Sessions then Explorer, with the session list in front', () => {
    const fixture = render();

    expect(entries(fixture).map((entry) => entry.getAttribute('aria-label'))).toEqual([
      'Sessions view',
      'Explorer view',
    ]);
    expect(entries(fixture).map((entry) => entry.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
    ]);
  });

  it('switches to Files and reopens a folded column', () => {
    const fixture = render();
    const layout = TestBed.inject(LayoutState);
    layout.setVisible('left', false);
    fixture.detectChanges();

    entries(fixture)[1].click();
    fixture.detectChanges();

    expect(TestBed.inject(ShellState).leftPane()).toBe('files');
    expect(layout.leftCollapsed()).toBe(false);
    expect(entries(fixture)[1].getAttribute('aria-pressed')).toBe('true');
  });

  it('folds and unfolds the panel when the active view is chosen again', () => {
    const fixture = render();
    const layout = TestBed.inject(LayoutState);

    entries(fixture)[0].click();
    fixture.detectChanges();
    expect(layout.leftCollapsed()).toBe(true);
    expect(fixture.nativeElement.querySelector('.views')).not.toBeNull();

    entries(fixture)[0].click();
    fixture.detectChanges();
    expect(layout.leftCollapsed()).toBe(false);
  });

  it('drives the drawer on a narrow layout, leaving the stored fold alone', () => {
    stubNarrow();
    const fixture = render();
    const shell = TestBed.inject(ShellState);
    const layout = TestBed.inject(LayoutState);

    entries(fixture)[0].click();
    fixture.detectChanges();
    expect(shell.navigationOpen()).toBe(true);
    expect(layout.leftCollapsed()).toBe(false);

    entries(fixture)[1].click();
    fixture.detectChanges();
    expect(shell.leftPane()).toBe('files');
    expect(shell.navigationOpen()).toBe(true);

    entries(fixture)[1].click();
    fixture.detectChanges();
    expect(shell.navigationOpen()).toBe(false);
  });
});
