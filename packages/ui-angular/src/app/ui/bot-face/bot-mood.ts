import type { BotMood } from './bot-face-moods';

/** What the roster, the chat and the engine know about a bot's right now. */
export interface BotMoodSignals {
  /** What the bot says it helps with: its name, its description, its instructions. */
  description?: string;
  /** A round is in flight for this bot: it is answering as the reader looks. */
  streaming?: boolean;
  /** Its engine is running, so it is mid-work even between rounds. */
  warm?: boolean;
  /** Its last turn failed or was cancelled. */
  failed?: boolean;
}

/**
 * The words that give a bot away when it is doing nothing.
 *
 * A bot is asked for once and then sits in a list, so the two things a reader
 * knows about it are its name and what it says it helps with. These words turn
 * that description into a resting face: a reviewer looks around, a watcher
 * waits, a writer is pleased with itself. Nothing here outranks a real signal —
 * a working bot is working whatever its blurb claims.
 */
const HINTS: readonly { mood: BotMood; words: RegExp }[] = [
  { mood: 'working', words: /\b(code|coding|refactor|debug|test|build|migrate|deploy|patch)\b/ },
  {
    mood: 'thinking',
    words: /\b(research|analyse|analyze|explain|review|audit|compare|investigate|plan|design)\b/,
  },
  { mood: 'waiting', words: /\b(monitor|watch|alert|status|uptime|on-call|queue|approve)\b/ },
  { mood: 'failed', words: /\b(broken|incident|outage|regression)\b/ },
  { mood: 'excited', words: /\b(write|draft|brainstorm|idea|story|launch|announce|celebrate)\b/ },
];

/**
 * The face a bot wears, from the signals that can claim one.
 *
 * This is pure and holds the precedence, in one place, so the roster tile, the
 * chat header and the editor's preview cannot disagree about the same bot. It
 * runs from the state that needs the reader soonest to the one that needs them
 * least: a failure has already stopped and outranks an answer still arriving,
 * which outranks work running on its own, which outranks a blurb.
 */
export function moodForBot(signals: BotMoodSignals): BotMood {
  if (signals.failed === true) {
    return 'failed';
  }
  if (signals.streaming === true) {
    return 'thinking';
  }
  if (signals.warm === true) {
    return 'working';
  }
  const words = signals.description ?? '';
  if (words.trim().length > 0) {
    for (const hint of HINTS) {
      if (hint.words.test(words.toLowerCase())) {
        return hint.mood;
      }
    }
  }
  return 'idle';
}
