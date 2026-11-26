import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ShellState } from '../../state/shell-state';
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
    const shell = TestBed.inject(ShellState);

    const row = fixture.nativeElement.querySelector('.row') as HTMLButtonElement;
    expect(row.textContent).toContain('Members');
    expect(row.getAttribute('aria-current')).toBeNull();

    row.click();
    fixture.detectChanges();
    expect(shell.adminOpen()).toBe(true);
    expect(
      (fixture.nativeElement.querySelector('.row') as HTMLButtonElement).getAttribute(
        'aria-current',
      ),
    ).toBe('page');
  });
});
