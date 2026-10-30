import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  untracked,
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
 * A `form` is the one kind a native-dialog host cannot answer itself, so it is
 * always rendered here — as a stepper, one question at a time, with `select`
 * and `multiselect` as radio/checkbox rows instead of dropdowns.
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
  /**
   * A form is walked one question at a time: the steps are the visible fields in
   * ask order, and this is the one being shown. It is an index, not a key, so the
   * card follows the list when a `when` condition adds or removes a field.
   */
  protected readonly step = signal(0);
  protected readonly stepCount = computed(() => this.visibleFormFields().length);
  protected readonly currentField = computed<FormField | undefined>(
    () => this.visibleFormFields()[this.step()],
  );
  /** One field needs no stepper chrome — it is just the form's only question. */
  protected readonly stepperVisible = computed(() => this.stepCount() > 1);
  protected readonly isFirstStep = computed(() => this.step() <= 0);
  protected readonly isLastStep = computed(() => this.step() >= this.stepCount() - 1);
  /** The first constraint an answer breaks, so Submit can stay disabled. */
  protected readonly formError = computed<string | undefined>(() => this.validationError());
  /** The note under the control: this step's own problem while the reader is on it. */
  protected readonly currentError = computed(() => {
    const field = this.currentField();
    return field === undefined ? undefined : this.fieldError(field, this.formValues());
  });
  /**
   * What the reader is told: their own field's problem while they are on it, and
   * — on the last step, where Submit lives — the first problem anywhere, so a
   * disabled Submit is never a mystery.
   */
  protected readonly shownError = computed(() => {
    const own = this.currentError();
    if (own !== undefined) {
      return own;
    }
    return this.isLastStep() ? this.formError() : undefined;
  });
  /** Whether `shownError` is about another step; the note then jumps to it. */
  protected readonly shownErrorIsForeign = computed(
    () => this.currentError() === undefined && this.shownError() !== undefined,
  );
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
      this.step.set(0);
      this.customField.set(null);
      this.customDraft.set({});
    });

    /*
     * Give the card the keyboard when a question arrives, but never take the caret
     * out of a field the reader is already typing in: a question that interrupts a
     * half-written prompt must wait its turn, not swallow a keystroke.
     */
    effect(() => {
      const request = this.request();
      if (
        !request ||
        this.morse.capabilities()?.nativeDialogs === true ||
        this.isTypingElsewhere()
      ) {
        return;
      }
      setTimeout(() => this.focusPrimary(request), 0);
    });

    /*
     * A `when` condition answers itself: changing an earlier field can hide a
     * later one (or show one before the reader's position), so the step list
     * changes length while the card is open. Re-clamp the index whenever it does —
     * a vanished field must not leave the card pointing past its last step.
     */
    effect(() => {
      const count = this.visibleFormFields().length;
      const current = untracked(this.step);
      const clamped = count === 0 ? 0 : Math.min(current, count - 1);
      if (clamped !== current) {
        this.step.set(clamped);
      }
    });

    /*
     * Moving between steps moves the keyboard with it: the control the new step is
     * built around takes focus, under the same bargain the arrival effect makes.
     */
    effect(() => {
      const field = this.currentField();
      if (field === undefined || this.isTypingElsewhere()) {
        return;
      }
      setTimeout(() => this.focusFormStep(), 0);
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

  /** A field's value as the text an input shows. */
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
      raw.length === 0
        ? undefined
        : field.type === 'number' || field.type === 'integer'
          ? Number(raw)
          : raw;
    this.setField(field.key, value);
  }

  protected setChecked(key: string, event: Event): void {
    this.setField(key, (event.target as HTMLInputElement).checked);
  }

  /** A radio row was picked: the field holds that one value. */
  protected setChoice(field: FormField, value: string): void {
    this.setField(field.key, value);
  }

  /** Whether the field is answered by picking rows rather than typing. */
  protected isChoice(field: FormField): boolean {
    return field.type === 'select' || field.type === 'multiselect';
  }

  /** The field whose "Type something…" input is open, if any. */
  protected readonly customField = signal<string | null>(null);
  /** The uncommitted text of that input, kept per field while the card is open. */
  protected readonly customDraft = signal<Record<string, string>>({});

  /** Opens the hand-typed row, seeded with whatever custom answer is already set. */
  protected openCustom(field: FormField): void {
    const existing = this.customValue(field);
    this.customDraft.update((drafts) => ({ ...drafts, [field.key]: existing ?? '' }));
    this.customField.set(field.key);
    setTimeout(() => {
      this.host.nativeElement.querySelector<HTMLInputElement>('.custom-input')?.focus();
    }, 0);
  }

  protected closeCustom(): void {
    this.customField.set(null);
  }

  protected setCustomDraft(key: string, event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    this.customDraft.update((drafts) => ({ ...drafts, [key]: text }));
  }

  /** Enter on the hand-typed row: the text becomes (or joins) the answer. */
  protected commitCustom(field: FormField): void {
    const text = (this.customDraft()[field.key] ?? '').trim();
    if (text.length === 0) {
      this.closeCustom();
      return;
    }
    if (field.type === 'multiselect') {
      const current = this.fieldValue(field.key);
      const selected = Array.isArray(current) ? current : [];
      this.setField(field.key, [...new Set([...selected, text])]);
    } else {
      this.setField(field.key, text);
    }
    this.closeCustom();
  }

  /** The gutter ordinal of the hand-typed row: it follows the offered options. */
  protected customOrdinal(field: FormField): string {
    return `${(field.options?.length ?? 0) + 1}.`;
  }

  /** A select answer typed by hand: the value when it is not an offered option. */
  protected customValue(field: FormField): string | undefined {
    const value = this.fieldValue(field.key);
    if (typeof value !== 'string' || value.length === 0) {
      return undefined;
    }
    return (field.options ?? []).some((option) => option.value === value) ? undefined : value;
  }

  /** Multiselect answers typed by hand: entries that are not offered options. */
  protected customValues(field: FormField): string[] {
    const value = this.fieldValue(field.key);
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((entry) => !(field.options ?? []).some((option) => option.value === entry));
  }

  /** A hand-typed multiselect entry is a toggle like any other row. */
  protected removeCustom(field: FormField, entry: string): void {
    const current = this.fieldValue(field.key);
    const selected = Array.isArray(current) ? current : [];
    const next = selected.filter((value) => value !== entry);
    this.setField(field.key, next.length === 0 ? undefined : next);
  }

  /** A step is answered when its field holds any value; validity is separate. */
  protected stepAnswered(index: number): boolean {
    const field = this.visibleFormFields()[index];
    return field !== undefined && !isEmptyAnswer(this.formValues()[field.key], field.type);
  }

  /** A step is broken when its own answer breaks a constraint right now. */
  protected stepBroken(index: number): boolean {
    const field = this.visibleFormFields()[index];
    return field !== undefined && this.fieldError(field, this.formValues()) !== undefined;
  }

  /** Free navigation: the reader may move on before answering the step. */
  protected next(): void {
    this.step.update((index) => Math.min(index + 1, this.stepCount() - 1));
  }

  protected back(): void {
    this.step.update((index) => Math.max(index - 1, 0));
  }

  /** Jump by a dot; answers already given are kept — this is a form, not a quiz. */
  protected goToStep(index: number): void {
    if (index >= 0 && index < this.stepCount()) {
      this.step.set(index);
    }
  }

  /** Enter on a step: forward, and through the last one, submit. */
  protected advance(): void {
    if (this.isLastStep()) {
      this.submitForm();
    } else {
      this.next();
    }
  }

  /** A blocked Submit names its field; the note walks the reader to that step. */
  protected jumpToBroken(): void {
    const values = this.formValues();
    const index = this.visibleFormFields().findIndex(
      (field) => this.fieldError(field, values) !== undefined,
    );
    if (index >= 0) {
      this.step.set(index);
    }
  }

  protected isSelected(key: string, option: string): boolean {
    const value = this.fieldValue(key);
    return Array.isArray(value) && value.includes(option);
  }

  protected toggleMulti(key: string, option: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    const current = this.fieldValue(key);
    const selected = Array.isArray(current) ? [...current] : [];
    const next = checked
      ? [...new Set([...selected, option])]
      : selected.filter((entry) => entry !== option);
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
      const error = this.fieldError(field, values);
      if (error !== undefined) {
        return error;
      }
    }
    return undefined;
  }

  /**
   * One field's constraint check, shared by Submit (across all fields) and the
   * stepper (the current step, and the dots that mark the broken ones).
   */
  private fieldError(field: FormField, values: Record<string, FormValue>): string | undefined {
    const value = values[field.key];
    if (field.required === true && isEmptyAnswer(value, field.type)) {
      return `${field.label} is required.`;
    }
    if (value === undefined) {
      return undefined;
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
        // The hand-typed row owns Escape: it collapses the input, not the dialog.
        if (
          event.target instanceof HTMLElement &&
          event.target.classList.contains('custom-input')
        ) {
          return;
        }
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
    if (request.kind === 'form') {
      this.focusFormStep();
      return;
    }
    const target =
      request.kind === 'select'
        ? card.querySelector<HTMLElement>('.option')
        : request.kind === 'input' || request.kind === 'editor'
          ? card.querySelector<HTMLElement>('.field')
          : // A confirmation: the safe choice, like `ConfirmDialog`.
            card.querySelector<HTMLElement>('.actions button.secondary');
    target?.focus();
  }

  /** The current step's first control: the input, or the first radio/checkbox row. */
  private focusFormStep(): void {
    this.host.nativeElement
      .querySelector<HTMLElement>('.card')
      ?.querySelector<HTMLElement>('.form input, .form select, .form textarea')
      ?.focus();
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
