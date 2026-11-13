/**
 * Which band's `Notes`/`Cancel` pair is on screen.
 *
 * The pair floats over the code, so it is not always there: it belongs to the band
 * the pointer is over, and it steps aside once the reader has used it (written a
 * note, or just applied the pin). Everything else is the tint, which is the whole
 * of what a pinned range owes the file it sits in.
 */
import type { EditorPin } from './pins';

/** The pin whose band covers `line`, if any. */
export function pinAtLine(
  pins: readonly EditorPin[],
  line: number | undefined,
): EditorPin | undefined {
  if (line === undefined) {
    return undefined;
  }
  return pins.find((pin) => line >= pin.startLine && line <= (pin.endLine ?? pin.startLine));
}
