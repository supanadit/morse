import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { animate, createDrawable, createTimeline, stagger, utils, type Timeline } from 'animejs';
import { AnimationService } from '../core/animation.service';
import { BootHandoff } from '../core/boot-handoff';

const INTRO_MS = 1_800;
const OUTRO_MS = 520;
/** Never flash the cold-start screen: the intro gets to finish at least once. */
const MIN_HOLD_MS = INTRO_MS;

/**
 * Cold-start screen.
 *
 * While the host handshake is pending, the app would otherwise sit on an empty
 * transcript. Instead the Morse mark assembles itself: two rings draw in on
 * opposite rotations, a sonar spark sweeps the orbit, the `.-` glyph pops in on a
 * spring, a shockwave rings out, and the wordmark lifts letter by letter.
 *
 * On the way out it does not fade: the mark flies to the empty-state hero (see
 * `BootHandoff`) and the opaque veil lifts behind it, so the logo *arrives* in a
 * blank session instead of being swapped for a paragraph. With a conversation
 * already on screen there is no hero, and the overlay falls back to a fade.
 *
 * The whole thing is decorative, so it fails open twice over:
 *
 * - every animated element ends at a *published* final state, and a settle timer
 *   snaps to it if the engine never ticks (headless screenshots, a hidden
 *   panel), so the screen can never stay blank forever;
 * - `dismissed` is emitted from a timer as well as `onComplete`, so a stalled
 *   timeline can never trap the app behind the overlay.
 *
 * `prefers-reduced-motion` is handled one level up: the host does not mount this
 * component at all when motion is off.
 */
