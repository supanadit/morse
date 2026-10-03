import {
  afterNextRender,
  DestroyRef,
  Directive,
  ElementRef,
  HostListener,
  inject,
  input,
  RendererFactory2,
} from '@angular/core';

/**
 * How tall a popover anchored above `anchorTop` may be. Pure so the rule can be
 * unit-tested without a layout engine; the directive feeds it the real geometry.
 */
export function popoverMaxHeight(anchorTop: number, preferred: number, minimum = 80): number {
  // 4px is the visual gap above the composer box; the rest keeps breathing room
  // from the panel's top edge so the popover never kisses the frame.
  const available = Math.floor(anchorTop - 4 - 8);
  return Math.max(minimum, Math.min(preferred, available));
}

/**
 * Keeps a popover that opens *above* its anchor inside the viewport.
 *
 * The composer's pickers (model, command, file) are absolutely positioned above
 * the composer box, but their own `max-height` is a fixed wish — drag the
 * terminal up and the panel is taller than the room it has, so its top (the
 * search field) is clipped away. The anchor is the popover's `offsetParent` (the
 * composer box), which is laid out independently of the popover, so measuring it
 * is safe at any moment.
 *
 * The available height is published as a `--morse-popover-max-height` custom
 * property on the host; the popover's own stylesheet decides what to do with it
 * (normally `max-height: var(--morse-popover-max-height, <preferred>)`), so this
 * directive stays styling-agnostic. Without JS (a frozen frame, a test) the
 * fallback still applies.
 */
@Directive({ selector: '[morsePopoverFit]' })
export class PopoverFit {
  /** Height to use when the viewport has room to spare. */
  readonly preferred = input(320, { alias: 'morsePopoverFit' });

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly renderer = inject(RendererFactory2).createRenderer(null, null);
  private observer: ResizeObserver | undefined;

  constructor() {
    afterNextRender(() => {
      this.fit();
      // The composer grows when the textarea wraps, which moves the anchor's top
      // (and the room above it) without a window resize.
      const anchor = this.anchor();
      if (anchor && typeof ResizeObserver !== 'undefined') {
        this.observer = new ResizeObserver(() => this.fit());
        this.observer.observe(anchor);
      }
    });

    inject(DestroyRef).onDestroy(() => this.observer?.disconnect());
  }

  @HostListener('window:resize')
  protected onWindowResize(): void {
    this.fit();
  }

  private anchor(): HTMLElement | null {
    const element = this.host.nativeElement;
    return (element.offsetParent as HTMLElement | null) ?? element.parentElement;
  }

  private fit(): void {
    const top = this.anchor()?.getBoundingClientRect().top ?? 0;
    const height = popoverMaxHeight(top, this.preferred());
    this.renderer.setStyle(this.host.nativeElement, '--morse-popover-max-height', `${height}px`);
  }
}
