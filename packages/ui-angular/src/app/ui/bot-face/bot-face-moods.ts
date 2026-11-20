/**
 * What a bot can look like, and how each mood moves.
 *
 * The face is computed, so an expression is four words rather than forty-eight
 * drawn points: two eyes and a mouth, drawn by the component. A mood is a *pool*
 * of them plus the beats to swap, blink and breathe on — so a working bot cycles
 * through attentive faces instead of wearing one frozen mask.
 *
 * Every number here is a choice, not a measurement: they were picked so a roster
 * of faces breathes rather than jitters, and so no two moods blink at the same
 * interval. The eyes are drawn from the seed, so a face keeps its identity while
 * its expression moves.
 */

/** The eyes this face can draw. */
export type EyeShape = 'dot' | 'oval' | 'lidded' | 'wide' | 'up' | 'sad';

/** The mouth this face can draw. */
export type MouthShape = 'smile' | 'grin' | 'half' | 'flat' | 'oh' | 'frown';

/** One face an expression can wear: the only two parts that carry a mood. */
export interface FaceExpression {
  eyes: EyeShape;
  mouth: MouthShape;
}

/** What a bot is up to, as far as its face is concerned. */
export type BotMood = 'idle' | 'thinking' | 'working' | 'waiting' | 'failed' | 'excited';

/** One mood, as the face reads it. */
export interface MoodPresentation {
  /** The faces the mood cycles through, in the order it prefers them. */
  pool: readonly FaceExpression[];
  /** Milliseconds between two faces out of the pool. */
  cadence: readonly [number, number];
  /** Milliseconds between blinks, or `null` for a bot that never blinks. */
  blink: readonly [number, number] | null;
  /** Breathing amplitude, as a fraction of the face's size. Zero holds still. */
  breathe: number;
  /** How far the body sways, in face units (of 100). */
  sway: number;
  /** How far the body lifts, in face units. */
  bob: number;
  /** How far the eyes drift, in face units; zero stares. */
  gaze: number;
  /**
   * Whether the mouth moves, as if finding the next word. A face is 24px wide in
   * a roster, where an eye shape is two pixels: the mouth is the one tell that
   * survives that size, and it is the difference between a bot that is answering
   * and one that is staring at you.
   */
  talk: boolean;
}

/**
 * The mood table. `thinking` and `working` are the busy ones: they change face
 * often, blink a lot and breathe hard, which is what makes them read as alive.
 * `idle` holds one face for most of a minute, so a quiet roster is quiet.
 */
export const MOODS: Readonly<Record<BotMood, MoodPresentation>> = {
  idle: {
    pool: [
      { eyes: 'oval', mouth: 'smile' },
      { eyes: 'dot', mouth: 'half' },
    ],
    cadence: [9_000, 16_000],
    blink: [5_000, 12_000],
    breathe: 0.02,
    sway: 0.8,
    bob: 1.2,
    gaze: 1.6,
    talk: false,
  },
  thinking: {
    pool: [
      { eyes: 'up', mouth: 'half' },
      { eyes: 'lidded', mouth: 'flat' },
      { eyes: 'oval', mouth: 'oh' },
    ],
    cadence: [2_000, 3_600],
    blink: [3_500, 7_000],
    breathe: 0.014,
    sway: 1.6,
    bob: 0.8,
    gaze: 3.2,
    talk: true,
  },
  working: {
    pool: [
      { eyes: 'dot', mouth: 'half' },
      { eyes: 'lidded', mouth: 'smile' },
      { eyes: 'oval', mouth: 'flat' },
    ],
    cadence: [3_200, 5_400],
    blink: [2_600, 5_200],
    breathe: 0.028,
    sway: 1,
    bob: 2.2,
    gaze: 2.2,
    talk: false,
  },
  waiting: {
    pool: [
      { eyes: 'wide', mouth: 'oh' },
      { eyes: 'oval', mouth: 'smile' },
    ],
    cadence: [3_000, 4_800],
    blink: [2_400, 4_600],
    breathe: 0.018,
    sway: 2.2,
    bob: 1.4,
    gaze: 4,
    talk: false,
  },
  failed: {
    pool: [
      { eyes: 'sad', mouth: 'frown' },
      { eyes: 'sad', mouth: 'flat' },
    ],
    cadence: [7_000, 11_000],
    blink: null,
    breathe: 0.012,
    sway: 0.6,
    bob: 0.6,
    gaze: 1.2,
    talk: false,
  },
  excited: {
    pool: [
      { eyes: 'dot', mouth: 'grin' },
      { eyes: 'wide', mouth: 'smile' },
    ],
    cadence: [1_600, 2_600],
    blink: [1_800, 3_400],
    breathe: 0.04,
    sway: 2.6,
    bob: 3.4,
    gaze: 3,
    talk: true,
  },
};

/** The expression a face rests on when nothing has been drawn yet. */
export function restingExpression(mood: BotMood): FaceExpression {
  return MOODS[mood].pool[0]!;
}

/** A random interval out of a `[low, high]` pair, so no two faces keep one beat. */
export function interval([low, high]: readonly [number, number]): number {
  return low + Math.random() * (high - low);
}
