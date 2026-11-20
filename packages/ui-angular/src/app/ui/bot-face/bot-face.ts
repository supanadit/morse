import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { animate, utils, type JSAnimation } from 'animejs';
import { AnimationService } from '../animation.service';
import { MOODS, interval, type BotMood, type FaceExpression } from './bot-face-moods';

/** One expression on screen: the one arriving, and briefly the one leaving. */
interface FaceLayer {
  id: number;
  expression: FaceExpression;
}

/**
 * One bot's face, worn everywhere it is drawn.
 *
 * Nothing here is a picture. Three things can be behind it, in this order: an
 * image URL, a face the reader picked (`face:3`), or the emoji an older bot
 * already stores. Nothing at all is not a blank letter — it is a face computed
 * from the bot's own handle, so a new bot has one before its creator picks
 * anything, and it keeps it for life.
 *
 * The drawing is a hash (colours, head, crest) plus an expression (eyes and
 * mouth). anime.js runs all of the motion: the body breathes and sways, the eyes
 * drift and blink, and the expression crossfades to the next face of the mood's
 * pool on its own beat. A roster of faces therefore moves as one living thing
 * rather than a wall of glyphs, and every loop stops on `prefers-reduced-motion`.
 *
 * Motion may never hide the face. The crossfade is the risk — a revert or a
 * dropped frame during it leaves a transparent layer — so every fade publishes
 * its end state through a settle timer, and only the mood's loops are ever
 * reverted. A face that stops animating still shows.
 */
@Component({
  selector: 'morse-bot-face',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './bot-face.html',
  styleUrl: './bot-face.css',
})
export class BotFace {
  /** The avatar field itself: a URL, `face:3`, an emoji, or empty. */
  readonly value = input('');
  /** What the face is computed from when nothing was picked: the handle. */
  readonly seed = input('');
  /** How wide it is drawn, in pixels. */
  readonly size = input(24);
  /** What the bot is up to. One row of `MOODS` decides how that reads. */
  readonly mood = input<BotMood>('idle');

  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly motion = inject(AnimationService);
  private readonly destroyRef = inject(DestroyRef);

  /** The faces on screen: the one arriving and, briefly, the one leaving. */
  protected readonly layers = signal<FaceLayer[]>([
    { id: 0, expression: { eyes: 'oval', mouth: 'smile' } },
  ]);
  private nextLayerId = 1;

  /** The mood's loops. These are the only animations a mood change reverts. */
  private readonly loops = new Set<JSAnimation>();
  private cadenceTimer?: ReturnType<typeof setTimeout>;
  private blinkTimer?: ReturnType<typeof setTimeout>;
  private dropTimer?: ReturnType<typeof setTimeout>;
  /** Nothing may animate before the first render has drawn the face. */
  private drawn = false;

  constructor() {
    // The template — and so the SVG these animations target — exists only after
    // the first render. Animating before it found nothing and left the face
    // still for the rest of its life.
    afterNextRender(() => {
      this.drawn = true;
      this.show(this.expressionFor(this.mood()));
      this.restart(this.mood());
    });

    effect(() => {
      const mood = this.mood();
      if (!this.drawn) {
        return;
      }
      this.show(this.expressionFor(mood));
      this.restart(mood);
      this.react(mood);
    });

    this.destroyRef.onDestroy(() => {
      this.drawn = false;
      clearTimeout(this.cadenceTimer);
      clearTimeout(this.blinkTimer);
      clearTimeout(this.dropTimer);
      for (const animation of this.loops) {
        animation.revert();
      }
      this.loops.clear();
    });
  }

  /** A per-instance gradient id, so two faces never share one. */
  protected readonly gradientId = `morse-face-${(faceIds += 1)}`;

  protected readonly image = computed(() => {
    const value = this.value().trim();
    return /^(https?:|data:)/.test(value) ? value : '';
  });

  protected readonly glyph = computed(() => {
    const value = this.value().trim();
    // Not a URL, not a computed face: a stored emoji, which bots keep.
    return value !== '' && !value.startsWith('face:') && /[^\x20-\x7e]/.test(value) ? value : '';
  });

