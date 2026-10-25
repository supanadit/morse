import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import type { FormField, FormValue, InteractionRequest, SelectOption } from '@morse/protocol';
import { MorseService } from '../../host/morse.service';
import { EnterDirective } from '../../ui/enter.directive';

/**
 * One option as the card renders it: the marker in the gutter and the text.
 *
 * pi's `select` takes `options: string[]` — plain strings, no label/description
 * split. A plugin that wants its options to read like a list numbers them itself
 * (`"1. Label — what it costs"`), so the card must not print a second number next
 * to the plugin's. When the option carries its own marker (and it agrees with the
 * position), that marker is used and stripped; otherwise the position supplies one.
 */
export interface ParsedOption {
  /** The value pi must receive when this row is picked. */
  value: string;
  /** The gutter marker, e.g. `"3."`. */
  ordinal: string;
  /** The option text, without the marker. */
  label: string;
  /** `option.description`, when the host populated it (pi never does). */
  description?: string;
}

export function parseOption(option: SelectOption, position: number): ParsedOption {
  const match = /^\s*(\d+)[.)]\s+(.+)$/su.exec(option.label);
  if (match && Number(match[1]) === position + 1) {
    return {
      value: option.value,
      ordinal: `${match[1]}.`,
      label: match[2]!,
      ...(option.description !== undefined ? { description: option.description } : {}),
    };
  }
  return {
    value: option.value,
    ordinal: `${position + 1}.`,
    label: option.label,
    ...(option.description !== undefined ? { description: option.description } : {}),
  };
}

/**
 * Rendered only when the host cannot show native dialogs (the browser/NestJS
 * host). Inside VS Code the extension answers `extension_ui_request`s with
 * QuickPick/InputBox and this panel stays hidden.
 *
 * It speaks pi's whole dialog sub-protocol — `select`, `confirm`, `input`,
 * `editor` — because that is the complete surface `createExtensionUIContext()`
 * exposes over RPC (pi ≥1.0, `dist/bundle`). A richer widget (tabs, a preview
 * pane, a review step) only exists in the terminal path (`ctx.ui.custom()`),
 * which RPC turns into a no-op, so nothing here is tailored to one plugin: any
 * extension asking a question gets the same card.
 *
 * It is an inline card, not a modal: the agent's question belongs with the
 * conversation above it, so it sits between the transcript and the composer and
 * is held to the same reading width (780px) as both. Nothing here covers the
 * screen or steals the caret from someone mid-sentence — but when no field has
 * focus, the card takes it so its own keys work.
 */
@Component({
  selector: 'morse-interaction-panel',
  templateUrl: './interaction.html',
  imports: [EnterDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.gone]': '!visible()' },
  styleUrl: './interaction.css',
})
export class InteractionPanel {
  private readonly morse = inject(MorseService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly request = this.morse.pendingInteraction;
  protected readonly value = signal('');
  /** A form's answers, keyed by field. */
  protected readonly formValues = signal<Record<string, FormValue>>({});
  protected readonly visible = computed(() => {
    const request = this.request();
    if (request === null) {
      return false;
    }
    // A form is the one kind a native-dialog host cannot answer itself (a
    // QuickPick has no room for several fields), so it is always rendered here.
    return request.kind === 'form' || this.morse.capabilities()?.nativeDialogs !== true;
  });

  /** The form's fields, in the order the agent asked them. */
  protected readonly formFields = computed<FormField[]>(() => {
    const request = this.request();
    return request?.kind === 'form' ? request.fields : [];
  });
  /** Only the fields whose `when` condition holds for the answers so far. */
  protected readonly visibleFormFields = computed<FormField[]>(() => {
    const values = this.formValues();
    return this.formFields().filter((field) => this.fieldVisible(field, values));
  });
  /** The first constraint an answer breaks, so Submit can stay disabled. */
  protected readonly formError = computed<string | undefined>(() => this.validationError());
  /** The option rows as rendered, so the gutter number is never printed twice. */
  protected readonly options = computed(() =>
    this.optionsOf(this.request()).map((option, index) => parseOption(option, index)),
  );
  /**
   * A question a plugin wrote across several lines (its own list, its own
   * instructions) is body text, not a headline. The header keeps the first line as
   * the heading and the rest reads as the message, so nothing is truncated into a
   * bold paragraph.
   */
  private readonly titleParts = computed(() => {
    const title = this.request()?.title ?? '';
    const cut = title.indexOf('\n');
    if (cut === -1) {
      return { heading: title, remainder: '' };
    }
    return { heading: title.slice(0, cut), remainder: title.slice(cut + 1).replace(/^\n+/, '') };
  });
  protected readonly heading = computed(() => this.titleParts().heading);
  protected readonly overflowTitle = computed(() => this.titleParts().remainder);

  constructor() {
    // Seed the field from the request's prefill each time a dialog arrives. The
    // old `[value]="value() || prefillOf(req)"` binding fell back to the prefill
    // whenever the field was empty, so an intentionally empty answer could never
    // be submitted. Seeding once keeps that possible.
    effect(() => {
      const request = this.request();
      this.value.set(this.prefillOf(request));
      this.formValues.set(this.defaultsOf(request));
    });

    /*
     * Give the card the keyboard when a question arrives, but never take the caret
     * out of a field the reader is already typing in: a question that interrupts a
     * half-written prompt must wait its turn, not swallow a keystroke.
     */
    effect(() => {
      const request = this.request();
      if (!request || this.morse.capabilities()?.nativeDialogs === true || this.isTypingElsewhere()) {
        return;
      }
      setTimeout(() => this.focusPrimary(request), 0);
    });
  }

  protected onInput(event: Event): void {
    this.value.set((event.target as HTMLInputElement | HTMLTextAreaElement).value);
  }

  protected choose(option: ParsedOption): void {
    this.respond({ value: option.value });
  }

  /** Seeds a form from each field's default, so a required value starts filled. */
  private defaultsOf(request: InteractionRequest | null | undefined): Record<string, FormValue> {
    if (request?.kind !== 'form') {
      return {};
    }
    const values: Record<string, FormValue> = {};
    for (const field of request.fields) {
      if (field.defaultValue !== undefined) {
        values[field.key] = field.defaultValue;
      }
    }
    return values;
  }

  protected fieldValue(key: string): FormValue | undefined {
    return this.formValues()[key];
  }

  /** A field's value as the text an input/select shows. */
  protected textValue(field: FormField): string {
    const value = this.fieldValue(field.key);
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }
    return '';
  }

