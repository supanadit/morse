/** The bot chat's transcript joins and labels: which line answered a turn, in what order. */
import type { BotActivity, BotTranscriptEntry, BotTurnTrace } from '@morse/protocol';

/**
 * One row of the chat's timeline: a line the host kept, or the record of a turn
 * that produced one. Exactly one of `entry` and `trace` is set.
 */
export interface TimelineItem {
  /** Unique across both kinds: an entry and a trace may share an id, never a row. */
  key: string;
  /** When it belongs in the conversation: a line's `at`, a trace's `endedAt`. */
  at: number;
  entry?: BotTranscriptEntry;
  /** A turn with no answer line of its own: drawn as its own record row. */
  trace?: BotTurnTrace;
  /**
   * Turns anchored to `entry`, the answer they produced: drawn inside that
   * line, beside its author, rather than as a second block repeating who spoke.
   */
  traces?: BotTurnTrace[];
}

export function answerFor(
  trace: BotTurnTrace,
  entries: BotTranscriptEntry[],
): BotTranscriptEntry | undefined {
  let answer: BotTranscriptEntry | undefined;
  for (const entry of entries) {
    if (entry.author.role !== 'bot' || entry.author.username !== trace.username) {
      continue;
    }
    if (entry.at < trace.startedAt || entry.at > trace.endedAt) {
      continue;
    }
    if (answer === undefined || entry.at < answer.at) {
      answer = entry;
    }
  }
  return answer;
}

/** A trace sorts before an entry at the same instant, so a record sits above its line. */
export function itemRank(item: TimelineItem): number {
  return item.trace === undefined ? 1 : 0;
}

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

/**
 * How long a finished turn ran, in the reader's words.
 *
 * Rounded to whole seconds, so a short turn says `0s` rather than a decimal that
 * claims more precision than a person reads. A finished turn always shows its
 * duration: unlike the live row, there is no threshold below which it is noise —
 * the record is the point.
 */
export function turnDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}
