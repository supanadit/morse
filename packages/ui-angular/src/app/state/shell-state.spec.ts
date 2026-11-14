import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ShellState } from './shell-state';
import { LayoutState } from './layout-state';
import { OverlayStack } from './overlay-stack';

/**
 * The wide-layout fold is a preference, so it outlives a reload — that is the
 * part worth locking: a toggle nobody can see would fail silently.
 */
describe('ShellState', () => {
  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('keeps the drawer and the fold apart', () => {
    const shell = TestBed.inject(ShellState);
    const layout = TestBed.inject(LayoutState);

    layout.toggleVisible('left');
    expect(layout.leftCollapsed()).toBe(true);
    // Opening the narrow drawer must not unfold the column behind it.
    expect(shell.navigationOpen()).toBe(false);
    shell.toggleNavigation();
    expect(shell.navigationOpen()).toBe(true);
    expect(layout.leftCollapsed()).toBe(true);
  });

  it('remembers which face the left column shows', () => {
    const shell = TestBed.inject(ShellState);
    expect(shell.leftPane()).toBe('sessions');

    shell.setLeftPane('files');
    expect(localStorage.getItem('morse.left.pane')).toBe('files');

    TestBed.resetTestingModule();
    expect(TestBed.inject(ShellState).leftPane()).toBe('files');

    // A stored value that names no view falls back to the list.
    localStorage.setItem('morse.left.pane', 'garbage');
    TestBed.resetTestingModule();
    expect(TestBed.inject(ShellState).leftPane()).toBe('sessions');
  });

  it('knows when a dialog owns the screen', () => {
    const shell = TestBed.inject(ShellState);
    const stack = TestBed.inject(OverlayStack);
    expect(shell.modalOpen()).toBe(false);

    // A flag says *which* dialog was asked for; the stack says one is on screen. In the
    // app the two move together — `app.html` mounts the dialog on that flag, and
    // `ui/dialog` registers on create — so what `modalOpen` follows is the registration.
    shell.openProjectFilter();
    expect(shell.projectFilterOpen()).toBe(true);
    const release = stack.open(() => undefined);
    expect(shell.modalOpen()).toBe(true);
    release();
    expect(shell.modalOpen()).toBe(false);
    shell.closeProjectFilter();

    shell.toggleShortcuts();
    expect(shell.shortcutsOpen()).toBe(true);
    shell.toggleShortcuts();
    expect(shell.shortcutsOpen()).toBe(false);

    shell.togglePalette();
    expect(shell.paletteOpen()).toBe(true);
    shell.closePalette();
    expect(shell.paletteOpen()).toBe(false);

    shell.requestCompact('keep the schema');
    expect(shell.compactConfirmOpen()).toBe(true);
    shell.closeCompactPrompt();
    expect(shell.compactConfirmOpen()).toBe(false);

    shell.requestStop();
    expect(shell.stopConfirmOpen()).toBe(true);
    shell.closeStopPrompt();
    expect(shell.stopConfirmOpen()).toBe(false);
  });

  it('shares the project the sidebar is narrowed to, and keeps it across a reload', () => {
    const shell = TestBed.inject(ShellState);
    expect(shell.projectFilterPath()).toBe('');

    shell.setProjectFilter('/work/morse');
    expect(shell.projectFilterPath()).toBe('/work/morse');
    expect(localStorage.getItem('morse.nav.projectFilter')).toBe('/work/morse');

    // A browser refresh rebuilds the shell; the narrowed list must come back
    // narrowed — the reader picked that project on purpose.
    TestBed.resetTestingModule();
    expect(TestBed.inject(ShellState).projectFilterPath()).toBe('/work/morse');

    // Back to every project — the palette's "All projects" row uses the same
    // setter, and the stored choice goes with it. The reset built a fresh
    // instance; the old one is a leftover, so the assertion names the new one.
    const reloaded = TestBed.inject(ShellState);
    reloaded.setProjectFilter('');
    expect(reloaded.projectFilterPath()).toBe('');
    expect(localStorage.getItem('morse.nav.projectFilter')).toBeNull();
  });
});
