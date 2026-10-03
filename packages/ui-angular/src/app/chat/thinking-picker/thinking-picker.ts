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
import { ShortcutService } from '../../core/shortcuts';
import { EnterDirective } from '../../shared/enter.directive';
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
  styles: [
    `
      :host {
        position: relative;
        display: inline-block;
      }
      .trigger {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border: 1px solid var(--morse-input-border);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-input-bg);
        color: var(--morse-input-fg);
        font-size: 12px;
        cursor: pointer;
      }
      .trigger:hover {
        border-color: var(--morse-fg-muted);
      }
      .trigger[aria-expanded='true'] {
        border-color: var(--morse-focus);
      }
      .trigger .level {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-transform: capitalize;
      }
      .trigger .caret {
        flex: none;
        color: var(--morse-fg-muted);
        font-size: 10px;
      }
      .panel {
        position: absolute;
        left: 0;
        bottom: calc(100% + 6px);
        z-index: 30;
        display: flex;
        flex-direction: column;
        min-width: 180px;
        padding: 4px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-md);
        background: var(--morse-panel, var(--morse-bg));
        box-shadow: 0 10px 28px rgb(0 0 0 / 30%);
      }
      .panel:focus-visible {
        outline: none;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 5px 8px;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg);
        font: inherit;
        font-size: 12px;
        text-align: left;
        cursor: pointer;
      }
      .row.active {
        background: var(--morse-hover);
      }
      .row .name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-transform: capitalize;
      }
      .row.selected .name {
        color: var(--morse-accent);
      }
      .row .check {
        flex: none;
        color: var(--morse-accent);
        font-size: 12px;
      }
    `,
  ],
})
export class ThinkingPicker {
  readonly levels = input.required<ThinkingLevel[]>();
  readonly current = input.required<ThinkingLevel>();
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
        const chosen = levels[this.active()];
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
