import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ShellState } from './shell-state';

/**
 * The wide-layout fold is a preference, so it outlives a reload — that is the
 * part worth locking: a toggle nobody can see would fail silently.
 */
describe('ShellState', () => {
  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('starts unfolded and folds on toggle', () => {
    const shell = TestBed.inject(ShellState);
    expect(shell.navigationCollapsed()).toBe(false);

    shell.toggleNavigationCollapsed();
    expect(shell.navigationCollapsed()).toBe(true);

    shell.toggleNavigationCollapsed();
    expect(shell.navigationCollapsed()).toBe(false);
  });

  it('remembers the fold across a reload', () => {
    TestBed.inject(ShellState).toggleNavigationCollapsed();

    // A fresh instance is what a reload builds; the preference has to survive it.
    TestBed.resetTestingModule();
    expect(TestBed.inject(ShellState).navigationCollapsed()).toBe(true);

    // …and unfolding is remembered just as well.
    TestBed.inject(ShellState).toggleNavigationCollapsed();
    TestBed.resetTestingModule();
    expect(TestBed.inject(ShellState).navigationCollapsed()).toBe(false);
  });

  it('keeps the drawer and the fold apart', () => {
    const shell = TestBed.inject(ShellState);

    shell.toggleNavigationCollapsed();
    expect(shell.navigationCollapsed()).toBe(true);
    // Opening the narrow drawer must not unfold the column behind it.
    expect(shell.navigationOpen()).toBe(false);
    shell.toggleNavigation();
    expect(shell.navigationOpen()).toBe(true);
    expect(shell.navigationCollapsed()).toBe(true);
  });

  /**
   * `modalOpen` is what lets overlay shortcuts stand down, so it has to include
   * every dialog that can cover the app — including the help itself.
   */
  it('resizes the Explorer pane and clamps the height to a usable range', () => {
    const shell = TestBed.inject(ShellState);
    expect(shell.explorerHeight()).toBeUndefined();

    shell.setExplorerHeight(320);
    expect(shell.explorerHeight()).toBe(320);

    shell.setExplorerHeight(10);
    expect(shell.explorerHeight()).toBe(140);
    shell.setExplorerHeight(10_000);
    expect(shell.explorerHeight()).toBe(720);
  });

  it('remembers the Explorer height across a reload', () => {
    TestBed.inject(ShellState).setExplorerHeight(280);

    TestBed.resetTestingModule();
    expect(TestBed.inject(ShellState).explorerHeight()).toBe(280);
  });

  it('resizes the git panel and clamps the width to a usable range', () => {
    const shell = TestBed.inject(ShellState);
    expect(shell.gitPanelWidth()).toBeUndefined();

    shell.setGitPanelWidth(520);
    expect(shell.gitPanelWidth()).toBe(520);
    shell.setGitPanelWidth(10);
    expect(shell.gitPanelWidth()).toBe(220);
    shell.setGitPanelWidth(5_000);
    expect(shell.gitPanelWidth()).toBe(1600);

    TestBed.resetTestingModule();
    expect(TestBed.inject(ShellState).gitPanelWidth()).toBe(1600);

    // A double-click (or a reload after one) goes back to the CSS default.
    TestBed.inject(ShellState).resetGitPanelWidth();
    expect(TestBed.inject(ShellState).gitPanelWidth()).toBeUndefined();
    TestBed.resetTestingModule();
    expect(TestBed.inject(ShellState).gitPanelWidth()).toBeUndefined();
  });

  it('clamps and remembers the git Changes height', () => {
    const shell = TestBed.inject(ShellState);
    shell.setGitChangesHeight(260);
    expect(shell.gitChangesHeight()).toBe(260);
    shell.setGitChangesHeight(10);
    expect(shell.gitChangesHeight()).toBe(48);
    shell.setGitChangesHeight(10_000);
    expect(shell.gitChangesHeight()).toBe(1200);

    TestBed.resetTestingModule();
    expect(TestBed.inject(ShellState).gitChangesHeight()).toBe(1200);
  });

  it('folds the git sections independently', () => {
    const shell = TestBed.inject(ShellState);
    expect(shell.gitChangesCollapsed()).toBe(false);
    shell.toggleGitChanges();
    expect(shell.gitChangesCollapsed()).toBe(true);
    expect(shell.gitHistoryCollapsed()).toBe(false);
    shell.toggleGitHistory();
    expect(shell.gitHistoryCollapsed()).toBe(true);
  });

  it('folds the Staged and Unstaged groups independently, and remembers it', () => {
    const shell = TestBed.inject(ShellState);
    expect(shell.gitStagedCollapsed()).toBe(false);

    shell.toggleGitStaged();
    expect(shell.gitStagedCollapsed()).toBe(true);
    expect(shell.gitUnstagedCollapsed()).toBe(false);

    shell.toggleGitUnstaged();
    expect(shell.gitUnstagedCollapsed()).toBe(true);

    TestBed.resetTestingModule();
    expect(TestBed.inject(ShellState).gitStagedCollapsed()).toBe(true);
    expect(TestBed.inject(ShellState).gitUnstagedCollapsed()).toBe(true);
  });

  it('knows when a dialog owns the screen', () => {
    const shell = TestBed.inject(ShellState);
    expect(shell.modalOpen()).toBe(false);

    shell.openProjectFilter();
    expect(shell.projectFilterOpen()).toBe(true);
    expect(shell.modalOpen()).toBe(true);
    shell.closeProjectFilter();
    expect(shell.modalOpen()).toBe(false);

    shell.toggleShortcuts();
    expect(shell.shortcutsOpen()).toBe(true);
    expect(shell.modalOpen()).toBe(true);
    shell.toggleShortcuts();
    expect(shell.shortcutsOpen()).toBe(false);
    expect(shell.modalOpen()).toBe(false);

    shell.togglePalette();
    expect(shell.paletteOpen()).toBe(true);
    expect(shell.modalOpen()).toBe(true);
    shell.closePalette();
    expect(shell.paletteOpen()).toBe(false);
    expect(shell.modalOpen()).toBe(false);

    shell.requestCompact('keep the schema');
    expect(shell.modalOpen()).toBe(true);
    shell.closeCompactPrompt();
    expect(shell.modalOpen()).toBe(false);
  });

  it('shares the project the sidebar is narrowed to', () => {
    const shell = TestBed.inject(ShellState);
    expect(shell.projectFilterPath()).toBe('');

    shell.setProjectFilter('/work/morse');
    expect(shell.projectFilterPath()).toBe('/work/morse');

    // Back to every project — the palette's "All projects" row uses the same setter.
    shell.setProjectFilter('');
    expect(shell.projectFilterPath()).toBe('');
  });
});
