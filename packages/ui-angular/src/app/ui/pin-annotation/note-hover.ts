/**
 * The read-only twin of the annotation editor: a written note, rendered as the
 * markdown it is, floating beside the thing that carries it.
 *
 * The chips show a one-line hint; this is where the whole annotation is legible —
 * lists, emphasis, code and links included — without opening the editor. It is
 * positioned like the editor (see `placement.ts`) because its trigger can be
 * anywhere: a composer chip, a band's ✎, a diff row, a transcript chip.
 */
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Markdown } from '../markdown/markdown';
import { placePopover, type PopoverAnchor, type PopoverSize } from '@morse/ui-runtime';

/** The card's wish before it has been measured. */
const PREFERRED_SIZE: PopoverSize = { width: 360, height: 180 };
const VIEWPORT_FALLBACK: PopoverSize = { width: 1_024, height: 768 };

@Component({
  selector: 'morse-note-hover',
  imports: [Markdown],
  templateUrl: './note-hover.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './note-hover.css',
})
export class NoteHover {
  /** Where the trigger is, in viewport coordinates. */
  readonly anchor = input.required<PopoverAnchor>();
  /** The annotation's markdown. */
  readonly note = input.required<string>();

  private readonly card = viewChild<ElementRef<HTMLElement>>('card');
  private readonly measured = signal<PopoverSize>(PREFERRED_SIZE);

  protected readonly spot = computed(() =>
    placePopover(this.anchor(), this.measured(), {
      width: typeof window === 'undefined' ? VIEWPORT_FALLBACK.width : window.innerWidth,
      height: typeof window === 'undefined' ? VIEWPORT_FALLBACK.height : window.innerHeight,
    }),
  );

  constructor() {
    afterNextRender(() => {
      const element = this.card()?.nativeElement;
      if (element === undefined) {
        return;
      }
      const rect = element.getBoundingClientRect();
      const next = { width: Math.round(rect.width), height: Math.round(rect.height) };
      const current = untracked(() => this.measured());
      if (next.width !== current.width || next.height !== current.height) {
        this.measured.set(next);
      }
    });
  }
}
