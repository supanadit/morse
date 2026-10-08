import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { composePromptTemplate, type PromptTemplateForm } from '@morse/ui-runtime';

/** What opens the form: the prompt template the palette picked. */
export interface PromptTemplateRequest {
  /** Template name, printed without the leading slash. */
  name: string;
  description?: string;
  form: PromptTemplateForm;
}

/**
 * The form for a prompt template that declares arguments.
 *
 * pi expands `/template args` itself, but it never lets extra words ride below
 * the template — they are arguments, and unreferenced ones are dropped. The
 * form therefore owns the expansion: the fields feed `$1…$n`, the extra textarea
 * is appended after a blank line, and the preview shows the exact prompt the
 * agent will receive.
 */
@Component({
  selector: 'morse-prompt-template-dialog',
  templateUrl: './prompt-template-dialog.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: contents;
      }
      .modal-layer {
        position: fixed;
        inset: 0;
        z-index: 75;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgb(0 0 0 / 45%);
      }
      .modal-card {
        display: flex;
        flex-direction: column;
        gap: 12px;
        width: min(560px, 100%);
        max-height: min(84vh, 760px);
        overflow: auto;
        padding: 16px 18px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-lg);
        background: var(--morse-panel, var(--morse-bg));
        box-shadow: 0 18px 48px rgb(0 0 0 / 40%);
        animation: template-in 140ms ease-out;
      }
      .head {
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      h2 {
        margin: 0;
        font-family: var(--morse-font-mono);
        font-size: 14px;
        font-weight: 600;
      }
      .description {
        margin: 0;
        font-size: 12px;
        color: var(--morse-fg-muted);
      }
      form,
      .fields {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .field-label {
        font-size: 11.5px;
        font-weight: 600;
        color: var(--morse-fg-muted);
      }
      .required,
      .optional {
        margin-left: 4px;
        font-weight: 400;
        font-size: 10.5px;
      }
      .required {
        color: var(--morse-warn);
      }
      .optional {
        color: var(--morse-fg-muted);
      }
      input,
      textarea {
        width: 100%;
        padding: 6px 8px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-input-bg, transparent);
        color: var(--morse-fg);
        font-family: inherit;
        font-size: 12.5px;
        resize: vertical;
      }
      input:focus,
      textarea:focus {
        outline: none;
        border-color: var(--morse-accent);
      }
      .preview {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      pre {
        margin: 0;
        max-height: 180px;
        overflow: auto;
        padding: 8px 10px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-code-bg, rgb(0 0 0 / 18%));
        color: var(--morse-fg);
        font-family: var(--morse-font-mono);
        font-size: 11.5px;
        line-height: 1.55;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
      }
      @keyframes template-in {
        from {
          opacity: 0;
          transform: translateY(6px);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .modal-card {
          animation: none;
        }
      }
    `,
  ],
})
export class PromptTemplateDialog {
  readonly request = input.required<PromptTemplateRequest>();
  /** The composed prompt, ready for the composer to send with its attachments. */
  readonly submitted = output<string>();
  readonly cancelled = output<void>();

  private readonly card = viewChild<ElementRef<HTMLElement>>('card');

  protected readonly values = signal<Record<string, string>>({});
  protected readonly extra = signal('');

  protected readonly preview = computed(() =>
    composePromptTemplate(this.request().form, this.values(), this.extra()),
  );

  /** A required field must be filled before the prompt can be sent. */
  protected readonly ready = computed(() =>
    this.request().form.arguments.every(
      (argument) => !argument.required || (this.values()[argument.id] ?? '').trim().length > 0,
    ),
  );

  constructor() {
    // Each open starts from empty fields, with the caret in the first one. The
    // write is safe: this effect reads the request, never the values it sets.
    effect(() => {
      this.request();
      this.values.set({});
      this.extra.set('');
      setTimeout(() => {
        this.card()?.nativeElement.querySelector<HTMLElement>('input, textarea')?.focus();
      }, 0);
    });
  }

  protected value(id: string): string {
    return this.values()[id] ?? '';
  }

  protected setValue(id: string, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    this.values.update((current) => ({ ...current, [id]: value }));
  }

  protected setExtra(event: Event): void {
    this.extra.set((event.target as HTMLTextAreaElement).value);
  }

  protected submit(event?: Event): void {
    event?.preventDefault();
    if (!this.ready()) {
      return;
    }
    this.submitted.emit(this.preview());
  }

  /** Enter sends from a single-line field; a textarea needs Ctrl/Cmd+Enter. */
  protected onSubmitKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      this.submit(event);
    }
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.cancelled.emit();
  }
}