  /**
   * The parts of the face a seed decides, which no mood can change.
   *
   * The seed is the bot's handle in lower case, so one bot wears one face
   * wherever it is drawn — roster, header, transcript. Neighbouring handles are
   * deliberately forced apart: `sigil` and `loom` differ by three characters
   * and hashed to within five degrees of each other, which read as the same
   * orange bot twice. The mixing step below spreads any two seeds over the whole
   * wheel, and the golden angle keeps them from clumping again.
   */
  protected readonly design = computed(() => {
    const value = this.value().trim().toLowerCase();
    const source = value.startsWith('face:') ? value : this.seed().trim().toLowerCase() || 'morse';
    const hash = mix(hashOf(source));
    const hue = (hash * 137.508) % 360;

    return {
      skin: `hsl(${hue} 68% 66%)`,
      shade: `hsl(${(hue + 24) % 360} 62% 44%)`,
      ink: `hsl(${(hue + 200) % 360} 42% 16%)`,
      blush: `hsl(${(hue + 330) % 360} 80% 62%)`,
      crest: (['none', 'antenna', 'ears', 'blush'] as const)[(hash >>> 13) % 4],
      // Which face out of a mood's pool this bot prefers, so two idle bots do
      // not wear the same one.
      slot: (hash >>> 5) % 6,
      // Each face keeps its own beat, so a roster never blinks in unison.
      offset: (hash >>> 3) % 2_400,
    };
  });

  /** The face this bot rests on in a mood: its own, not the pool's first. */
  private expressionFor(mood: BotMood): FaceExpression {
    const pool = MOODS[mood].pool;
    return pool[this.design().slot % pool.length]!;
  }

  /** Swaps the expression: the new face fades in over the old one, then it goes. */
  private show(expression: FaceExpression): void {
    const current = this.layers().at(-1);
    if (current !== undefined && sameExpression(current.expression, expression)) {
      return;
    }

    const layer: FaceLayer = { id: this.nextLayerId++, expression };
    const leaving = this.layers().slice(-1);
    this.layers.set([...leaving, layer]);
    clearTimeout(this.dropTimer);

    // The arriving face is never left transparent: the animation owns both ends,
    // and this settle snaps it to the end state even if no frame ever ran.
    const settle = () => {
      const faces = this.layers();
      // A newer swap may already have replaced this one; it owns the screen now.
      if (faces.at(-1)?.id !== layer.id) {
        return;
      }
      this.layers.set([layer]);
      const arriving = this.layerElement(layer.id);
      if (arriving !== null) {
        utils.set(arriving, { opacity: 1 });
      }
    };

    queueMicrotask(() => {
      const arriving = this.layerElement(layer.id);
      if (arriving === null) {
        return;
      }
      const departing = leaving.length === 0 ? null : this.layerElement(leaving[0]!.id);
      if (!this.motion.isEnabled) {
        utils.set(arriving, { opacity: 1 });
        if (departing !== null) {
          utils.set(departing, { opacity: 0 });
        }
        this.dropTimer = setTimeout(settle, 0);
        return;
      }
      // Fades are deliberately *not* tracked as loops: a mood change must never
      // revert one, because reverting a fade-in restores the opacity it started
      // from — zero — which is a face that vanished.
      animate(arriving, { opacity: [0, 1], duration: 260, ease: 'out(2)' });
      if (departing !== null) {
        animate(departing, { opacity: [1, 0], duration: 220, ease: 'out(2)' });
      } else {
        utils.set(arriving, { opacity: 1 });
      }
      this.dropTimer = setTimeout(settle, 300);
    });
  }

  /** The element of one layer, by the id it was rendered with. */
  private layerElement(id: number): Element | null {
    return this.element.nativeElement.querySelector(`.layer[data-layer="${id}"]`);
  }

