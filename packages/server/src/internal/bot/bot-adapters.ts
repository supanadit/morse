import type { BotEngineAdapter, MorseLogger } from '@morse/system';
import {
  botPiEnv,
  createBotPiFactory,
  importPiGlobalConfig,
  PI_BOT_CAPABILITIES,
  piBotLayout,
} from '@morse/integration-pi';
import {
  OPENCODE_BOT_CAPABILITIES,
  importOpenCodeGlobalConfig,
  openCodeBotLayout,
  opencodeBotAdapterFactory,
  importOpenCodeCredentials,
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
      // A checked "Use global configuration" snapshots the machine's own
      // `auth.json` and `models.json` providers into the bot; the bot wins.
      importGlobalConfig: (botRoot) => Promise.resolve(importPiGlobalConfig(botRoot)),
      // pi's agent dir (`config/`) *is* the bot's `~/.pi/agent`: auth.json,
      // models.json, settings.json and AGENTS.md, in pi's own shapes.
      layout: piBotLayout,
    },
    opencode: {
      kind: 'opencode',
      capabilities: OPENCODE_BOT_CAPABILITIES,
      // `BotService` hands in the bot's environment — the host's, the variables
      // the wizard declared, and the `MORSE_BUS_*` files its bus plugin reads.
      // The adapter still puts the XDG redirects on top, so a bot never reads
      // the reader's own engine; dropping the env would silently cost a bot
      // every KEY=value it was given.
      createFactory: (botRoot, env) => opencodeBotAdapterFactory(botRoot, logger, env),
      // OpenCode 2 keeps credentials in the user's store, not in a file: every
      // integration they are logged into. The host reads it for a probe or a
      // save that asks for global configuration; it never reaches a client.
      importStoredCredentials: (botRoot) => importOpenCodeCredentials(botRoot, logger),
      // A checked "Use global configuration" snapshots the machine's auth
      // store and custom providers into the bot, stored logins included; the bot
      // wins on conflict.
      importGlobalConfig: (botRoot) => importOpenCodeGlobalConfig(botRoot, logger),
      // OpenCode's `opencode.json` follows opencode.ai/config.json: model,
      // providers, agents and instructions, beside its own auth store.
      layout: openCodeBotLayout,
    },
  };
}