  /** A text/number input changed; an empty number means "no answer yet". */
  protected setInput(field: FormField, event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    const value: FormValue | undefined =
      raw.length === 0 ? undefined : field.type === 'number' || field.type === 'integer' ? Number(raw) : raw;
    this.setField(field.key, value);
  }

  protected setChecked(key: string, event: Event): void {
    this.setField(key, (event.target as HTMLInputElement).checked);
  }

  protected setSelect(key: string, event: Event): void {
    const raw = (event.target as HTMLSelectElement).value;
    this.setField(key, raw.length === 0 ? undefined : raw);
  }

  protected isSelected(key: string, option: string): boolean {
    const value = this.fieldValue(key);
    return Array.isArray(value) && value.includes(option);
  }

  protected toggleMulti(key: string, option: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    const current = this.fieldValue(key);
    const selected = Array.isArray(current) ? [...current] : [];
    const next = checked ? [...new Set([...selected, option])] : selected.filter((entry) => entry !== option);
    this.setField(key, next.length === 0 ? undefined : next);
  }

  /** Submits every visible answer under its field key; cancel stays distinct. */
  protected submitForm(): void {
    if (this.formError() !== undefined) {
      return;
    }
    const values: Record<string, FormValue> = {};
    for (const field of this.visibleFormFields()) {
      const value = this.fieldValue(field.key);
      if (value !== undefined) {
        values[field.key] = value;
      }
    }
    this.respond({ values });
    this.formValues.set({});
  }

  private setField(key: string, value: FormValue | undefined): void {
    const values = { ...this.formValues() };
    if (value === undefined) {
      delete values[key];
    } else {
      values[key] = value;
    }
    this.formValues.set(values);
  }

  /** Whether a field is shown for the answers so far (`when` visibility). */
  private fieldVisible(field: FormField, values: Record<string, FormValue>): boolean {
    const when = field.when;
    if (when === undefined) {
      return true;
    }
    const current = values[when.field];
    if (when.equals !== undefined && !sameValue(current, when.equals)) {
      return false;
    }
    if (when.notEquals !== undefined && sameValue(current, when.notEquals)) {
      return false;
    }
    if (when.in !== undefined && !when.in.some((option) => sameValue(current, option))) {
      return false;
    }
    return true;
  }

