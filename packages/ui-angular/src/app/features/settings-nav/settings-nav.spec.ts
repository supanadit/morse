import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { WorkspaceTabs, SETTINGS_MEMBERS_TAB_ID } from '../../state/workspace-tabs';
import { SettingsNav } from './settings-nav';

function render(): ComponentFixture<SettingsNav> {
  TestBed.configureTestingModule({ imports: [SettingsNav] });
  const fixture = TestBed.createComponent(SettingsNav);
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
});
