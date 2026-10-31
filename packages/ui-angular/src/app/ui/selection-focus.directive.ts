import { Directive, ElementRef, HostListener, inject } from '@angular/core';
import { hasVsCodeApi } from '@morse/ui-runtime';

/**
 * Controls that own their own focus — and, when editable, their own selection.
 * A press inside one keeps it, exactly as it would without this directive.
 */
const FOCUS_OWNERS = [
  'input',
  'textarea',
  'select',
  'button',
  'a[href]',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="textbox"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Gives the surface a non-editable focus target for pointer presses, so a
 * selection stays selected when the webview copies it.
 *
 * VS Code 1.143 restores focus to the webview's last focused element before it
 * runs the clipboard command. When that element is the composer (a textarea),
 * focusing it collapses a selection made in the transcript, so Ctrl+C and the
 * context-menu Copy both put nothing on the clipboard — the highlight stays
 * visible while the clipboard goes unchanged. Landing the press on this surface
 * instead leaves a non-editable `activeElement`, the restore is skipped, and the
 * selection survives. VS Code 1.144 fixed the webview itself; this keeps 1.143
 * working without asking the reader to update.
 *
 * The press is never prevented, so selecting text still starts where it did.
 * Only VS Code needs the guard; a browser already keeps a document selection.
 */
@Directive({
  selector: '[morseSelectionFocus]',
  host: { '[attr.tabindex]': 'focusTarget ? -1 : null' },
})
export class SelectionFocusDirective {
  protected readonly focusTarget = hasVsCodeApi();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  @HostListener('pointerdown', ['$event'])
  protected onPointerDown(event: PointerEvent): void {
    if (!this.focusTarget || event.defaultPrevented) {
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest(FOCUS_OWNERS)) {
      return;
    }
    this.host.nativeElement.focus({ preventScroll: true });
  }
}
