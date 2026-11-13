import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryHostTransport } from '@morse/ui-runtime';
import { ShellState } from '../../state/shell-state';
import { WorkspaceTabs } from '../../state/workspace-tabs';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { Toolbar } from './toolbar';

/** The toolbar's one job: the window's way into every command. */
describe('Toolbar', () => {
  afterEach(() => TestBed.resetTestingModule());

  beforeEach(async () => {
    // The mock host advertises `promptEditor`, so the button under test renders.
    await TestBed.configureTestingModule({
      imports: [Toolbar],
      providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new MemoryHostTransport() }],
    }).compileComponents();
  });

  it('opens the command palette from the command centre', () => {
    const fixture = TestBed.createComponent(Toolbar);
    fixture.detectChanges();
    const shell = TestBed.inject(ShellState);
    expect(shell.paletteOpen()).toBe(false);

    (fixture.nativeElement.querySelector('.command') as HTMLButtonElement).click();

    expect(shell.paletteOpen()).toBe(true);
  });

  it('opens the prompt-template editor from its button', () => {
    const fixture = TestBed.createComponent(Toolbar);
    fixture.detectChanges();
    const tabs = TestBed.inject(WorkspaceTabs);
    // The button takes the shared path, so the host choice (a tab here, an editor
    // panel in VS Code) is `WorkspaceTabs`'s to make and is tested there.
    const open = vi.spyOn(tabs, 'openPromptEditor');

    const button = fixture.nativeElement.querySelector('.prompts') as HTMLButtonElement;
    expect(button).toBeTruthy();
    button.click();

    expect(open).toHaveBeenCalledTimes(1);
  });

  it('shows Code as the mode in use, and Bot as a mode that is not here yet', () => {
    const fixture = TestBed.createComponent(Toolbar);
    fixture.detectChanges();

    // The mode row is drawn from the first release: one tab that is the product,
    // one that says it is coming — never a live control that opens nothing.
    const modes = [...fixture.nativeElement.querySelectorAll('.mode')] as HTMLButtonElement[];
    const code = modes.find((one) => one.textContent?.includes('Code'));
    const bot = modes.find((one) => one.textContent?.includes('Bot'));

    expect(code?.classList.contains('on')).toBe(true);
    expect(code?.getAttribute('aria-current')).toBe('page');
    expect(bot?.disabled).toBe(true);
    expect(bot?.textContent).toContain('Soon');
  });

  it('prints the keys that open the palette inside the search box', () => {
    const fixture = TestBed.createComponent(Toolbar);
    fixture.detectChanges();

    // The hint comes from the shortcut catalog, so it cannot promise a key the
    // keyboard does not answer to.
    const hint = fixture.nativeElement.querySelector('.command-key') as HTMLElement;
    expect(hint.textContent?.trim()).toBeTruthy();
  });
});
