import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { renderMarkdown, renderUserMarkdown } from '../../core/markdown';

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
  protected readonly html = computed<SafeHtml>(() =>
    this.sanitizer.bypassSecurityTrustHtml(
      this.variant() === 'user' ? renderUserMarkdown(this.text()) : renderMarkdown(this.text()),
    ),
  );

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
