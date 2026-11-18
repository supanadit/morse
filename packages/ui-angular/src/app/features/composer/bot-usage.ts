import type {
  BotUsage,
  ContextUsage,
  ModelOption,
  SessionCounts,
  SessionSpeed,
  TokenUsage,
} from '@morse/protocol';

/**
 * The low-level inputs `morse-usage-indicator` takes, mapped from one bot's
 * reported counters.
 *
 * Bot mode's `BotUsage` is the wire shape — a conversation, a bot and that bot's
 * engine session — while the indicator is deliberately dumb about where its
 * numbers came from. Two places draw a bot's ring (the composer's single one and
 * each presence row's own), so the mapping lives here once: a field added to the
 * panel cannot reach one and miss the other.
 */
export interface BotUsageInputs {
  usage?: TokenUsage;
  lastUsage?: TokenUsage;
  costUsd?: number;
  contextUsage?: ContextUsage;
  counts?: SessionCounts;
  speed?: SessionSpeed;
  model?: ModelOption;
  /** The bot's name, so the panel says whose window it is drawing. */
  sessionTitle?: string;
}

/** Maps one bot's counters onto the indicator's inputs. */
export function botUsageInputs(bot: BotUsage | undefined): BotUsageInputs {
  const title = bot === undefined ? undefined : (bot.bot ?? bot.username);
  return {
    ...(bot?.usage === undefined ? {} : { usage: bot.usage }),
    ...(bot?.lastUsage === undefined ? {} : { lastUsage: bot.lastUsage }),
    ...(bot?.costUsd === undefined ? {} : { costUsd: bot.costUsd }),
    ...(bot?.contextUsage === undefined ? {} : { contextUsage: bot.contextUsage }),
    ...(bot?.counts === undefined ? {} : { counts: bot.counts }),
    ...(bot?.speed === undefined ? {} : { speed: bot.speed }),
    ...(bot?.model === undefined ? {} : { model: bot.model }),
    ...(title === undefined ? {} : { sessionTitle: title }),
  };
}

/** Whether these inputs give the ring anything to draw. */
export function hasBotUsage(inputs: BotUsageInputs): boolean {
  return inputs.usage !== undefined || inputs.contextUsage !== undefined;
}
