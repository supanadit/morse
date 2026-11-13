/**
 * The pair of buttons a pinned range carries wherever it is shown: `✎ note`
 * opens the annotation editor, `Cancel` unpins the range.
 *
 * It was the file preview's band corner first; a diff row and the editor's own
 * band mount the same component now, so the annotation reads and behaves the same
 * in all three places instead of each growing its own glyph. On a range the chip
 * carries the note's opening words, so an annotation is legible without a card
 * column beside the code.
 */
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NoteHoverDirective } from './note-hover.directive';

@Component({
  selector: 'morse-pin-actions',
  templateUrl: './pin-actions.html',
  styleUrl: './pin-actions.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NoteHoverDirective],
})
export class PinActions {
  /** The pin's markdown; empty when nothing is written yet. */
  readonly note = input<string | undefined>(undefined);
  /** What the annotation is on, for the accessible names ("this change of main.ts"). */
  readonly target = input('');

  /** The button the annotation editor should anchor to. */
  readonly edit = output<HTMLElement>();
  /** The range was unpinned. */
  readonly cancel = output<void>();

  protected readonly hasNote = computed(() => (this.note() ?? '').trim().length > 0);

  /**
   * What the chip says: `Notes` until something is written, then the note's own
   * opening words. That is what keeps an annotation legible on its range now that
   * no card column repeats it beside the code — the full markdown is still one hover
   * (or one click) away, and the chip ellipses whatever does not fit.
   */
  protected readonly label = computed(() => {
    const note = this.note() ?? '';
    const firstLine = note.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
    if (firstLine === undefined) {
      return 'Notes';
    }
    // The chip is a label, not a renderer: markers would read as noise in 160px.
    const plain = firstLine
      .replace(/^#+\s*/, '')
      .replace(/^[-*>]\s*/, '')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return plain.length === 0 ? 'Notes' : plain;
  });

  protected onEdit(event: MouseEvent): void {
    // The row underneath pins and unpins on a click; a press on the pair is
    // only ever about the annotation.
    event.stopPropagation();
    const button = event.currentTarget;
    if (button instanceof HTMLElement) {
      this.edit.emit(button);
    }
  }

  protected onCancel(event: MouseEvent): void {
    event.stopPropagation();
    this.cancel.emit();
  }
}
