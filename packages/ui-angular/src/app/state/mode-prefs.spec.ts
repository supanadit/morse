import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ModePrefs } from './mode-prefs';

/**
 * Where the reader was is theirs to come back to: the Code/Bot tab they left, and
 * in bot mode the conversation that was in front. No transport is provided here,
 * so `ViewState` takes its browser path (`localStorage`) — exactly the store these
 * two facts live in for the web host.
 */
describe('ModePrefs', () => {
  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  function prefs(): ModePrefs {
    return TestBed.inject(ModePrefs);
  }

  it('starts in code mode with no bot conversation', () => {
    expect(prefs().mode()).toBe('code');
    expect(prefs().botConversation()).toBeNull();
  });

  it('remembers the mode across a reload', () => {
    prefs().setMode('bot');

    // A fresh instance is what a reload builds; the tab has to survive it.
    TestBed.resetTestingModule();
    expect(prefs().mode()).toBe('bot');

    prefs().setMode('code');
    TestBed.resetTestingModule();
    expect(prefs().mode()).toBe('code');
  });

  it('remembers the open bot conversation across a reload', () => {
    prefs().rememberBotConversation('group-workshop');

    TestBed.resetTestingModule();
    expect(prefs().botConversation()).toBe('group-workshop');
  });

  it('forgets a conversation the host no longer lists', () => {
    prefs().rememberBotConversation('group-workshop');
    prefs().rememberBotConversation(null);

    TestBed.resetTestingModule();
    expect(prefs().botConversation()).toBeNull();
  });

  it('falls back to code for a stored mode it does not know', () => {
    localStorage.setItem('morse.view.mode.current', '"bot-mode"');
    expect(prefs().mode()).toBe('code');
  });

  it('ignores a stored conversation id it cannot read', () => {
    localStorage.setItem('morse.view.mode.botConversation', '{oops}');
    expect(prefs().botConversation()).toBeNull();
  });
});
