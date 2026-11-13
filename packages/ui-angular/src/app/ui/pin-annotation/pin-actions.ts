/**
 * The pair of buttons a pinned range carries wherever it is shown: `✎ note`
 * opens the annotation editor, `Cancel` unpins the range.
 *
 * It was the file preview's band corner first; a diff row and the editor's note
 * card mount the same component now, so the annotation reads and behaves the
 * same in all three places instead of each growing its own glyph.
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
