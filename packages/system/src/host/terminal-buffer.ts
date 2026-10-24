/**
 * The bounded text a terminal replays to a viewer that attached late.
 *
 * A shell's output is unbounded (`yes` never stops), so both the in-memory
 * replay and the on-disk scrollback keep only the tail. One implementation, so
 * the two never disagree about what "the last N" means.
 */

/**
 * How much scrollback one terminal keeps. Small enough to hold for every pane a
 * reader might leave open, large enough to cover what a person scrolls back to.
 */
export const TERMINAL_BUFFER_CHARS = 256 * 1024;

/**
 * Keeps the last `maxChars` of `text`, cut at a newline so a replayed scrollback
 * does not start in the middle of an escape sequence (which would paint
 * garbage). A single line longer than the cap has no newline to cut at, so its
 * raw tail is kept — better partial output than none.
 */
export function trimTail(text: string, maxChars = TERMINAL_BUFFER_CHARS): string {
  // `slice` with a negative start is relative to the end, so this is the tail.
  if (text.length <= maxChars) {
    return text;
  }
  const tail = text.slice(-maxChars);
  const newline = tail.indexOf('\n');
  return newline === -1 ? tail : tail.slice(newline + 1);
}
