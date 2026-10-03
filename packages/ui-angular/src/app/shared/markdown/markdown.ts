import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { renderMarkdown, renderUserMarkdown } from '../../core/markdown';

/**
 * How often streamed prose is re-rendered.
 *
 * One render per pi delta buys nothing a reader can see, and this is the panel's
 * hottest path by far: every delta re-parses the whole answer (`marked`),
 * sanitises it (DOMPurify) and re-highlights every code block (highlight.js) —
 * measured at ~5 ms per render for a 1 kB answer in a headless DOM and ~19 ms at
 * 10 kB, at a measured delta rate of 16–44 per second. Rendering at this cadence
 * instead costs roughly a quarter of that, and the markdown cache means a repeat
 * of the same text is free. The last value always lands: the timer fires once the
 * text stops changing.
 */
const RENDER_INTERVAL_MS = 90;

/**
 * Renders prose as formatted text: headings, lists, tables, links and highlighted
 * code with a copy button. The HTML is sanitised with DOMPurify before it is
 * trusted (model output is untrusted input).
 *
 * `variant="user"` renders a prompt instead: line breaks are preserved and any
 * `@mention` chip the caller injected is reported through `mention`.
 */
@Component({
  selector: 'morse-markdown',
  template: `
    <div class="md" [innerHTML]="html()" (click)="onClick($event)"></div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: block;
      }
    `,
  ],
})
export class Markdown {
  readonly text = input.required<string>();
  readonly variant = input<'assistant' | 'user'>('assistant');
  /** A click on an `@mention` chip, for a host that can open the file. */
  readonly mention = output<string>();

  private readonly sanitizer = inject(DomSanitizer);
  /**
   * The text that has actually been rendered. `null` until the first streamed
   * change, so the first paint comes straight from the input: a resumed
   * transcript, or a message that arrives whole, must not wait for a timer.
   */
  private readonly painted = signal<string | null>(null);
  private pending: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  protected readonly html = computed<SafeHtml>(() => {
    const text = this.painted() ?? this.text();
    return this.sanitizer.bypassSecurityTrustHtml(
      this.variant() === 'user' ? renderUserMarkdown(text) : renderMarkdown(text),
    );
  });

  constructor() {
    effect(() => {
      const next = this.text();
      const painted = untracked(() => this.painted());
      // Nothing painted yet: the computed above is already showing `text()`, so
      // this is the baseline the throttle moves from, not a change to slow down.
      if (painted === null) {
        this.painted.set(next);
        return;
      }
      if (painted === next || this.pending === next) {
        return;
      }
      this.pending = next;
      this.schedule();
    });
    inject(DestroyRef).onDestroy(() => this.cancel());
  }

  /** One timer at a time, whatever the delta rate. */
  private schedule(): void {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      const pending = this.pending;
      this.pending = undefined;
      if (pending !== undefined) {
        this.painted.set(pending);
      }
    }, RENDER_INTERVAL_MS);
  }

  private cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Delegated handler: code blocks and mention chips without extra bindings. */
  protected onClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    const path = target?.closest('[data-mention-path]')?.getAttribute('data-mention-path');
    if (path) {
      this.mention.emit(path);
      return;
    }
    const button = target?.closest('button[data-copy]');
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    const code = button.closest('.code')?.querySelector('code');
    const text = code?.textContent ?? '';
    void navigator.clipboard?.writeText(text);
    const original = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => {
      button.textContent = original ?? 'Copy';
    }, 1200);
  }
}
