/**
 * `[morseNoteHover]="pin.note"` on anything that carries an annotation: hovering
 * it (after a short intent delay) shows the note as rendered markdown, and then
 * the pointer leaving, a scroll anywhere, or a press on the trigger takes it
 * away again.
 *
 * It creates the card itself, so a host does not need a hover signal of its own —
 * the composer chip, the band's ✎, a diff row and a transcript chip all just put
 * one attribute on the element that shows the hint.
 */
import {
  ComponentRef,
  Directive,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewContainerRef,
  inject,
  input,
} from '@angular/core';
import { NoteHover } from './note-hover';
import type { PopoverAnchor } from '@morse/ui-runtime';

/** How long the pointer must rest before the card appears. */
export const NOTE_HOVER_DELAY_MS = 320;

@Directive({ selector: '[morseNoteHover]' })
export class NoteHoverDirective implements OnDestroy {
  /** The annotation's markdown; an empty value means there is nothing to show. */
  readonly note = input<string>('', { alias: 'morseNoteHover' });

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly container = inject(ViewContainerRef);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private card: ComponentRef<NoteHover> | undefined;
  /** Hides a card that is on screen when anything around it moves. */
  private readonly onScroll = (): void => this.hide();

  @HostListener('pointerenter')
  protected onEnter(): void {
    if (this.note().trim().length === 0 || this.card !== undefined || this.timer !== undefined) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.show();
    }, NOTE_HOVER_DELAY_MS);
  }

  @HostListener('pointerleave')
  protected onLeave(): void {
    this.hide();
  }

  /** Pressing the trigger acts on the pin, so the card steps aside. */
  @HostListener('pointerdown')
  protected onPress(): void {
    this.hide();
  }

  ngOnDestroy(): void {
    this.hide();
  }

  private show(): void {
    if (this.note().trim().length === 0) {
      return;
    }
    const card = this.container.createComponent(NoteHover);
    card.setInput('anchor', this.anchor());
    card.setInput('note', this.note());
    this.card = card;
    // A fixed card would drift away from its trigger inside a scrolling pane, so
    // any scroll at all (capture, because scroll does not bubble) dismisses it.
    window.addEventListener('scroll', this.onScroll, true);
  }

  private hide(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.card === undefined) {
      return;
    }
    window.removeEventListener('scroll', this.onScroll, true);
    this.card.destroy();
    this.card = undefined;
  }

  /** The trigger's spot on screen, as the card's placement wants it. */
  private anchor(): PopoverAnchor {
    const rect = this.host.nativeElement.getBoundingClientRect();
    return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
  }
}