  /** Every constraint a renderer can check locally; the first broken one. */
  private validationError(): string | undefined {
    const values = this.formValues();
    for (const field of this.visibleFormFields()) {
      const value = values[field.key];
      if (field.required === true && isEmptyAnswer(value, field.type)) {
        return `${field.label} is required.`;
      }
      if (value === undefined) {
        continue;
      }
      if (field.type === 'number' || field.type === 'integer') {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return `${field.label} must be a number.`;
        }
        if (field.type === 'integer' && !Number.isInteger(value)) {
          return `${field.label} must be a whole number.`;
        }
        if (field.min !== undefined && value < field.min) {
          return `${field.label} must be at least ${field.min}.`;
        }
        if (field.max !== undefined && value > field.max) {
          return `${field.label} must be at most ${field.max}.`;
        }
      }
      if (field.type === 'text' && field.pattern !== undefined && typeof value === 'string') {
        const pattern = safePattern(field.pattern);
        if (pattern !== undefined && !pattern.test(value)) {
          return `${field.label} is not in the expected format.`;
        }
      }
      if (
        field.type === 'select' &&
        field.options !== undefined &&
        typeof value === 'string' &&
        !field.options.some((option) => option.value === value)
      ) {
        return `${field.label} must be one of the offered choices.`;
      }
    }
    return undefined;
  }

  protected decide(confirmed: boolean): void {
    this.respond({ confirmed });
  }

  protected submit(): void {
    this.respond({ value: this.value() });
    this.value.set('');
  }

  protected cancel(): void {
    this.respond({ cancelled: true });
    this.value.set('');
  }

  /** The word in the header chip, so a glance says what is being asked. */
  protected kindOf(request: InteractionRequest): string {
    switch (request.kind) {
      case 'select':
        return 'Choose one';
      case 'confirm':
        return 'Confirm';
      case 'input':
        return 'Answer';
      case 'editor':
        return 'Edit';
      case 'form':
        return 'Form';
    }
  }

  protected messageOf(request: InteractionRequest): string {
    return request.kind === 'select' || request.kind === 'confirm' || request.kind === 'form'
      ? (request.message ?? '')
      : '';
  }

  protected placeholderOf(request: InteractionRequest): string {
    return request.kind === 'input' ? (request.placeholder ?? '') : '';
  }

  /** A confirmation the plugin flagged as destructive gets the warning colour. */
  protected dangerOf(request: InteractionRequest): boolean {
    return request.kind === 'confirm' && request.danger === true;
  }

  protected prefillOf(request: InteractionRequest | null | undefined): string {
    return request?.kind === 'editor' || request?.kind === 'input' ? (request.value ?? '') : '';
  }

  /**
   * Escape cancels every dialog — pi maps it to a cancel for all four kinds, and
   * it is the one way out a reader reaches for without looking. Arrow keys walk the
   * option rows when focus is already inside the card, matching pi's own select.
   */
  @HostListener('document:keydown', ['$event'])
  protected onKeydown(event: KeyboardEvent): void {
    // A question must not swallow keys aimed at a field the reader is typing in:
    // Escape would cancel a dialog they have not looked at yet. Focus inside the
    // card is the one place these keys belong to it.
    if (!this.visible() || event.defaultPrevented || this.isTypingElsewhere()) {
      return;
    }
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        this.cancel();
        return;
      case 'ArrowDown':
      case 'ArrowUp': {
        if (!this.stepOption(event.key === 'ArrowDown' ? 1 : -1)) {
          return;
        }
        event.preventDefault();
        return;
      }
      default:
        return;
    }
  }

  /**
   * Moves focus between option rows; false when focus is not already inside the
   * card (scrolling the transcript with the arrow keys must not yank focus into a
   * question) or there is nothing to move between.
   */
  private stepOption(step: number): boolean {
    const rows = [...this.host.nativeElement.querySelectorAll<HTMLElement>('.option')];
    if (rows.length === 0 || !this.host.nativeElement.contains(document.activeElement)) {
      return false;
    }
    const current = rows.indexOf(document.activeElement as HTMLElement);
    const next = current === -1 ? 0 : Math.min(Math.max(current + step, 0), rows.length - 1);
    rows[next]?.focus();
    return true;
  }

  /** Focus the control the dialog is built around, once it has rendered. */
  private focusPrimary(request: InteractionRequest): void {
    const card = this.host.nativeElement.querySelector<HTMLElement>('.card');
    if (!card) {
      return;
    }
    const target =
      request.kind === 'select'
        ? card.querySelector<HTMLElement>('.option')
        : request.kind === 'input' || request.kind === 'editor'
          ? card.querySelector<HTMLElement>('.field')
          : request.kind === 'form'
            ? card.querySelector<HTMLElement>('.form input, .form select, .form textarea')
            : // A confirmation: the safe choice, like `ConfirmDialog`.
              card.querySelector<HTMLElement>('.actions button.secondary');
    target?.focus();
  }

  private isTypingElsewhere(): boolean {
    const active = (globalThis as { document?: Document }).document?.activeElement;
    if (!(active instanceof HTMLElement)) {
      return false;
    }
    if (this.host.nativeElement.contains(active)) {
      return false;
    }
    return (
      active.tagName === 'INPUT' ||
      active.tagName === 'TEXTAREA' ||
      active.isContentEditable === true
    );
  }

  private respond(partial: {
    value?: string;
    confirmed?: boolean;
    cancelled?: boolean;
    values?: Record<string, FormValue>;
  }): void {
    const request = this.request();
    if (!request) {
      return;
    }
    this.morse.respond({ requestId: request.requestId, ...partial });
  }

  private optionsOf(request: InteractionRequest | null | undefined): SelectOption[] {
    return request?.kind === 'select' ? request.options : [];
  }
}

/** Form-value equality for `when` conditions: primitives, or element-wise arrays. */
function sameValue(left: FormValue | undefined, right: FormValue): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((entry, index) => entry === right[index]);
  }
  return left === right;
}

/** A missing answer: no value, an empty string, or an empty selection. */
function isEmptyAnswer(value: FormValue | undefined, type: FormField['type']): boolean {
  if (value === undefined) {
    return true;
  }
  if (type === 'boolean') {
    return value !== true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return typeof value === 'string' && value.length === 0;
}

/** A malformed pattern is not the reader's problem; validation simply skips it. */
function safePattern(source: string): RegExp | undefined {
  try {
    return new RegExp(source, 'u');
  } catch {
    return undefined;
  }
}
