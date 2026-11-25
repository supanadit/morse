/** The bot chat's transcript joins and labels for the lines it draws. */
import type { BotActivity } from '@morse/protocol';

/**
 * The steps a reader is shown: the model's thinking stays private to the turn.
 * Thoughts still drive the live row's presence — its clock and its shimmer —
 * but they are not work a reader can check, so no list or count names them.
 */
export function visibleSteps(steps: readonly BotActivity[]): BotActivity[] {
  return steps.filter((step) => step.kind !== 'thinking');
}

/**
 * How much of what is on screen is still at the head of the text that arrived.
 *
 * The host keeps only the tail of a long answer, so a later push can begin
 * part-way through words already shown. The longest suffix of the revealed text
 * that is a prefix of `partial` is what both still share; anything after it is
 * new. A different answer shares nothing and starts over.
 */
export function overlapWithRevealed(revealed: string, partial: string): number {
  const most = Math.min(revealed.length, partial.length);
  for (let length = most; length > 0; length -= 1) {
    if (partial.startsWith(revealed.slice(revealed.length - length))) {
      return length;
    }
  }
  return 0;
}

/**
 * A live label fitted after "Forge is": the sentence's own capital lowered, unless
 * the first word is not ordinary sentence capitalisation.
 *
 * "Reading launch-brief.md…" becomes "reading launch-brief.md"; "API lookup"
 * keeps its capitals, because they name the thing rather than start a sentence.
 */
export function sentenceCase(text: string): string {
  const end = text.search(/\s/);
  const word = end === -1 ? text : text.slice(0, end);
  if (!/^[A-Z]/.test(word) || word.slice(1) !== word.slice(1).toLowerCase()) {
    return text;
  }
  return word.slice(0, 1).toLowerCase() + text.slice(1);
}
