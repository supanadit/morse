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
});
