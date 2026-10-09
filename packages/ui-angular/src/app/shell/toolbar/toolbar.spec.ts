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
});
