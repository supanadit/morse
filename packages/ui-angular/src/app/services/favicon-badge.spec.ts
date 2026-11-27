import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { FaviconBadge } from './favicon-badge';
import { UnreadBots } from '../state/unread-bots';
import { UnreadSessions } from '../state/unread-sessions';

describe('FaviconBadge', () => {
  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
    document.title = 'Morse';
    document.querySelector('link[data-test-favicon]')?.remove();
  });

  it('dots the favicon and titles the count while anything is unread', () => {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    link.href = 'favicon.svg';
    link.setAttribute('data-test-favicon', '');
    document.head.appendChild(link);

    TestBed.inject(FaviconBadge);
    TestBed.inject(UnreadSessions).mark(['a']);
    TestBed.inject(UnreadBots).mark(['b']);
    TestBed.tick();

    // Both modes add up in the one tab title, and the Morse dash turns red.
    expect(document.title).toBe('(2) Morse');
    expect(link.href).toContain('data:image/svg+xml');
    expect(link.href).toContain('%23ff5f57');

    TestBed.inject(UnreadSessions).clear('a');
    TestBed.inject(UnreadBots).clear('b');
    TestBed.tick();

    expect(document.title).toBe('Morse');
    expect(link.href).toContain('favicon.svg');

    link.remove();
  });
});
