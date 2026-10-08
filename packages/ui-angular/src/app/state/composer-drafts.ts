import { Injectable, computed, inject, signal } from '@angular/core';
import { AttachmentStore } from './attachments';

/**
 * Everything a saved composer draft holds: the words of each tab, keyed by its
 * session/draft id, and the attachments (`AttachmentStore` owns those).
 */
export interface DraftsSnapshot {
  texts: Record<string, string>;
  /** The attachments map; validated by `AttachmentStore.restore`, so opaque here. */
  attachments: unknown;
}

/**
 * The half-typed message of each open session or draft tab. The composer shows
 * one at a time — the tab in front — and switching tabs must neither carry the
 * words into the wrong session nor lose them, so the text and its attachments
 * live here, keyed by the tab id, instead of in the component.
 *
 * Frontend shell state, not wire state: like pi's own draft, nothing is sent
 * until the reader presses Enter. The browser host also saves it
 * (`WorkbenchPersistence` → `<MORSE_HOME>/drafts.json`), so a long prompt with
 * its attachments survives a reload, a `morse stop` or a closed laptop — and
 * stays isolated per tab.
 */
@Injectable({ providedIn: 'root' })
export class ComposerDrafts {
  private readonly attachments = inject(AttachmentStore);
  private readonly texts = signal<Record<string, string>>({});
  private readonly key = signal('');

  /** The draft of the tab in front. */
  readonly text = computed(() => this.texts()[this.key()] ?? '');

  /** Points the draft — and its attachments — at `key`; `''` when none is in front. */
  use(key: string | undefined): void {
    const next = key ?? '';
    if (next === this.key()) {
      return;
    }
    this.key.set(next);
    this.attachments.use(next);
  }

  setText(value: string): void {
    this.texts.update((map) => ({ ...map, [this.key()]: value }));
  }

  updateText(change: (value: string) => string): void {
    this.setText(change(this.text()));
  }

  /** True when a tab's draft holds nothing (an untouched "New session"). */
  isEmpty(key: string): boolean {
    return (this.texts()[key] ?? '').length === 0 && this.attachments.isEmpty(key);
  }

  /** A draft tab became a real session: its words follow the new id. */
  rekey(from: string, to: string): void {
    this.texts.update((map) => {
      const text = map[from];
      if (text === undefined) {
        return map;
      }
      const next = { ...map };
      delete next[from];
      next[to] = text;
      return next;
    });
    this.attachments.rekey(from, to);
    if (this.key() === from) {
      this.key.set(to);
    }
  }

  /** A tab was closed: its draft has nowhere to return to. */
  forget(key: string): void {
    this.texts.update((map) => {
      if (!(key in map)) {
        return map;
      }
      const next = { ...map };
      delete next[key];
      return next;
    });
    this.attachments.forget(key);
  }

  /** Every tab's half-written message, for the saved state. */
  snapshot(): DraftsSnapshot {
    return { texts: { ...this.texts() }, attachments: this.attachments.snapshot() };
  }

  /**
   * Restores saved drafts. The words already in memory win over the restored
   * ones, so a load that lands after the reader started typing cannot clobber
   * them; attachments follow the same rule in their store.
   */
  restore(snapshot: unknown): void {
    const parsed = asDraftsSnapshot(snapshot);
    if (parsed === undefined) {
      return;
    }
    this.texts.update((current) => ({ ...parsed.texts, ...current }));
    this.attachments.restore(parsed.attachments);
  }
}

/**
 * Validates a saved drafts snapshot: the words are kept, the attachments map is
 * passed through for `AttachmentStore` to validate. A broken shape is ignored
 * rather than thrown, so a stale file cannot stop the app from booting.
 */
function asDraftsSnapshot(value: unknown): DraftsSnapshot | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const texts: Record<string, string> = {};
  const rawTexts = candidate['texts'];
  if (typeof rawTexts === 'object' && rawTexts !== null) {
    for (const [key, text] of Object.entries(rawTexts as Record<string, unknown>)) {
      if (typeof text === 'string' && text.length > 0) {
        texts[key] = text;
      }
    }
  }
  return { texts, attachments: candidate['attachments'] };
}
