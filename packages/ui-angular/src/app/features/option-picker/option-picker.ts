import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { EnterDirective } from '../../ui/enter.directive';

/** One row a picker offers: a stable id plus the text a reader sees. */
export interface PickerOption {
  id: string;
  label: string;
  description?: string;
  /** A short qualifier such as `default`, shown beside the label. */
  badge?: string;
}

/**
 * A small themed choice popover, used for the agent engine and the named mode.
 *
 * The native `<select>` popup is drawn by the OS and ignores the Morse/VS Code
 * theme, and the model and thinking pickers already replace it. This is the
 * generic version for lists that only need a label (and optionally a
 * description): same keyboard and outside-click behaviour, no per-list copy.
 */
@Component({
  selector: 'morse-option-picker',
  imports: [EnterDirective],
  templateUrl: './option-picker.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './option-picker.css',
})
export class OptionPicker {
  readonly options = input.required<readonly PickerOption[]>();
  /** The id of the selected option; empty means none is selected. */
  readonly current = input('');
  readonly label = input.required<string>();
  /** True while the list is being re-read; rows are not pickable meanwhile. */
  readonly loading = input(false);
  readonly pick = output<string>();
  /** The panel opened, so the owner can refresh the list that feeds it. */
  readonly opened = output<void>();

  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  protected readonly open = signal(false);
  protected readonly active = signal(0);

  protected readonly currentLabel = computed(() => {
    const selected = this.options().find((option) => option.id === this.current());
    return selected?.label ?? this.current() ?? '';
  });

  constructor() {
    // The panel is rendered by `@if`; focus it once the DOM settles so the
    // arrow keys drive the list instead of the prompt.
    effect(() => {
      if (!this.open()) {
        return;
      }
      setTimeout(() => this.panel()?.nativeElement.focus(), 0);
    });

    // The list can change while the panel is open (the host re-read it), so keep
    // the highlight inside it instead of pointing past its end.
    effect(() => {
      const last = Math.max(0, this.options().length - 1);
      if (this.active() > last) {
        this.active.set(last);
      }
    });
  }

  protected toggle(): void {
    if (this.open()) {
      this.close();
      return;
    }
    const index = this.options().findIndex((option) => option.id === this.current());
    this.active.set(index >= 0 ? index : 0);
    this.opened.emit();
    this.open.set(true);
  }

  protected choose(id: string): void {
    if (this.loading()) {
      return;
    }
    this.pick.emit(id);
    this.close();
  }

  protected onKeydown(event: KeyboardEvent): void {
    const options = this.options();
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        this.close();
        return;
      case 'ArrowDown':
        event.preventDefault();
        this.active.update((index) => Math.min(index + 1, Math.max(0, options.length - 1)));
        return;
      case 'ArrowUp':
        event.preventDefault();
        this.active.update((index) => Math.max(0, index - 1));
        return;
      case 'Enter': {
        const option = this.loading() ? undefined : options[this.active()];
        if (option !== undefined) {
          event.preventDefault();
          this.choose(option.id);
        }
        return;
      }
      default:
        return;
    }
  }

  /** Click anywhere outside the picker closes it, like every other popover. */
  @HostListener('document:pointerdown', ['$event'])
  protected onDocumentPointerdown(event: PointerEvent): void {
    const target = event.target as Node | null;
    if (this.open() && target && !this.host.nativeElement.contains(target)) {
      this.close();
    }
  }

  /** Public so a sibling popover can dismiss this one when it opens over it. */
  close(): void {
    this.open.set(false);
  }
}
