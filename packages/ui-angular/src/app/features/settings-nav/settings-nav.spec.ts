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

describe('SettingsNav', () => {
  it('lists Members, opening its page on click', () => {
    const fixture = render();
    const tabs = TestBed.inject(WorkspaceTabs);

    const row = fixture.nativeElement.querySelector('.row') as HTMLButtonElement;
    expect(row.textContent).toContain('Members');
    expect(row.getAttribute('aria-current')).toBeNull();

    row.click();
    fixture.detectChanges();
    expect(tabs.activeId()).toBe(SETTINGS_MEMBERS_TAB_ID);
    expect(
      (fixture.nativeElement.querySelector('.row') as HTMLButtonElement).getAttribute(
        'aria-current',
      ),
    ).toBe('page');
  });

  it('lists Providers directly below Members, opening its page on click', () => {
    const fixture = render();
    const tabs = TestBed.inject(WorkspaceTabs);
    const rows = [...fixture.nativeElement.querySelectorAll('.row')] as HTMLButtonElement[];
    expect(rows.map((row) => row.textContent?.trim())).toEqual([
      expect.stringContaining('Members'),
      expect.stringContaining('Providers'),
    ]);

    rows[1]!.click();
    fixture.detectChanges();
    expect(tabs.activeId()).toBe(SETTINGS_PROVIDERS_TAB_ID);
    expect(rows[1]!.getAttribute('aria-current')).toBe('page');
  });

  it('hides Members on a single-user host, leaving Providers', () => {
    const fixture = render(false);
    const rows = [...fixture.nativeElement.querySelectorAll('.row')] as HTMLButtonElement[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('Providers');
  });
});
