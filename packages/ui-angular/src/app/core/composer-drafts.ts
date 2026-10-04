import { Injectable, computed, inject, signal } from '@angular/core';
import { AttachmentStore } from './attachments';

/**
 * The half-typed message of each open session or draft tab. The composer shows
 * one at a time — the tab in front — and switching tabs must neither carry the
 * words into the wrong session nor lose them, so the text and its attachments
 * live here, keyed by the tab id, instead of in the component.
 *
 * Frontend shell state, not wire state: like pi's own draft, nothing is sent
 * until the reader presses Enter, and a reload starts clean.
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
}
