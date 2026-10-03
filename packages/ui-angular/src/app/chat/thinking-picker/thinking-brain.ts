import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  viewChild,
  viewChildren,
} from '@angular/core';
import type { ThinkingLevel } from '@morse/protocol';
import { AnimationService } from '../../core/animation.service';

/**
 * Lucide's `brain` glyph, as stroke paths, so it stays crisp at 16px and inherits
 * `currentColor` (the level's colour) instead of shipping a raster asset.
 */
const BRAIN_PATHS = [
  'M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z',
  'M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z',
  'M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4',
  'M17.599 6.5a3 3 0 0 0 .399-1.375',
  'M6.003 5.125A3 3 0 0 0 6.401 6.5',
  'M3.477 10.896a4 4 0 0 1 .585-.396',
  'M19.938 10.5a4 4 0 0 1 .585.396',
  'M6 18a4 4 0 0 1-1.967-.516',
  'M19.967 17.484A4 4 0 0 1 18 18',
];

/** How much effort a level implies; drives which halo rings render. */
const LEVEL_INTENSITY: Record<ThinkingLevel, number> = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

/** Rings drawn for the louder levels (medium = 3, high = 4, ...). */
export function brainIntensity(level: ThinkingLevel | string): number {
  return LEVEL_INTENSITY[level as ThinkingLevel] ?? 2;
}

interface LevelMotion {
  /** anime.js `[from, to]` pairs; the first value is what a stop restores. */
  params: Record<string, [string | number, string | number]>;
  duration: number;
  delay?: number;
  ease?: string;
  /** A halo that keeps expanding while the level plays. */
  halo?: { duration: number; delay?: number };
}

/**
 * Each level is a *different motion*, not just a different speed: `off` breathes
 * deep and slow, `minimal` breathes, `low` sways, `medium` pulses with one halo,
 * `high` speeds up with two, and `xhigh`/`max` add a spin. Everything is driven
 * by anime.js (through `AnimationService`) so it matches the rest of the app and
 * survives a hidden document, rather than relying on CSS keyframes.
 */
function levelMotion(level: ThinkingLevel): LevelMotion {
  switch (level) {
    case 'off':
      return { params: { opacity: [0.35, 0.6] }, duration: 5200, ease: 'inOut(1)' };
    case 'minimal':
      return { params: { opacity: [0.6, 1] }, duration: 2200 };
    case 'low':
      return { params: { rotate: ['-7deg', '7deg'] }, duration: 1500 };
    case 'medium':
      return {
        params: { scale: [1, 1.14] },
        duration: 950,
        halo: { duration: 1300 },
      };
    case 'high':
      return {
        params: { scale: [1, 1.18] },
        duration: 560,
        halo: { duration: 800 },
      };
    case 'xhigh':
      return {
        params: { scale: [1, 1.16], rotate: ['-8deg', '8deg'] },
        duration: 440,
        halo: { duration: 620 },
      };
    case 'max':
      return {
        params: { scale: [1, 1.22], rotate: ['-12deg', '12deg'] },
        duration: 320,
        ease: 'linear',
        halo: { duration: 480 },
      };
  }
}

/**
 * The `Brain` mark for a thinking level.
 *
 * The colour comes from CSS (`data-level`), the motion from anime.js. `bumped`
 * plays a one-shot kick so a click reads as "thinking", applied to the host so it
 * never fights the brain's own running loop.
 */
@Component({
  selector: 'morse-brain',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[attr.data-level]': 'level()',
    '[class.bumped]': 'bumped()',
  },
  template: `
    <svg
      #brain
      class="brain"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      @for (path of paths; track path) {
        <path [attr.d]="path" />
      }
    </svg>
    @if (intensity() >= 3) {
      <span #halo class="wave wave-a" aria-hidden="true"></span>
    }
    @if (intensity() >= 4) {
      <span #halo class="wave wave-b" aria-hidden="true"></span>
    }
  `,
  styles: [
    `
      :host {
        position: relative;
        display: inline-flex;
        width: 16px;
        height: 16px;
        color: var(--morse-accent);
      }
      .brain {
        width: 100%;
        height: 100%;
        transform-box: fill-box;
        transform-origin: center;
      }
      .wave {
        position: absolute;
        inset: -1px;
        border-radius: 50%;
        border: 1px solid currentColor;
        opacity: 0;
        pointer-events: none;
      }

      /* One colour per level: the louder the mode, the warmer the mark. */
      :host([data-level='off']) {
        color: var(--morse-fg-muted);
      }
      :host([data-level='minimal']) {
        color: var(--morse-info);
      }
      :host([data-level='low']) {
        color: var(--morse-success);
      }
      :host([data-level='medium']) {
        color: var(--morse-warn);
      }
      :host([data-level='high']) {
        color: var(--morse-error);
      }
      :host([data-level='xhigh']) {
        /* Red on its way to purple, so it stays distinct from high. */
        color: var(--morse-error);
        color: color-mix(in srgb, var(--morse-error) 55%, var(--morse-typename));
      }
      :host([data-level='max']) {
        color: var(--morse-typename);
      }
    `,
  ],
})
export class ThinkingBrain {
  readonly level = input.required<ThinkingLevel>();
  /** One-shot click kick, owned by the picker. */
  readonly bumped = input(false);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly animation = inject(AnimationService);
  private readonly brain = viewChild<ElementRef<SVGElement>>('brain');
  private readonly halos = viewChildren<ElementRef<HTMLElement>>('halo');
  private stoppers: Array<() => void> = [];

  protected readonly paths = BRAIN_PATHS;
  protected readonly intensity = computed(() => brainIntensity(this.level()));

  constructor() {
    effect(() => {
      const level = this.level();
      const brain = this.brain()?.nativeElement;
      const halos = this.halos().map((ref) => ref.nativeElement);

      this.stopLoops();
      if (!brain || !this.animation.isEnabled) {
        return;
      }

      const motion = levelMotion(level);
      this.stoppers.push(
        this.animation.loop(brain, motion.params, {
          duration: motion.duration,
          delay: motion.delay ?? 0,
          ease: motion.ease ?? 'inOut(2)',
        }),
      );
      if (motion.halo) {
        halos.forEach((halo, index) => {
          this.stoppers.push(
            this.animation.loop(
              halo,
              { scale: [0.72, 1.9], opacity: [0.55, 0] },
              {
                duration: motion.halo!.duration,
                delay: (motion.halo!.delay ?? 0) + index * motion.halo!.duration * 0.5,
                ease: 'out(2)',
                alternate: false,
              },
            ),
          );
        });
      }
    });

    effect(() => {
      if (this.bumped()) {
        this.animation.pop(this.host.nativeElement, { scale: 1.3, duration: 420 });
      }
    });

    inject(DestroyRef).onDestroy(() => this.stopLoops());
  }

  private stopLoops(): void {
    for (const stop of this.stoppers) {
      stop();
    }
    this.stoppers = [];
  }
}