  /** Starts the mood's loops, replacing only the loops the last mood started. */
  private restart(mood: BotMood): void {
    clearTimeout(this.cadenceTimer);
    clearTimeout(this.blinkTimer);
    for (const animation of this.loops) {
      animation.revert();
    }
    this.loops.clear();
    if (!this.motion.isEnabled || !this.drawn) {
      return;
    }

    const row = MOODS[mood];
    const offset = this.design().offset;

    // The body breathes, sways and lifts on three groups, so each loop keeps its
    // own period instead of marching in step.
    this.loop('.body', row.breathe, (amount) => ({
      scaleY: [1, 1 - amount],
      scaleX: [1, 1 + amount * 0.6],
      duration: 1_900 + (offset % 700),
    }));

    this.loop('.sway', row.sway, (amount) => ({
      rotate: [-amount, amount],
      duration: 4_400 + (offset % 1_100),
    }));

    this.loop('.lift', row.bob, (amount) => ({
      translateY: [amount / 2, -amount / 2],
      duration: 3_200 + (offset % 900),
    }));

    // The eyes look around, which is most of what makes a face feel awake.
    this.loop('.eyes', row.gaze, (amount) => ({
      translateX: [-amount, amount],
      duration: 2_600 + (offset % 800),
    }));

    // A talking mood moves its mouth, which is the only tell that survives a
    // 24px tile: the eyes are two pixels wide there and the mouth is the answer.
    if (row.talk) {
      this.loop('.layer .mouth', 1, () => ({
        scaleY: [1, 0.62],
        duration: 240 + (offset % 120),
      }));
    }

    // A new face out of the pool, on this mood's own beat.
    const swap = () => {
      this.cadenceTimer = setTimeout(() => {
        const pool = MOODS[this.mood()].pool;
        const current = this.layers().at(-1)?.expression;
        const others = pool.filter((one) => current === undefined || !sameExpression(one, current));
        this.show(
          others.length === 0 ? pool[0]! : others[Math.floor(Math.random() * others.length)]!,
        );
        swap();
      }, interval(row.cadence));
    };
    swap();

    // A blink is a fast, separate beat: it must not wait for the cadence. Every
    // layer blinks, so a face mid-crossfade blinks too rather than freezing.
    if (row.blink !== null) {
      const blink = () => {
        this.blinkTimer = setTimeout(() => {
          for (const target of this.element.nativeElement.querySelectorAll('.layer .blink')) {
            this.play(target, { scaleY: [1, 0.1, 1], duration: 170, ease: 'inOut(2)' });
          }
          blink();
        }, interval(row.blink!));
      };
      blink();
    }
  }

  /** The one-shot a mood change earns: a squash, and a hop the excited one keeps. */
  private react(mood: BotMood): void {
    const host = this.element.nativeElement;
    const rest = { scaleX: 1, scaleY: 1, translateY: '0px' };
    if (!this.motion.isEnabled) {
      utils.set(host, rest);
      return;
    }
    const hop = mood === 'excited' || mood === 'waiting';
    const squash = mood === 'working' ? 0.9 : mood === 'thinking' ? 0.96 : 0.94;
    animate(host, {
      scaleY: [1, squash, 1],
      scaleX: [1, 2 - squash, 1],
      translateY: hop ? [0, -3, 0] : [0, 1, 0],
      duration: hop ? 420 : 320,
      ease: 'out(2)',
    });
    // A squash always ends at rest, whatever the frames did or did not do.
    setTimeout(() => utils.set(host, rest), 500);
  }

  /** A looping tween on one element, or nothing when the mood holds that axis still. */
  private loop(
    selector: string,
    amount: number,
    parameters: (amount: number) => Record<string, unknown>,
  ): void {
    const target = this.element.nativeElement.querySelector(selector);
    if (target === null || amount <= 0) {
      return;
    }
    this.play(target, { ...parameters(amount), loop: true, alternate: true, ease: 'inOut(2)' });
  }

  /** Starts a looping animation and keeps it, so a mood change can stop it. */
  private play(target: Element, parameters: Record<string, unknown>): void {
    const animation = animate(target as never, parameters as never);
    this.loops.add(animation as unknown as JSAnimation);
  }
}

let faceIds = 0;

/** The same eyes and mouth, which is what makes a swap a no-op. */
function sameExpression(left: FaceExpression, right: FaceExpression): boolean {
  return left.eyes === right.eyes && left.mouth === right.mouth;
}

/** Murmur3's finaliser: diffuses the hash so neighbouring handles land far apart. */
function mix(hash: number): number {
  let value = hash;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35);
  value ^= value >>> 16;
  return value >>> 0;
}

/** FNV-1a: the same handle always draws the same face. */
function hashOf(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}
