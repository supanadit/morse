import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayoutState } from '../../state/layout-state';
import { ShellState } from '../../state/shell-state';
import { MorseService } from '../../host/morse.service';
import { AuthState } from '../../host/auth-state';
import { ActivityRail } from './activity-rail';

function render(): ComponentFixture<ActivityRail> {
  TestBed.configureTestingModule({ imports: [ActivityRail] });
  const fixture = TestBed.createComponent(ActivityRail);
  fixture.detectChanges();
  return fixture;
}

/** A multi-user host: the rail gains the account block at its foot. */
function renderAs(username: string, role: 'admin' | 'regular'): ComponentFixture<ActivityRail> {
  TestBed.configureTestingModule({
    imports: [ActivityRail],
    providers: [
      {
        provide: MorseService,
        useValue: { user: signal({ id: 'u-1', username, role }) },
      },
    ],
  });
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

  it('shows nobody on single-user hosts', () => {
    // No login user, no block: the rail is exactly the views, not an empty card.
    expect(render().nativeElement.querySelector('.account')).toBeNull();
  });

  it('parks the login user at the rail foot, with a card carrying logout', () => {
    const fixture = renderAs('adit', 'admin');
    const account = fixture.nativeElement.querySelector('.account') as HTMLElement;
    expect(account.querySelector('.avatar')?.textContent?.trim()).toBe('A');
    expect(account.querySelector('.card')).toBeNull();

    (account.querySelector('.avatar') as HTMLButtonElement).click();
    fixture.detectChanges();
    const card = account.querySelector('.card') as HTMLElement;
    expect(card.querySelector('.name')?.textContent).toBe('adit');
    expect(card.querySelector('.role')?.textContent?.trim()).toBe('Admin');

    const auth = TestBed.inject(AuthState);
    const logout = vi.spyOn(auth, 'logout').mockResolvedValue(undefined);
    (card.querySelector('.row.danger') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(logout).toHaveBeenCalledTimes(1);
    expect(account.querySelector('.card')).toBeNull();
  });

  it('offers user management on an admin card only', () => {
    const admin = renderAs('adit', 'admin');
    (admin.nativeElement.querySelector('.account .avatar') as HTMLButtonElement).click();
    admin.detectChanges();
    expect(admin.nativeElement.querySelector('.card .row:not(.danger)')?.textContent).toContain(
      'Manage users',
    );

    TestBed.resetTestingModule();
    const member = renderAs('bob', 'regular');
    (member.nativeElement.querySelector('.account .avatar') as HTMLButtonElement).click();
    member.detectChanges();
    expect(
      member.nativeElement.querySelector('.card .role')?.textContent?.trim(),
    ).toBe('Member');
    expect(member.nativeElement.querySelectorAll('.card .row')).toHaveLength(1);
  });
});
