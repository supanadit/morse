/*
 * The live row's two small rules, kept out of the component so they can be read
 * and tested on their own: how much of an answer that is still being written is
 * on screen, how long a turn has run, and when a row has gone quiet.
 */

/** How many characters one tick of the reveal can add before the share. */
const STEP_CHARS = 24;
/** The part of what is still unread that one tick also catches up on. */
const SHARE = 0.25;
/** A turn younger than this says nothing about its elapsed time. */
const YOUNG_MS = 5_000;
/** With no new step and nothing running, a row has been quiet this long. */
const QUIET_AFTER_MS = 20_000;

/**
 * How much of `text` to show on the next tick, given what is already shown.
 *
 * A burst of words arrives as one push, so the reveal cannot simply walk one
 * character at a time: each tick adds a step, plus a share of what is still
 * unread, so a long answer is caught up with quickly and a short one is not
 * shown in one blink. The advance backs up to the last space it passed, so the
 * reader never watches half a word appear — unless a single word is longer than
 * anything the reveal could cover, in which case it keeps going rather than
 * standing still. It never runs past the text and never steps back below what is
 * already shown.
 */
export function revealLength(
  shown: number,
  text: string,
  stepChars: number = STEP_CHARS,
  share: number = SHARE,
): number {
  const current = Math.min(Math.max(0, Math.floor(shown)), text.length);
  if (current >= text.length) {
    return text.length;
  }
  const unread = text.length - current;
  const advance = Math.min(text.length, current + stepChars + Math.ceil(unread * share));
  if (advance >= text.length) {
    return text.length;
  }
  for (let at = advance; at > current; at -= 1) {
    if (text[at - 1] === ' ') {
      return at;
    }
  }
  return advance;
}

/**
 * How long a turn has been running, in the reader's words — or nothing at all
 * while the answer is still young.
 *
 * A timer that appears after the first second draws the eye to the clock instead
 * of the work, so the row says nothing for the first five seconds. Past a minute
 * it counts in minutes and seconds, padded, so the label does not change width
 * every ten seconds.
 */
export function elapsedLabel(ms: number): string | undefined {
  if (!(ms >= YOUNG_MS)) {
    return undefined;
  }
  const total = Math.floor(ms / 1000);
  if (total < 60) {
    return `${total}s`;
  }
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * Whether a live row has gone quiet: the newest step is old and nothing is
 * running inside it.
 *
 * A model that is thinking hard reports nothing for a while, and a row that
 * keeps shimmering through that is claiming work that is not visible. Twenty
 * seconds is long enough not to flicker between two steps and short enough that
 * a stalled turn is visible.
 */
export function rowIsQuiet(now: number, lastStepAt: number, runningTool: boolean): boolean {
  return !runningTool && now - lastStepAt >= QUIET_AFTER_MS;
}
