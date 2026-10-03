import { AfterViewInit, Directive, ElementRef, inject, input } from '@angular/core';
import { AnimationService } from '../core/animation.service';

/**
 * Entrance animation for anything that appears dynamically (transcript rows,
 * navigation groups, toasts, interaction panels).
 *
 *   <div [morseEnter]="index">…</div>
 *
 * The optional index adds a small stagger so a list reads as one motion.
 * Honours `prefers-reduced-motion` via the animation service.
 */
@Directive({ selector: '[morseEnter]' })
export class EnterDirective implements AfterViewInit {
  /** Stagger position; each step delays the animation slightly. */
  readonly morseEnter = input<number>(0);
  readonly morseEnterY = input<number>(8);
  readonly morseEnterDuration = input<number>(260);
  /** Start scale, for elements that pop in (a chip landing from a drop). */
  readonly morseEnterScale = input<number | undefined>(undefined);

  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly animation = inject(AnimationService);

  ngAfterViewInit(): void {
    const step = Math.max(0, this.morseEnter());
    this.animation.enter(this.element.nativeElement, {
      y: this.morseEnterY(),
      duration: this.morseEnterDuration(),
      scale: this.morseEnterScale(),
      delay: Math.min(step, 8) * 24,
    });
  }
}