@Component({
  selector: 'morse-boot-splash',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="boot" [class.leaving]="leaving()">
      <span class="veil" aria-hidden="true"></span>
      <span class="aura" aria-hidden="true"></span>
      <span class="grid" aria-hidden="true"></span>

      <div class="center">
        <div class="stage">
          <span class="halo" aria-hidden="true"></span>
          <span class="wave wave-a" aria-hidden="true"></span>
          <span class="wave wave-b" aria-hidden="true"></span>

          <svg class="rings" viewBox="0 0 140 140" aria-hidden="true">
            <g class="spin spin-a">
              <circle class="ring ring-a" cx="70" cy="70" r="58" />
            </g>
            <g class="spin spin-b">
              <circle class="ring ring-b" cx="70" cy="70" r="45" />
            </g>
            <g class="orbit">
              <circle class="spark" cx="70" cy="12" r="3" />
            </g>
          </svg>

          <span class="mark" aria-hidden="true">
            <span class="dot dot-a"></span>
            <span class="dot dot-b"></span>
            <span class="dash"></span>
          </span>
        </div>

        <div class="words">
          <div class="wordmark" aria-label="Morse">
            @for (letter of letters; track $index) {
              <span class="letter" aria-hidden="true">{{ letter }}</span>
            }
          </div>
          <div class="tagline">the pi coding agent</div>
        </div>
      </div>

      <div class="foot">
        <span class="pulse" aria-hidden="true"></span>
        <span class="status" role="status" aria-live="polite">{{ status() }}</span>
        <span class="ellipsis" aria-hidden="true"><i></i><i></i><i></i></span>
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: contents;
      }

      .boot {
        position: fixed;
        inset: 0;
        z-index: 100;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 26px;
        overflow: hidden;
        color: var(--morse-fg);
        opacity: 1;
      }
      .boot.leaving {
        pointer-events: none;
      }

      /*
       * The opaque room, kept separate from the mark so the background can be
       * lifted while the logo is still flying towards the empty-state hero.
       */
      .veil {
        position: absolute;
        inset: 0;
        background: var(--morse-bg);
      }

      /* Ambient accent bloom behind everything. */
      .aura {
        position: absolute;
        width: min(560px, 90vh);
        aspect-ratio: 1;
        border-radius: 50%;
        background: radial-gradient(
          circle,
          color-mix(in srgb, var(--morse-accent) 42%, transparent) 0%,
          transparent 62%
        );
        filter: blur(8px);
        opacity: 0;
        pointer-events: none;
      }

      /* A faint dot lattice, faded out towards the edges. */
      .grid {
        position: absolute;
        inset: 0;
        background-image: radial-gradient(
          color-mix(in srgb, var(--morse-fg) 14%, transparent) 1px,
          transparent 1px
        );
        background-size: 22px 22px;
        -webkit-mask-image: radial-gradient(circle at center, #000 0%, transparent 66%);
        mask-image: radial-gradient(circle at center, #000 0%, transparent 66%);
        opacity: 0;
        pointer-events: none;
      }

      .center {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 22px;
      }

      .stage {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 140px;
        height: 140px;
      }

      .rings {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        overflow: visible;
      }
      .ring {
        fill: none;
        stroke: var(--morse-fg-muted);
        stroke-width: 1.4;
        stroke-linecap: round;
      }
      .ring-b {
        stroke: color-mix(in srgb, var(--morse-accent) 70%, var(--morse-fg-muted));
        stroke-width: 1.1;
      }
      .spin,
      .orbit {
        transform-box: fill-box;
        transform-origin: center;
        will-change: transform;
      }
      .spark {
        fill: var(--morse-fg);
        opacity: 0;
        filter: drop-shadow(0 0 6px color-mix(in srgb, var(--morse-accent) 80%, transparent));
      }

      .halo {
        position: absolute;
        width: 124px;
        height: 124px;
        border-radius: 50%;
        background: radial-gradient(
          circle,
          color-mix(in srgb, var(--morse-fg) 30%, transparent) 0%,
          transparent 68%
        );
        opacity: 0;
        pointer-events: none;
      }

      .wave {
        position: absolute;
        width: 124px;
        height: 124px;
        border-radius: 50%;
        border: 1px solid color-mix(in srgb, var(--morse-fg) 65%, transparent);
        opacity: 0;
        pointer-events: none;
      }
      .wave-b {
        border-color: color-mix(in srgb, var(--morse-accent) 70%, transparent);
      }

      /* The Morse glyph: dot, dot, dash. */
      .mark {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 9px;
      }
      .dot {
        width: 13px;
        height: 13px;
        border-radius: 50%;
        background: var(--morse-fg);
        opacity: 0;
        box-shadow: 0 0 14px color-mix(in srgb, var(--morse-fg) 55%, transparent);
      }
      .dash {
        width: 38px;
        height: 13px;
        border-radius: 999px;
        background: var(--morse-fg);
        opacity: 0;
        transform-origin: left center;
        box-shadow: 0 0 14px color-mix(in srgb, var(--morse-fg) 55%, transparent);
      }

      .words {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 7px;
      }
      .wordmark {
        display: flex;
        font-size: 30px;
        font-weight: 650;
        line-height: 1;
        letter-spacing: 0.01em;
      }
      .letter {
        display: inline-block;
        opacity: 0;
        will-change: transform, opacity;
      }
      .tagline {
        font-size: 10.5px;
        letter-spacing: 0.34em;
        text-transform: uppercase;
        color: var(--morse-fg-muted);
        opacity: 0;
      }

      .foot {
        position: relative;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 11.5px;
        color: var(--morse-fg-muted);
        opacity: 0;
      }
      .pulse {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--morse-accent);
        box-shadow: 0 0 8px color-mix(in srgb, var(--morse-accent) 70%, transparent);
        opacity: 0;
      }
      .ellipsis {
        display: inline-flex;
        gap: 3px;
      }
      .ellipsis i {
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: currentColor;
        opacity: 0.15;
      }
    `,
  ],
})
export class BootSplash implements AfterViewInit, OnDestroy {
  /** One line under the mark; the host keeps it in sync with the handshake. */
  readonly status = input('Connecting to the host…');

  /** Flips when the app behind the overlay can take over. */
  readonly ready = input(false);

  /** Fires once the exit animation is done, so the host can drop the overlay. */
  readonly dismissed = output<void>();

  /** The wordmark letters, split so each one can rise on its own. */
  protected readonly letters = ['M', 'o', 'r', 's', 'e'];

  /** True while the overlay is playing its exit animation. */
  protected readonly leaving = signal(false);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly animation = inject(AnimationService);
  private readonly handoff = inject(BootHandoff);

  private intro: Timeline | undefined;
  private loops: Array<{ pause: () => void }> = [];
  private introSettle: ReturnType<typeof setTimeout> | undefined;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private outroSettle: ReturnType<typeof setTimeout> | undefined;
  private startedAt = 0;
  private left = false;
  private viewReady = false;
  private dismissedOnce = false;

  constructor() {
    // `ready` can flip before or after the view exists; both paths land in leave().
    effect(() => {
      if (this.ready()) {
        this.leave();
      }
    });
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    this.startedAt = Date.now();
    this.play();
    if (this.ready()) {
      this.leave();
    }
  }

  ngOnDestroy(): void {
    this.clearTimers();
    this.stopLoops();
    this.intro?.pause();
  }

  // ---------------------------------------------------------------------------
  // Motion
  // ---------------------------------------------------------------------------

  private play(): void {
    const root = this.query('.boot');
    if (!root) {
      return;
    }

    if (!this.animation.isEnabled) {
      // Nothing to animate; hand the app over immediately.
      this.dismiss();
      return;
    }

    const ringA = this.query<SVGGeometryElement>('.ring-a');
    const ringB = this.query<SVGGeometryElement>('.ring-b');
    const halo = this.query('.halo');
    const aura = this.query('.aura');
    const grid = this.query('.grid');
    const spark = this.query('.spark');
    const dotA = this.query('.dot-a');
    const dotB = this.query('.dot-b');
    const dash = this.query('.dash');
    const letters = this.queryAll('.letter');
    const tagline = this.query('.tagline');
    const foot = this.query('.foot');
    const pulse = this.query('.pulse');

    try {
      // The rings are drawn by animating `draw: 'start end'` on a drawable proxy.
      const drawables = [ringA, ringB]
        .filter((element): element is SVGGeometryElement => element !== null)
        .map((element) => createDrawable(element)[0]);
      // Drawable proxies report the full path on creation; start them closed.
      for (const ring of drawables) {
        ring.setAttribute('draw', '0 0');
      }

      this.intro = createTimeline();

      this.intro
        .add(
          this.one(halo),
          { opacity: [0, 0.72], scale: [0.45, 1], duration: 900, ease: 'out(4)' },
          0,
        )
        .add(
          this.one(aura),
          { opacity: [0, 0.85], scale: [0.7, 1], duration: 1_100, ease: 'out(4)' },
          0,
        )
        .add(this.one(grid), { opacity: [0, 0.5], duration: 900, ease: 'out(3)' }, 90)
        .add(
          drawables,
          { draw: ['0 0', '0 1'], duration: 720, ease: 'inOut(3)', delay: stagger(110) },
          120,
        )
        .add(this.one(spark), { opacity: [0, 1], duration: 420, ease: 'out(2)' }, 260)
        // The inner ring collapses into the glyph, so the mark reads as a morph
        // rather than a swap.
        .add(
          this.one(ringB),
          { r: [45, 8], opacity: [1, 0.2], duration: 460, ease: 'in(2)' },
          720,
        )
        .add(
          this.one(dotA),
          {
            opacity: [0, 1],
            scale: [0, 1],
            translateY: [10, 0],
            duration: 700,
            ease: 'outElastic(1, .55)',
          },
          820,
        )
        .add(
          this.one(dotB),
          {
            opacity: [0, 1],
            scale: [0, 1],
            translateY: [10, 0],
            duration: 700,
            ease: 'outElastic(1, .55)',
          },
          890,
        )
        .add(
          this.one(dash),
          { opacity: [0, 1], scaleX: [0, 1], duration: 700, ease: 'outElastic(1, .55)' },
          960,
        )
        // A bloom on the moment the glyph completes.
        .add(
          this.one(halo),
          { opacity: [0.72, 1, 0.6], scale: [1, 1.14, 1], duration: 620, ease: 'inOut(2)' },
          1_060,
        )
        .add(
          letters,
          {
            opacity: [0, 1],
            translateY: [16, 0],
            scale: [0.85, 1],
            duration: 500,
            ease: 'out(3)',
            delay: stagger(40),
          },
          1_100,
        )
        .add(
          this.one(tagline),
          { opacity: [0, 1], translateY: [8, 0], duration: 420, ease: 'out(3)' },
          1_480,
        )
        .add(
          this.one(foot),
          { opacity: [0, 1], translateY: [10, 0], duration: 420, ease: 'out(3)' },
          1_580,
        )
        .add(
          this.one(pulse),
          { opacity: [0, 1], scale: [0.6, 1], duration: 420, ease: 'out(2)' },
          1_580,
        );

      this.introSettle = setTimeout(() => this.snap(), INTRO_MS + 300);
    } catch {
      // Decorative motion must never trap or blank the app: if the engine cannot
      // even start, the overlay gets out of the way.
      this.dismiss();
      return;
    }

    this.startAmbient();
  }

  /** The state the intro publishes, applied whenever the engine cannot deliver it. */
  private snap(): void {
    for (const ring of this.queryAll('.ring')) {
      ring.setAttribute('draw', '0 1');
    }
    this.query('.ring-a')?.setAttribute('r', '58');
    // The inner ring ends collapsed into the glyph, not full.
    this.query('.ring-b')?.setAttribute('r', '8');

    utils.set(this.queryAll('.boot'), { opacity: 1 });
    utils.set(this.queryAll('.aura'), { opacity: 0.85 });
    utils.set(this.queryAll('.grid'), { opacity: 0.5 });
    utils.set(this.queryAll('.halo'), { opacity: 0.62, scale: 1 });
    utils.set(this.queryAll('.spark'), { opacity: 1 });
    utils.set(this.queryAll('.dot, .dash'), { opacity: 1, scale: 1, translateY: '0px' });
    utils.set(this.queryAll('.letter'), { opacity: 1, scale: 1, translateY: '0px' });
    utils.set(this.queryAll('.tagline, .foot'), { opacity: 1, translateY: '0px' });
    utils.set(this.queryAll('.pulse'), { opacity: 1, scale: 1 });
    utils.set(this.queryAll('.ring-b'), { opacity: 0.2 });
  }

  /**
   * Loops that keep the screen alive after the intro: two sonar rings, the
   * orbiting spark, a breathing halo and a ticking ellipsis.
   */
  private startAmbient(): void {
    if (!this.animation.isEnabled) {
      return;
    }
    try {
      this.startAmbientLoops();
    } catch {
      // Ambient motion is the least important thing on the screen.
    }
  }

  private startAmbientLoops(): void {
    const keep = (animation: { pause: () => void }): void => {
      this.loops.push(animation);
    };

    const waves: Array<[Element | null, number]> = [
      [this.query('.wave-a'), 1_050],
      [this.query('.wave-b'), 1_900],
    ];
    for (const [wave, delay] of waves) {
      if (wave) {
        keep(
          animate(wave, {
            scale: [0.4, 2.05],
            opacity: [0, 0.7, 0],
            duration: 2_600,
            delay,
            loop: true,
            ease: 'out(3)',
          }),
        );
      }
    }

    const spinA = this.one(this.query('.spin-a'));
    const spinB = this.one(this.query('.spin-b'));
    const orbit = this.one(this.query('.orbit'));
    const spark = this.one(this.query('.spark'));
    const halo = this.one(this.query('.halo'));
    const ellipsis = this.queryAll('.ellipsis i');

    keep(animate(spinA, { rotate: [0, 360], duration: 16_000, loop: true, ease: 'linear' }));
    keep(animate(spinB, { rotate: [0, -360], duration: 22_000, loop: true, ease: 'linear' }));
    keep(
      animate(orbit, { rotate: [0, 360], duration: 5_400, delay: 340, loop: true, ease: 'linear' }),
    );
    keep(
      animate(spark, {
        scale: [1, 1.9, 1],
        opacity: [1, 0.6, 1],
        duration: 1_100,
        delay: 340,
        loop: true,
        ease: 'inOut(2)',
      }),
    );
    keep(
      animate(halo, {
        opacity: [0.6, 0.78],
        scale: [1, 1.045],
        duration: 2_400,
        delay: 1_400,
        loop: true,
        alternate: true,
        ease: 'inOut(2)',
      }),
    );
    if (ellipsis.length > 0) {
      keep(
        animate(ellipsis, {
          opacity: [0.15, 1],
          translateY: [0, -2],
          duration: 620,
          delay: stagger(150, { start: 1_600 }),
          loop: true,
          alternate: true,
          ease: 'inOut(2)',
        }),
      );
    }
  }

  private leave(): void {
    if (this.left || !this.viewReady) {
      return;
    }
    this.left = true;
    this.leaving.set(true);
    // Even a warm host waits for the reveal: a screen that flashes for 80ms is
    // worse than not having one at all.
    const wait = Math.max(0, MIN_HOLD_MS - (Date.now() - this.startedAt));
    this.holdTimer = setTimeout(() => this.beginExit(), wait);
  }

  private beginExit(): void {
    this.clearTimers();
    this.stopLoops();
    this.intro?.pause();
    this.snap();

    const veil = this.query('.veil');
    const aura = this.query('.aura');
    const grid = this.query('.grid');
    const mark = this.query('.mark');
    const halo = this.query('.halo');
    const letters = this.queryAll('.letter');
    const words = this.query('.words');
    const foot = this.query('.foot');

    // The empty-state hero leaves a landing pad for the logo; without one (a
    // resumed conversation) the overlay simply lifts.
    const target = this.handoff.read();
    const rect = mark?.getBoundingClientRect();
    const flight =
      target && rect && rect.width > 0
        ? {
            translateX: target.x - (rect.left + rect.width / 2),
            translateY: target.y - (rect.top + rect.height / 2),
            scale: target.width / rect.width,
          }
        : null;

    try {
      const timeline = createTimeline({
        defaults: { ease: 'inOut(2)' },
        onComplete: () => this.dismiss(),
      })
        .add(this.one(halo), { opacity: 0, scale: 1.3, duration: 320 }, 0)
        .add(this.one(aura, grid), { opacity: 0, duration: 320 }, 0)
        // The rings and sonar waves belong to the splash; only the logo travels.
        .add(
          this.one(this.query('.rings'), this.query('.wave-a'), this.query('.wave-b')),
          { opacity: 0, duration: 300 },
          0,
        )
        .add(letters, { translateY: -10, opacity: 0, duration: 260, delay: stagger(20) }, 0)
        .add(this.one(words, foot), { opacity: 0, duration: 220 }, 40);

      if (flight && mark) {
        // A single mark travelling from the centre of the screen to the hero.
        timeline
          .add(mark, { ...flight, duration: 560, ease: 'inOut(3)' }, 0)
          .add(mark, { opacity: 0, duration: 160, ease: 'out(2)' }, 500)
          .add(this.one(veil), { opacity: 0, duration: 380 }, 520);
      } else {
        timeline
          .add(this.one(mark), { scale: 1.16, opacity: 0, duration: 360, ease: 'in(2)' }, 0)
          .add(this.one(veil), { opacity: 0, duration: 420 }, 140);
      }
    } catch {
      this.dismiss();
      return;
    }

    // A stalled outro still has to hand the app back.
    this.outroSettle = setTimeout(() => this.dismiss(), OUTRO_MS + 460);
  }

  private dismiss(): void {
    if (this.dismissedOnce) {
      return;
    }
    this.dismissedOnce = true;
    this.clearTimers();
    this.dismissed.emit();
  }

  private query<T extends Element = HTMLElement>(selector: string): T | null {
    return this.host.nativeElement.querySelector<T>(selector);
  }

  private queryAll<T extends Element = HTMLElement>(selector: string): T[] {
    return Array.from(this.host.nativeElement.querySelectorAll<T>(selector));
  }

  /** Null-safe target list, so a missing node degrades to a no-op animation. */
  private one(...elements: Array<Element | null>): Element[] {
    return elements.filter((element): element is Element => element !== null);
  }

  private stopLoops(): void {
    for (const loop of this.loops) {
      loop.pause();
    }
    this.loops = [];
  }

  private clearTimers(): void {
    if (this.introSettle !== undefined) {
      clearTimeout(this.introSettle);
      this.introSettle = undefined;
    }
    if (this.holdTimer !== undefined) {
      clearTimeout(this.holdTimer);
      this.holdTimer = undefined;
    }
    if (this.outroSettle !== undefined) {
      clearTimeout(this.outroSettle);
      this.outroSettle = undefined;
    }
  }
}
