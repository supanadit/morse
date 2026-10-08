import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ShortcutsDialog } from './shortcuts-dialog';
import { OverlayEscape } from '../../../ui/overlay-escape';
import { ShortcutService } from '../../../services/shortcut.service';
import { SHORTCUTS, bindingLabel, isManagedShortcut } from '../../../services/shortcuts.catalog';
import { ShellState } from '../../../state/shell-state';

async function render(): Promise<{ host: HTMLElement; fixture: ReturnType<typeof TestBed.createComponent<ShortcutsDialog>> }> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({ imports: [ShortcutsDialog] }).compileComponents();
  // The dialog no longer listens for Escape itself: the shell owns that one
  // listener (`ui/overlay-escape.ts`), so a spec that presses Escape mounts it.
  TestBed.inject(OverlayEscape);
  const fixture = TestBed.createComponent(ShortcutsDialog);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, fixture };
}

describe('ShortcutsDialog', () => {
  it('prints the whole catalog, grouped the way the catalog is ordered', async () => {
    const { host } = await render();
    const groups = [...host.querySelectorAll('.group h3')].map((node) => node.textContent?.trim());

    expect(groups).toEqual(['Session', 'Navigate', 'Model', 'Context', 'Typing', 'Help']);
    expect(host.querySelectorAll('li')).toHaveLength(SHORTCUTS.length);
    // Keys come from the binding the service matches, so the printed row and the
    // working key are the same string, never two lists that agree by luck.
    expect([...host.querySelectorAll('kbd')].map((node) => node.textContent?.trim())).toEqual(
      SHORTCUTS.map((spec) => (isManagedShortcut(spec) ? bindingLabel(spec.binding) : spec.keys)),
    );
    expect(host.textContent).toContain('Ctrl+Alt+N');
  });

  it('marks the keys whose owner is not on screen instead of offering them', async () => {
    const { host, fixture } = await render();
    const managed = SHORTCUTS.filter(isManagedShortcut).length;

    // This render has no sidebar, no composer and no picker: nothing can run.
    expect(host.querySelectorAll('li.unavailable')).toHaveLength(managed);
    expect(host.textContent).toContain('not in this host');
    // The reference rows (`Enter`, `@`) are not the app's to enable or withdraw.
    expect(
      [...host.querySelectorAll('li')].filter((row) => row.querySelector('kbd')?.textContent === 'Enter'),
    ).toHaveLength(1);
    expect(host.querySelectorAll('li.unavailable')).not.toHaveLength(SHORTCUTS.length);

    const bind = TestBed.inject(ShortcutService).bind('context.compact', () => undefined);
    fixture.detectChanges();
    expect(host.querySelectorAll('li.unavailable')).toHaveLength(managed - 1);

    bind();
    fixture.detectChanges();
    expect(host.querySelectorAll('li.unavailable')).toHaveLength(managed);
  });

  it('closes on Escape and on the backdrop, leaving the card alone', async () => {
    const { host } = await render();
    const shell = TestBed.inject(ShellState);

    shell.openShortcuts();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(shell.shortcutsOpen()).toBe(false);

    // Reading the list must not count as clicking the backdrop behind it.
    shell.openShortcuts();
    (host.querySelector('.modal-card kbd') as HTMLElement).click();
    expect(shell.shortcutsOpen()).toBe(true);

    (host.querySelector('.modal-layer') as HTMLElement).click();
    expect(shell.shortcutsOpen()).toBe(false);
  });
});
