import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../../core/morse.service';
import { WorkspaceTabs } from '../../core/workspace-tabs';
import { TabStrip } from './tab-strip';

function setup() {
  const morse = {
    activateSession: vi.fn(),
    newSession: vi.fn(),
    requestHostCommand: vi.fn(() => Promise.resolve(undefined)),
    sessionActivity: signal(new Map<string, { sessionKey: string; streaming: boolean }>()),
    state: signal({ sessionId: undefined as string | undefined, streaming: false }),
  };
  TestBed.configureTestingModule({
    imports: [TabStrip],
    providers: [{ provide: MorseService, useValue: morse }],
  });
  const tabs = TestBed.inject(WorkspaceTabs);
  const fixture = TestBed.createComponent(TabStrip);
  return { fixture, tabs, morse };
}

function openMenuOn(fixture: ComponentFixture<TabStrip>, index: number): void {
  const tab = fixture.nativeElement.querySelectorAll('.tab')[index] as HTMLElement;
  tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }));
  fixture.detectChanges();
}

function menuItems(fixture: ComponentFixture<TabStrip>): HTMLButtonElement[] {
  return [...fixture.nativeElement.querySelectorAll('.context-menu-item')] as HTMLButtonElement[];
}

describe('TabStrip context menu', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('offers the VS Code actions on right-click', () => {
    const { fixture, tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.focusSession({ id: 's2', title: 'Two' });
    fixture.detectChanges();

    openMenuOn(fixture, 0);

    expect(menuItems(fixture).map((item) => item.textContent?.trim())).toEqual([
      'Close',
      'Close Others',
      'Close to the Right',
      'Close All',
    ]);
  });

  it('disables "Close to the Right" on the last tab', () => {
    const { fixture, tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.focusSession({ id: 's2', title: 'Two' });
    fixture.detectChanges();

    openMenuOn(fixture, 1);

    const right = menuItems(fixture).find((item) => item.textContent?.includes('Close to the Right'));
    expect(right?.disabled).toBe(true);
  });

  it('renders a file as a chip of the session in front, and a plain row with none', () => {
    const { fixture, tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.openFile('README.md');
    fixture.detectChanges();

    // The Explorer's file is s1's chip: a second row, not a tab beside the session.
    const rows = fixture.nativeElement.querySelectorAll('.strip');
    expect(rows).toHaveLength(2);
    expect(rows[1].textContent).toContain('README.md');

    // With no session in front, the same call opens its own main-row tab.
    tabs.closeAll();
    fixture.detectChanges();
    tabs.openFile('docs/STATUS.md');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.strip')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('.strip').textContent).toContain('STATUS.md');
  });

  it('makes the whole chip row two lines when any file name is shared', () => {
    const { fixture, tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.openFile('overlays/production/service/postgresql.yaml');
    tabs.openFile('overlays/production/persistence/postgresql.yaml');
    // Unique, but the row it sits in has a clash: it still gets the second line,
    // so every chip is the same height and the folders line up.
    tabs.openFile('overlays/production/kustomization.yaml');
    fixture.detectChanges();

    const chips = [
      ...fixture.nativeElement.querySelectorAll('.strip + .strip .tab.mention'),
    ] as HTMLElement[];
    expect(chips).toHaveLength(3);
    expect(chips.every((chip) => chip.classList.contains('has-dir'))).toBe(true);
    expect(
      chips.map((chip) => chip.querySelector('.dir')?.textContent?.trim()).sort(),
    ).toEqual([
      'overlays/production',
      'overlays/production/persistence',
      'overlays/production/service',
    ]);
  });

  it('keeps every chip one line when no file name is shared', () => {
    const { fixture, tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.openFile('overlays/production/service/postgresql.yaml');
    tabs.openFile('overlays/production/kustomization.yaml');
    fixture.detectChanges();

    const chips = [
      ...fixture.nativeElement.querySelectorAll('.strip + .strip .tab.mention'),
    ] as HTMLElement[];
    expect(chips).toHaveLength(2);
    expect(chips.some((chip) => chip.classList.contains('has-dir'))).toBe(false);
    expect(chips.every((chip) => chip.querySelector('.dir') === null)).toBe(true);
  });

  it('marks the session a chip in front belongs to', () => {
    const { fixture, tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.focusSession({ id: 's2', title: 'Two' });
    tabs.openFile('README.md');
    fixture.detectChanges();

    const [main] = [...fixture.nativeElement.querySelectorAll('.strip')] as HTMLElement[];
    const sessions = [...main.querySelectorAll('.tab')] as HTMLElement[];
    const s1 = sessions.find((tab) => tab.textContent?.includes('One'));
    const s2 = sessions.find((tab) => tab.textContent?.includes('Two'));

    // The chip is the active tab; its session is marked as its owner, not as
    // active itself, so the chip's origin is obvious.
    expect(s2?.classList.contains('parent')).toBe(true);
    expect(s2?.classList.contains('active')).toBe(false);
    expect(s1?.classList.contains('parent')).toBe(false);
  });

  it('marks the file chip in front as the active, focused one', () => {
    const { fixture, tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.openFile('packages/ui-angular/src/app/nav/project-picker/project-picker.spec.ts');
    fixture.detectChanges();

    // The chip row's active class is what the stylesheet expands, highlights and
    // rings, so it has to be on exactly the chip in front — full name, not the
    // truncated one a chip gets when it is only context.
    const chips = [
      ...fixture.nativeElement.querySelectorAll('.strip + .strip .tab.mention'),
    ] as HTMLElement[];
    expect(chips).toHaveLength(1);
    expect(chips[0].classList.contains('active')).toBe(true);
    expect(chips[0].getAttribute('aria-selected')).toBe('true');
    expect(chips[0].querySelector('.label')?.textContent?.trim()).toBe('project-picker.spec.ts');
    expect(chips[0].getAttribute('title')).toBe(
      'packages/ui-angular/src/app/nav/project-picker/project-picker.spec.ts',
    );
  });

  it('marks a running session tab, even when another tab is in front', () => {
    const { fixture, tabs, morse } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.focusSession({ id: 's2', title: 'Two' });
    morse.sessionActivity.set(new Map([['s1', { sessionKey: 's1', streaming: true }]]));
    fixture.detectChanges();

    const [first, second] = fixture.nativeElement.querySelectorAll('.tab') as NodeListOf<HTMLElement>;
    expect(first.classList.contains('running')).toBe(true);
    expect(first.querySelector('.live')).not.toBeNull();
    expect(second.classList.contains('running')).toBe(false);
    expect(second.querySelector('.live')).toBeNull();
  });

  it('does not animate a session that is warm but not streaming', () => {
    const { fixture, tabs, morse } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    // Hot (the agent is attached) but idle: no spinner once the turn has ended.
    morse.sessionActivity.set(new Map([['s1', { sessionKey: 's1', streaming: false }]]));
    fixture.detectChanges();

    const tab = fixture.nativeElement.querySelector('.tab') as HTMLElement;
    expect(tab.classList.contains('running')).toBe(false);
    expect(tab.querySelector('.live')).toBeNull();
  });

  it('Close Others keeps the clicked tab and closes the rest', () => {
    const { fixture, tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.focusSession({ id: 's2', title: 'Two' });
    tabs.openFile('README.md');
    fixture.detectChanges();

    openMenuOn(fixture, 0);
    const others = menuItems(fixture).find((item) => item.textContent?.includes('Close Others'));
    others?.click();
    fixture.detectChanges();

    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['s1']);
    expect(fixture.nativeElement.querySelector('.context-menu')).toBeNull();
  });

  /**
   * The bug this locks: the context menu on a file chip used the whole strip as
   * its scope, so “Close All” on a chip also closed the session tab it belonged
   * to. A chip is context — its menu must only touch the chip row.
   */
  it('a file chip’s “Close All” never closes the session tab', () => {
    const { fixture, tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.openFile('a.ts');
    tabs.openFile('b.ts');
    fixture.detectChanges();

    // DOM order is the session first, then its chips: right-click the first chip.
    openMenuOn(fixture, 1);
    menuItems(fixture).find((item) => item.textContent?.includes('Close All'))?.click();
    fixture.detectChanges();

    expect(tabs.tabs().some((tab) => tab.kind === 'session' && tab.id === 's1')).toBe(true);
    expect(tabs.tabs().filter((tab) => tab.kind === 'file')).toHaveLength(0);
  });

  it('a file chip’s “Close Others” keeps the session and the clicked chip', () => {
    const { fixture, tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.openFile('a.ts');
    tabs.openFile('b.ts');
    fixture.detectChanges();

    openMenuOn(fixture, 1);
    menuItems(fixture).find((item) => item.textContent?.includes('Close Others'))?.click();
    fixture.detectChanges();

    expect(tabs.tabs().some((tab) => tab.kind === 'session' && tab.id === 's1')).toBe(true);
    expect(tabs.tabs().filter((tab) => tab.kind === 'file')).toHaveLength(1);
  });

  it('a standalone file’s “Close All” leaves session tabs alone', () => {
    const { fixture, tabs } = setup();
    tabs.closeAll();
    tabs.openFile('docs/STATUS.md');
    tabs.focusSession({ id: 's1', title: 'One' });
    fixture.detectChanges();

    const tabsInDom = [...fixture.nativeElement.querySelectorAll('.tab')] as HTMLElement[];
    const fileIndex = tabsInDom.findIndex((tab) => tab.textContent?.includes('STATUS'));
    openMenuOn(fixture, fileIndex);
    menuItems(fixture).find((item) => item.textContent?.includes('Close All'))?.click();
    fixture.detectChanges();

    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['s1']);
  });

  it('moves a tab to the slot CDK reports it was dropped on', () => {
    const { fixture, tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.focusSession({ id: 's2', title: 'Two' });
    tabs.focusSession({ id: 's3', title: 'Three' });
    fixture.detectChanges();
    const row = tabs.mainTabs();

    // A CDK drop carries the row as it was at drag start plus the landed index.
    (fixture.componentInstance as unknown as {
      onDrop: (event: { item: { data: unknown }; container: { data: unknown[] }; currentIndex: number }) => void;
    }).onDrop({ item: { data: row[0] }, container: { data: row }, currentIndex: 2 });

    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['s2', 's3', 's1']);
  });
});
