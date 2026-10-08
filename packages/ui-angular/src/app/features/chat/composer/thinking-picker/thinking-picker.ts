import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  HostListener,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { ThinkingLevel } from '@morse/protocol';
import { ShortcutService } from '../../../../services/shortcut.service';
import { EnterDirective } from '../../../../ui/enter.directive';
import { ThinkingBrain } from './thinking-brain';

/**
 * Replaces the native `<select>` for the thinking level.
 *
 * A `<select>` popup is drawn by the OS, so it ignored the Morse/VS Code theme —
 * a bright blue highlight on a dark panel in the browser. This is a themed
 * popover: a clickable animated `Brain` for the current level, and one animated
 * brain per level inside, so the strength of the reasoning mode is something the
 * user can *see* before choosing it.
 *
 * Self-contained: it owns its open state, keyboard and outside-click dismissal,
 * so the composer only binds `levels`, `current` and `pick`.
 */
@Component({
  selector: 'morse-thinking-picker',
  imports: [EnterDirective, ThinkingBrain],
  templateUrl: './thinking-picker.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './thinking-picker.css',
})
export class ThinkingPicker {
  readonly levels = input.required<ThinkingLevel[]>();
  readonly current = input.required<ThinkingLevel>();
  /**
   * True while the host re-reads the levels of a model the reader just picked.
   * pi scopes them to the current model, so the list on screen is the previous
   * model's until the answer lands — a pick would apply a level this model may
   * not have. The rows stay (the panel must not jump under the pointer) and say
   * they are being re-read.
   */
  readonly loading = input(false);
  readonly pick = output<ThinkingLevel>();

  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly shortcuts = inject(ShortcutService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  protected readonly open = signal(false);
  protected readonly active = signal(0);
  protected readonly bumped = signal(false);

  constructor() {
    // The panel is this component's own state, so the shortcut is bound here and
    // not at the app level. No levels to choose from means the row is dead.
    const unbind = this.shortcuts.bind('thinking.pick', () => this.toggle(), () => this.levels().length > 0);
    this.destroyRef.onDestroy(unbind);

    effect(() => {
      if (!this.open()) {
        return;
      }
      // The panel is rendered by `@if`; focus it once the DOM settles so the
      // arrow keys drive the list instead of the prompt.
      setTimeout(() => this.panel()?.nativeElement.focus(), 0);
    });

    // The levels can change while the panel is open (the model changed under it),
    // so keep the highlight inside the list instead of pointing past its end.
    effect(() => {
      const last = Math.max(0, this.levels().length - 1);
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
    this.bump();
    const index = this.levels().indexOf(this.current());
    this.active.set(index >= 0 ? index : 0);
    this.open.set(true);
  }

  protected choose(level: ThinkingLevel): void {
    if (this.loading()) {
      return;
    }
    this.pick.emit(level);
    this.close();
  }

  protected onKeydown(event: KeyboardEvent): void {
    const levels = this.levels();
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        this.close();
        return;
      case 'ArrowDown':
        event.preventDefault();
        this.active.update((index) => Math.min(index + 1, Math.max(0, levels.length - 1)));
        return;
      case 'ArrowUp':
        event.preventDefault();
        this.active.update((index) => Math.max(0, index - 1));
        return;
      case 'Enter': {
        const chosen = this.loading() ? undefined : levels[this.active()];
        if (chosen) {
          event.preventDefault();
          this.choose(chosen);
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

  private close(): void {
    this.open.set(false);
    this.bumped.set(false);
  }

  /** Remove then re-add the class so a second click replays the kick. */
  private bump(): void {
    this.bumped.set(false);
    setTimeout(() => this.bumped.set(true), 0);
    setTimeout(() => this.bumped.set(false), 520);
  }
}
