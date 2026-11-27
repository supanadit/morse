import { Injectable, effect, inject, untracked } from '@angular/core';
import { UnreadBots } from '../state/unread-bots';
import { UnreadSessions } from '../state/unread-sessions';

const TITLE = 'Morse';
/** The waiting colour: one Morse mark turns this red while anything is unread. */
const ALERT = '#ff5f57';

function unreadIcon(): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" role="img" aria-label="Morse">` +
    `<title>Morse</title><rect width="32" height="32" rx="7" fill="#0e639c" />` +
    `<g fill="#ffffff"><circle cx="7.85" cy="16" r="2.7" />` +
    `<circle cx="14.05" cy="16" r="2.7" /></g>` +
    `<rect x="19.25" y="13.3" width="7.6" height="5.4" rx="2.7" fill="${ALERT}" /></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * The tab itself as an indicator: while anything waits to be read, the
 * favicon's dash turns red and the title carries the count — the same dots as
 * the switcher, visible with the window buried. Both clear the moment the last
 * unread session or room is opened. A webview has no tab icon, where this is
 * a no-op.
 */
@Injectable({ providedIn: 'root' })
export class FaviconBadge {
  private readonly sessions = inject(UnreadSessions);
  private readonly bots = inject(UnreadBots);
  private readonly plain: string | null = readIconHref();

  constructor() {
    effect(() => {
      const total = this.sessions.ids().size + this.bots.ids().size;
      untracked(() => this.render(total));
    });
  }

  private render(total: number): void {
    const doc = globalThis.document;
    if (doc === undefined) return;
    const link = doc.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
    if (link !== null) {
      link.href = total > 0 ? unreadIcon() : (this.plain ?? 'favicon.svg');
    }
    doc.title = total > 0 ? `(${total}) ${TITLE}` : TITLE;
  }
}

function readIconHref(): string | null {
  try {
    return (
      globalThis.document?.querySelector<HTMLLinkElement>(
        'link[rel="icon"][type="image/svg+xml"]',
      )?.href ?? null
    );
  } catch {
    return null;
  }
}
