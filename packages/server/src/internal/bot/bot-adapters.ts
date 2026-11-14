import type { BotEngineAdapter, MorseLogger } from '@morse/system';
import {
  botPiEnv,
  createBotPiFactory,
  PI_BOT_CAPABILITIES,
  writePiCredentials,
  writePiProviders,
} from '@morse/integration-pi';
import {
  OPENCODE_BOT_CAPABILITIES,
  opencodeBotAdapterFactory,
  writeOpenCodeCredentials,
  writeOpenCodeProviders,
  writeOpenCodeSubagents,
} from '@morse/integration-opencode';

/**
 * The engines this host can run a bot on, keyed by the kind a bot records.
 *
 * `BotService` never names an engine: it asks this map for the factory and the
 * credential writer of whichever kind the bot was created with. Each factory is
 * confined to one bot's root, because that isolation is fixed at construction.
 */
export function createBotAdapters(deps: { logger: MorseLogger }): Record<string, BotEngineAdapter> {
  const { logger } = deps;
  return {
    pi: {
      kind: 'pi',
      capabilities: PI_BOT_CAPABILITIES,
      // `BotService` hands in the bot's environment (the host's, plus the
      // variables the wizard declared); a bare root still gets pi's own
      // agent-dir override from `botPiEnv`, never the reader's real one.
      createFactory: (botRoot, env) =>
        createBotPiFactory({ botRoot, env: env ?? botPiEnv(botRoot), logger }),
      writeCredentials: writePiCredentials,
      writeProviders: writePiProviders,
    },
    opencode: {
      kind: 'opencode',
      capabilities: OPENCODE_BOT_CAPABILITIES,
      // OpenCode's bot engine builds its own environment from the bot's config
      // directory, so the host env is applied inside the adapter, not here.
      createFactory: (botRoot) => opencodeBotAdapterFactory(botRoot, logger),
      writeCredentials: writeOpenCodeCredentials,
      writeProviders: writeOpenCodeProviders,
      // Named subagents are OpenCode's own feature and live in the bot's config;
      // pi has neither, which is why its adapter leaves the method off.
      writeSubagents: writeOpenCodeSubagents,
    },
  };
}
