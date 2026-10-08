import { describe, expect, it } from 'vitest';
import { SHORTCUTS, bindingLabel, isManagedShortcut, type Binding } from './shortcuts.catalog';

describe('shortcut catalog', () => {
  it('covers the actions the shell offers, with one row per id', () => {
    const managed = SHORTCUTS.filter(isManagedShortcut).map((spec) => spec.id);

    expect(managed.sort()).toEqual([
      'command.palette',
      'context.compact',
      'help.shortcuts',
      'model.pick',
      'project.filter',
      'session.new',
      'session.search',
      'thinking.pick',
      'view.git',
      'view.mcp',
      'view.prompts',
    ]);
    // Local rows (Enter, `/` in the prompt) are reference only, so ids are unique
    // across the whole list and none of them can be bound by accident.
    expect(new Set(SHORTCUTS.map((spec) => spec.id)).size).toBe(SHORTCUTS.length);
    expect(SHORTCUTS.some((spec) => isManagedShortcut(spec) === false)).toBe(true);
  });

  it('prints the keys for the machine the dialog runs on', () => {
    expect(bindingLabel({ key: 'n', mod: true, alt: true }, false)).toBe('Ctrl+Alt+N');
    expect(bindingLabel({ key: 'n', mod: true, alt: true }, true)).toBe('⌘⌥N');
    expect(bindingLabel({ key: 'p', mod: true, alt: true }, true)).toBe('⌘⌥P');
    // A symbol is a key in its own right: Shift is how the keyboard makes it.
    expect(bindingLabel({ key: '?' }, false)).toBe('?');
    expect(bindingLabel({ key: '/' }, true)).toBe('/');
  });

  it('prints every key of a multi-key action on its one row', () => {
    const palette: readonly Binding[] = [
      { key: 'k', mod: true, alt: true },
      { key: '/', mod: true, alt: true },
    ];

    expect(bindingLabel(palette, true)).toBe('⌘⌥K / ⌘⌥/');
    expect(bindingLabel(palette, false)).toBe('Ctrl+Alt+K / Ctrl+Alt+/');
  });
});
