import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ShellState } from '../../state/shell-state';
import { Toolbar } from './toolbar';

/** The toolbar's one job: the window's way into every command. */
describe('Toolbar', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('opens the command palette from the command centre', () => {
    TestBed.configureTestingModule({ imports: [Toolbar] });
    const fixture = TestBed.createComponent(Toolbar);
    fixture.detectChanges();
    const shell = TestBed.inject(ShellState);
    expect(shell.paletteOpen()).toBe(false);

    (fixture.nativeElement.querySelector('.command') as HTMLButtonElement).click();

    expect(shell.paletteOpen()).toBe(true);
  });
});
