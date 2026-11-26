import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import {
  WorkspaceTabs,
  SETTINGS_MEMBERS_TAB_ID,
  SETTINGS_PROVIDERS_TAB_ID,
} from '../../state/workspace-tabs';
import { SettingsNav } from './settings-nav';

function render(multiuser = true): ComponentFixture<SettingsNav> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [SettingsNav] });
  const fixture = TestBed.createComponent(SettingsNav);
  fixture.componentRef.setInput('multiuser', multiuser);
  fixture.detectChanges();
  return fixture;
}

function labels(fixture: ComponentFixture<SettingsNav>): string[] {
  return [...fixture.nativeElement.querySelectorAll('morse-tree .row .label')].map(
    (row) => row.textContent?.trim() ?? '',
  );
}

function clickRow(fixture: ComponentFixture<SettingsNav>, label: string): void {
  const rows = [...fixture.nativeElement.querySelectorAll(
    'morse-tree .row',
  )] as HTMLButtonElement[];
  const row = rows.find((candidate) =>
    candidate.querySelector('.label')?.textContent?.includes(label),
  );
  expect(row, `settings row "${label}"`).toBeDefined();
  row!.click();
  fixture.detectChanges();
}

describe('SettingsNav', () => {
  it('lists Management/Members and Engine/Providers as collapsible sections', () => {
    const fixture = render();
    expect(labels(fixture)).toEqual(['Management', 'Members', 'Engine', 'Providers']);
  });

  it('opens the Members page on leaf click', () => {
    const fixture = render();
    const tabs = TestBed.inject(WorkspaceTabs);

    clickRow(fixture, 'Members');
    expect(tabs.activeId()).toBe(SETTINGS_MEMBERS_TAB_ID);
  });

  it('opens the Providers page on leaf click', () => {
    const fixture = render();
    const tabs = TestBed.inject(WorkspaceTabs);

    clickRow(fixture, 'Providers');
    expect(tabs.activeId()).toBe(SETTINGS_PROVIDERS_TAB_ID);
  });

  it('keeps Providers under its Engine section on a single-user host', () => {
    const fixture = render(false);
    expect(labels(fixture)).toEqual(['Engine', 'Providers']);
  });

  it('folds a section from its caret without opening a page', () => {
    const fixture = render();
    const tabs = TestBed.inject(WorkspaceTabs);
    const before = tabs.activeId();

    const chevron = fixture.nativeElement.querySelector(
      'morse-tree .line .chevron',
    ) as HTMLButtonElement;
    chevron.click();
    fixture.detectChanges();

    expect(labels(fixture)).toEqual(['Management', 'Engine', 'Providers']);
    expect(tabs.activeId()).toBe(before);
  });
});
