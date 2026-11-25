import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../../host/morse.service';
import { WorkspaceTabs } from '../../state/workspace-tabs';
import { TabStrip } from './tab-strip';

function setup() {
  const morse = {
    activateSession: vi.fn(),
    newSession: vi.fn(),
    requestHostCommand: vi.fn(() => Promise.resolve(undefined)),
    sharedComposer: () => false,
    sessionActivity: signal(new Map<string, { sessionKey: string; streaming: boolean }>()),
    state: signal({ sessionId: undefined as string | undefined, streaming: false }),
    sessions: signal<{ id: string; title: string; subagent?: boolean }[]>([]),
    items: signal<{ kind: string; child?: { sessionId: string } }[]>([]),
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

  it('tints a subagent tab and gives it the running spinner', () => {
    const { fixture, tabs, morse } = setup();
    tabs.focusSession({ id: 'parent', title: 'Parent' });
    tabs.focusSession({ id: 'kid', title: 'Explore' });
    morse.sessions.set([{ id: 'kid', title: 'Explore', subagent: true }]);
    morse.sessionActivity.set(new Map([['kid', { sessionKey: 'kid', streaming: true }]]));
    fixture.detectChanges();

    const kid = [...fixture.nativeElement.querySelectorAll('.tab')].find((tab: HTMLElement) =>
      tab.textContent?.includes('Explore'),
    ) as HTMLElement;
    // The host reports a running child as streaming even though it owns no
    // process, so the tab spins and stands out in the subagent violet.
    expect(kid.classList.contains('subagent')).toBe(true);
    expect(kid.classList.contains('running')).toBe(true);
    expect(kid.querySelector('.live')).not.toBeNull();
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

describe('TabStrip drawer (narrow windows)', () => {
  afterEach(() => TestBed.resetTestingModule());

  /** A tap on the bar: down, up, then the browser's click. */
  function tapBar(fixture: ComponentFixture<TabStrip>, from = 10): void {
    const bar = fixture.nativeElement.querySelector('.handle') as HTMLElement;
    bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientY: from }));
    bar.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientY: from }));
    bar.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
  }

  function sheet(fixture: ComponentFixture<TabStrip>): HTMLElement | null {
    return fixture.nativeElement.querySelector('.modal-card') as HTMLElement | null;
  }

  function rows(fixture: ComponentFixture<TabStrip>): HTMLElement[] {
    return [...fixture.nativeElement.querySelectorAll('.sheet-row')] as HTMLElement[];
  }

  it('names the tab in front, and lists every tab in the drawer', () => {
    const { fixture, tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.focusSession({ id: 's2', title: 'Two' });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.handle')?.textContent).toContain('Two');

    tapBar(fixture);

    // Every open tab, in strip order, not just the one the bar names.
    expect(rows(fixture).map((row) => row.textContent?.replace(/[✓×]/g, '').trim())).toEqual([
      '✦One',
      '✦Two',
    ]);
    expect(rows(fixture)[1].classList.contains('selected')).toBe(true);
  });

  it('indents a session file chip instead of drawing a folder tree', () => {
    const { fixture, tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.openFile('packages/system/src/bot/helpers.ts');
    tabs.openFile('README.md');
    fixture.detectChanges();

    tapBar(fixture);
    expect(fixture.nativeElement.querySelectorAll('.sheet-folder')).toHaveLength(0);

    const [session, ...files] = rows(fixture);
    expect(session.classList.contains('child')).toBe(false);
    expect(files.every((row) => row.classList.contains('child'))).toBe(true);
    expect(files[0].querySelector('.label')?.textContent).toContain('helpers.ts');
    expect(files[0].querySelector('.dir')?.textContent).toContain('packages/system/src/bot');

    files[0].click();
    fixture.detectChanges();
    expect(tabs.activeId()).toBe('mention:s1:packages/system/src/bot/helpers.ts');
    expect(sheet(fixture)).toBeNull();
  });

  it('puts a session chip under its session row, not at the end', () => {
    const { fixture, tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.openFile('helpers.ts');
    tabs.focusSession({ id: 's2', title: 'Two' });
    tabs.focusSession({ id: 's1', title: 'One' });
    fixture.detectChanges();

    tapBar(fixture);
    expect(rows(fixture).map((row) => row.querySelector('.label')?.textContent?.trim())).toEqual([
      'One',
      'helpers.ts',
      'Two',
    ]);
  });

  it('stays open after the click that opened it', () => {
    const { fixture, tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    fixture.detectChanges();

    // Opening on pointer-up mounted the backdrop before the click arrived, so the
    // click landed on it and dismissed the drawer at once. The click itself opens.
    const bar = fixture.nativeElement.querySelector('.handle') as HTMLElement;
    bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientY: 10 }));
    bar.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientY: 10 }));
    fixture.detectChanges();
    expect(sheet(fixture)).toBeNull();

    bar.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    expect(sheet(fixture)).not.toBeNull();

    // Once it is really up, a backdrop click is the ordinary way out.
    (fixture.nativeElement.querySelector('.modal-layer') as HTMLElement).click();
    fixture.detectChanges();
    expect(sheet(fixture)).toBeNull();
  });

  it('opens on a pull down, and closes again on Escape', () => {
    const { fixture, tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    fixture.detectChanges();

    const bar = fixture.nativeElement.querySelector('.handle') as HTMLElement;
    bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientY: 10 }));
    bar.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientY: 60 }));
    bar.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    expect(sheet(fixture)).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(sheet(fixture)).toBeNull();
  });

  it('toggles on a keyboard click, without a pointer gesture', () => {
    const { fixture, tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    fixture.detectChanges();

    const bar = fixture.nativeElement.querySelector('.handle') as HTMLElement;
    bar.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    expect(sheet(fixture)).not.toBeNull();

    bar.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    expect(sheet(fixture)).toBeNull();
  });

  it('picks a tab from the drawer and folds it away', () => {
    const { fixture, tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.focusSession({ id: 's2', title: 'Two' });
    fixture.detectChanges();

    tapBar(fixture);
    rows(fixture)[0].click();
    fixture.detectChanges();

    expect(tabs.activeId()).toBe('s1');
    expect(sheet(fixture)).toBeNull();
  });

  it('searches tab titles and paths, and forgets the query on close', () => {
    const { fixture, tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One', cwd: '/work/morse' });
    tabs.focusSession({ id: 's2', title: 'Two' });
    tabs.openFile('docs/STATUS.md');
    fixture.detectChanges();

    tapBar(fixture);
    const field = fixture.nativeElement.querySelector('.search input') as HTMLInputElement;
    const search = (text: string): void => {
      field.value = text;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      fixture.detectChanges();
    };

    // A file matches its path, and a session matches its directory as well as its title.
    search('status');
    expect(rows(fixture)).toHaveLength(1);
    expect(rows(fixture)[0].textContent).toContain('STATUS.md');

    search('MORSE');
    expect(rows(fixture)).toHaveLength(1);
    expect(rows(fixture)[0].textContent).toContain('One');

    search('nothing here');
    expect(rows(fixture)).toHaveLength(0);
    expect(sheet(fixture)?.textContent).toContain('No tabs match that search.');

    // A stale filter would make the next open look like every tab had vanished.
    (fixture.nativeElement.querySelector('.modal-layer') as HTMLElement).click();
    fixture.detectChanges();
    tapBar(fixture);
    expect(rows(fixture)).toHaveLength(3);
  });

  it('closes a tab from its row, and stays open while tabs remain', () => {
    const { fixture, tabs } = setup();
    tabs.focusSession({ id: 's1', title: 'One' });
    tabs.focusSession({ id: 's2', title: 'Two' });
    fixture.detectChanges();

    tapBar(fixture);
    (rows(fixture)[0].querySelector('.close') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(tabs.tabs().map((tab) => tab.id)).toEqual(['s2']);
    expect(sheet(fixture)).not.toBeNull();

    // The last one gone leaves nothing to list, so the drawer folds.
    (rows(fixture)[0].querySelector('.close') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(sheet(fixture)).toBeNull();
  });
});
