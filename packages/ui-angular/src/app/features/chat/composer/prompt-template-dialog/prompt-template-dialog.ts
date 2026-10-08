import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { composePromptTemplate, type PromptTemplateForm } from '@morse/ui-runtime';
import { Dialog } from '../../../../ui/dialog/dialog';

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
  imports: [Dialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './prompt-template-dialog.css',
})
export class PromptTemplateDialog {
  readonly request = input.required<PromptTemplateRequest>();
  /** The composed prompt, ready for the composer to send with its attachments. */
  readonly submitted = output<string>();
  readonly cancelled = output<void>();

  /**
   * This dialog's own element. What it projects ends up inside the shared shell, which
   * is inside this host, so this is how the caret finds the first field when the dialog
   * opens — a template ref on `<morse-dialog>` would name the component, not its DOM.
   */
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

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
        this.host.nativeElement.querySelector<HTMLElement>('input, textarea')?.focus();
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
}
