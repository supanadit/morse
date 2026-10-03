import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHORTCUTS, ShortcutService, bindingLabel, isManagedShortcut } from './shortcuts';
import { ShellState } from './shell-state';

type Press = { key: string; ctrl?: boolean; alt?: boolean; meta?: boolean; target?: EventTarget };

function service(): ShortcutService {
  return TestBed.inject(ShortcutService);
}

/** Presses a key on the document, which is where the service listens. */
function press({ key, ctrl = false, alt = false, meta = false, target }: Press): void {
  const event = new KeyboardEvent('keydown', {
    key,
    ctrlKey: ctrl,
    altKey: alt,
    metaKey: meta,
    bubbles: true,
    cancelable: true,
  });
  (target ?? document).dispatchEvent(event);
}

/** A text field to press keys *into*, so the editable guard has something real. */
function field(): HTMLTextAreaElement {
  const textarea = document.createElement('textarea');
  document.body.appendChild(textarea);
  return textarea;
}

beforeEach(() => {
  TestBed.resetTestingModule();
});

afterEach(() => {
  TestBed.resetTestingModule();
  document.body.innerHTML = '';
});

describe('shortcut catalog', () => {
  it('covers the actions the shell offers, with one row per id', () => {
    const managed = SHORTCUTS.filter(isManagedShortcut).map((spec) => spec.id);

    expect(managed.sort()).toEqual([
      'context.compact',
      'help.shortcuts',
      'model.pick',
      'project.filter',
      'session.new',
      'session.search',
      'thinking.pick',
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
});

describe('ShortcutService', () => {
  it('runs the action bound to the key, and only with the modifiers it asks for', () => {
    const ran = vi.fn();
    service().bind('session.new', ran);

    press({ key: 'n' });
    press({ key: 'n', ctrl: true });
    press({ key: 'n', alt: true });
    expect(ran).not.toHaveBeenCalled();

    press({ key: 'n', ctrl: true, alt: true });
    expect(ran).toHaveBeenCalledTimes(1);

    // Shift is how a keyboard produces a capital: Ctrl+Alt+Shift+N is the same
    // gesture, so it lands on the same action instead of nowhere.
    press({ key: 'N', ctrl: true, alt: true });
    expect(ran).toHaveBeenCalledTimes(2);

    // Cmd is not `mod` off macOS: the help prints Ctrl there, and so does the match.
    press({ key: 'n', meta: true, alt: true });
    expect(ran).toHaveBeenCalledTimes(2);
  });

  it('leaves characters to the field the caret is in, and modified keys to the shell', () => {
    const help = vi.fn();
    const model = vi.fn();
    service().bind('help.shortcuts', help);
    service().bind('model.pick', model);
    const textarea = field();

    press({ key: '?', target: textarea });
    press({ key: '/', target: textarea });
    expect(help).not.toHaveBeenCalled();

    // A modified combination is not a character, so it may fire while typing.
    press({ key: 'm', ctrl: true, alt: true, target: textarea });
    expect(model).toHaveBeenCalledTimes(1);

    press({ key: '?' });
    expect(help).toHaveBeenCalledTimes(1);
  });

  it('ignores AltGr, which Windows reports as Ctrl+Alt', () => {
    const ran = vi.fn();
    service().bind('session.new', ran);

    const event = new KeyboardEvent('keydown', {
      key: 'n',
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'getModifierState', { value: () => true });
    document.dispatchEvent(event);

    // A keyboard that types `ź` with AltGr+n must not start a session.
    expect(ran).not.toHaveBeenCalled();
  });

  it('stands down over a dialog, except for the key that closes it', () => {
    const model = vi.fn();
    const created = vi.fn();
    const help = vi.fn();
    const shortcuts = service();
    shortcuts.bind('model.pick', model);
    shortcuts.bind('session.new', created);
    shortcuts.bind('help.shortcuts', help);

    const shell = TestBed.inject(ShellState);
    shell.openAbout();
    expect(shell.modalOpen()).toBe(true);

    press({ key: 'm', ctrl: true, alt: true });
    // A picker behind a modal is a bug; a new session is work that happens
    // behind the question and waits there.
    expect(model).not.toHaveBeenCalled();
    press({ key: 'n', ctrl: true, alt: true });
    expect(created).toHaveBeenCalledTimes(1);

    // `?` is the exception: it has to be able to close the list it opened…
    shell.openShortcuts();
    press({ key: '?' });
    expect(help).toHaveBeenCalledTimes(1);

    // …but not somebody else's dialog: the list never stacks on top of About.
    shell.closeShortcuts();
    press({ key: '?' });
    expect(help).toHaveBeenCalledTimes(1);
  });

  it('keeps an action out of reach while its owner says it cannot run', () => {
    const ran = vi.fn();
    // The predicate reads a signal, the way a real owner asks its own state
    // ("are there models?"), so availability follows it live.
    const ready = signal(false);
    service().bind('context.compact', ran, () => ready());

    expect(service().available().get('context.compact')).toBe(false);
    press({ key: 'c', ctrl: true, alt: true });
    expect(ran).not.toHaveBeenCalled();

    ready.set(true);
    expect(service().available().get('context.compact')).toBe(true);
    press({ key: 'c', ctrl: true, alt: true });
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('reports an action whose owner left as unavailable', () => {
    const ran = vi.fn();
    const unbind = service().bind('thinking.pick', ran, () => true);
    expect(service().available().get('thinking.pick')).toBe(true);

    unbind();
    expect(service().available().get('thinking.pick')).toBe(false);
    press({ key: 't', ctrl: true, alt: true });
    expect(ran).not.toHaveBeenCalled();
  });

  it('leaves an unbound action alone instead of guessing', () => {
    expect(service().available().get('project.filter')).toBe(false);
    press({ key: 'p', ctrl: true, alt: true });
    expect(service().available().get('project.filter')).toBe(false);
  });
});
