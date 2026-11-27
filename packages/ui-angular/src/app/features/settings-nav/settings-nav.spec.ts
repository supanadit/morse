import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import {
  WorkspaceTabs,
  SETTINGS_ACCESS_TAB_ID,
  SETTINGS_GIT_TAB_ID,
  SETTINGS_GPG_TAB_ID,
  SETTINGS_MEMBERS_TAB_ID,
  SETTINGS_OIDC_TAB_ID,
  SETTINGS_PROVIDERS_TAB_ID,
} from '../../state/workspace-tabs';
import { SettingsNav } from './settings-nav';

function render(multiuser = true, admin = true): ComponentFixture<SettingsNav> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [SettingsNav] });
  const fixture = TestBed.createComponent(SettingsNav);
  fixture.componentRef.setInput('multiuser', multiuser);
  fixture.componentRef.setInput('admin', admin);
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
  it('lists Management/Members/Authentication, Access leaves and Engine/Providers as collapsible sections', () => {
    const fixture = render();
    expect(labels(fixture)).toEqual(['Management', 'Members', 'Authentication', 'Access', 'SSH keys', 'GPG keys', 'Git identity', 'Engine', 'Providers']);
  });

  it('shows only the pages a regular member may open, dropping emptied sections', () => {
    // Management holds only Members (admin-only), so the whole section goes;
    // Engine holds only Providers (admin-only), so it goes too. A future
    // Management → Profile leaf for everyone would keep the Management header
    // here with Profile under it — the rule is per leaf, not per section.
    const fixture = render(true, false);
    expect(labels(fixture)).toEqual(['Access', 'SSH keys', 'GPG keys', 'Git identity']);
  });

  it('opens the Members page on leaf click', () => {
    const fixture = render();
    const tabs = TestBed.inject(WorkspaceTabs);

    clickRow(fixture, 'Members');
    expect(tabs.activeId()).toBe(SETTINGS_MEMBERS_TAB_ID);
  });

  it('opens the Authentication page on leaf click', () => {
    const fixture = render();
    const tabs = TestBed.inject(WorkspaceTabs);

    clickRow(fixture, 'Authentication');
    expect(tabs.activeId()).toBe(SETTINGS_OIDC_TAB_ID);
  });

  it('opens the Providers page on leaf click', () => {
    const fixture = render();
    const tabs = TestBed.inject(WorkspaceTabs);

    clickRow(fixture, 'Providers');
    expect(tabs.activeId()).toBe(SETTINGS_PROVIDERS_TAB_ID);
  });

  it('keeps Providers under its Engine section on a single-user host', () => {
    const fixture = render(false);
    expect(labels(fixture)).toEqual(['Access', 'SSH keys', 'GPG keys', 'Git identity', 'Engine', 'Providers']);
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

    expect(labels(fixture)).toEqual(['Management', 'Access', 'SSH keys', 'GPG keys', 'Git identity', 'Engine', 'Providers']);
    expect(tabs.activeId()).toBe(before);
  });

  it('opens the SSH, GPG and Git pages on leaf click', () => {
    const fixture = render();
    const tabs = TestBed.inject(WorkspaceTabs);

    clickRow(fixture, 'SSH keys');
    expect(tabs.activeId()).toBe(SETTINGS_ACCESS_TAB_ID);

    clickRow(fixture, 'GPG keys');
    expect(tabs.activeId()).toBe(SETTINGS_GPG_TAB_ID);

    clickRow(fixture, 'Git identity');
    expect(tabs.activeId()).toBe(SETTINGS_GIT_TAB_ID);
  });
});
