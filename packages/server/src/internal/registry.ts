import { join } from 'node:path';
import { Inject, Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import {
  AgentRouter,
  BotService,
  FileSessionStore,
  SessionRegistry,
  planEngineRegistration,
  type MorseLogger,
} from '@morse/system';
import { bindTranscriptsToRegistry, SessionTranscriptStore } from '@morse/system';
import type { PiRpcAdapter } from '@morse/integration-pi';
import { openOpenCodeEngine } from '@morse/integration-opencode';
import type { MorseServerConfig } from '../app/config.js';
import {
  MORSE_AGENT_ROUTER,
  MORSE_BOT_SERVICE,
  MORSE_SESSION_REGISTRY,
  MORSE_TRANSCRIPT_STORE,
} from '../app/tokens.js';
import { clearWorkspaceIndex } from './workspace/workspace-index.js';
import { createRequire } from 'node:module';
import { createBotAdapters } from './bot/bot-adapters.js';
import {
  botDataMigrations,
  maintainData,
  reconcileBotData,
  type BotDataContext,
  type BotEngineAdapter,
} from '@morse/system';

/**
 * Composition root glue (R7): builds the one agent router this server owns, and
 * the session registry over it.
 *
 * The router owns Morse's ids and serves the sidebar catalog from the
 * file-backed index, so the rest of the host (and every engine) is unaware of
 * which harness created a session. Only engines this machine can actually run
 * are registered: pi when its binary resolves, OpenCode when a URL is
 * configured or its binary is on PATH. A single-engine machine therefore reports
 * one engine, and the frontend offers no choice at all.
 */
export async function createAgentRouter(
  adapter: PiRpcAdapter,
  config: MorseServerConfig,
  logger: MorseLogger,
): Promise<AgentRouter> {
  const store = new FileSessionStore(join(config.dataDir, 'sessions'));
  const router = new AgentRouter({
    store,
    defaultWorkspace: config.workspace,
    logger,
  });

  const openCode = await openOpenCodeEngine({
    logger,
    ...(config.opencodeUrl === undefined ? {} : { url: config.opencodeUrl }),
    ...(config.opencodePassword === undefined ? {} : { password: config.opencodePassword }),
    ...(config.opencodeBin === undefined ? {} : { bin: config.opencodeBin }),
    maxSessionsPerProject: config.sessionsPerProject,
  });

  // `MORSE_ENGINE` picks the new-session default, but only among engines that
  // are actually here: naming an engine that did not resolve would leave a
  // draft with no default on an OpenCode-only machine.
  const piAvailable = piResolves(adapter);
  const candidates = [
    {
      kind: adapter.engine.kind,
      label: 'pi',
      engine: adapter.engine,
      catalog: adapter.catalog,
      extras: adapter.extras,
      available: piAvailable,
      preferred: config.engine !== 'opencode',
    },
    ...(openCode === undefined
      ? []
      : [
          {
            kind: openCode.engine.kind,
            label: 'OpenCode',
            engine: openCode.engine,
            catalog: openCode.catalog,
            extras: openCode.extras,
            available: true,
            preferred: config.engine === 'opencode',
          },
        ]),
  ];

  for (const planned of planEngineRegistration(candidates)) {
    const candidate = candidates.find((entry) => entry.kind === planned.kind);
    if (candidate === undefined) {
      continue;
    }
    router.register(candidate.engine, {
      label: candidate.label,
      catalog: candidate.catalog,
      extras: candidate.extras,
      default: planned.default,
    });
  }

  if (!piAvailable) {
    logger.warn(
      openCode === undefined
        ? 'Neither pi nor OpenCode could be resolved; the setup screen offers both installs'
        : 'pi is not installed here; only OpenCode is offered',
    );
  }
  if (openCode !== undefined && router.engineFor(openCode.engine.kind) !== undefined) {
    logger.info(
      `OpenCode engine registered (${openCode.owned ? 'Morse owns its server' : `attached to ${openCode.baseUrl}`})`,
    );
  }
  return router;
}

/**
 * Whether pi resolves on this machine, without starting anything: `describe()`
 * only locates the binary (and throws the actionable "not found" error).
 */
function piResolves(adapter: PiRpcAdapter): boolean {
  try {
    adapter.describe();
    return true;
  } catch {
    return false;
  }
}

export function createSessionRegistry(
  router: AgentRouter,
  config: MorseServerConfig,
  logger: MorseLogger,
): SessionRegistry {
  return new SessionRegistry({
    factory: router,
    catalog: router,
    defaultWorkspace: config.workspace,
    hotLimit: config.hotSessions,
    logger,
    engines: router.registeredEngines(),
  });
}

/**
 * Bot mode's one service for the whole host: the roster lives in
 * `<dataDir>/bot`, so it survives a restart and belongs to the host rather than
 * to whichever socket asked. The engines it can run are this host's adapters.
 *
 * A corrupt registry must not take the host down with it: bot mode is one
 * capability, and a server that cannot read its roster still runs code sessions.
 * The failure is logged loudly and the host simply offers no bot capability —
 * every `bot/*` route then gets the existing "this host does not support it"
 * path instead of the process dying at boot.
 */
export function createBotService(
  config: MorseServerConfig,
  logger: MorseLogger,
): BotService | undefined {
  try {
    const adapters = createBotAdapters({ logger });
    // Bring the data directory forward *before* anything reads it: an upgrade
    // must not lose a bot, and the reconcile that follows repairs an engine tree
    // whose config went missing. Both are additive from here on — a failure is
    // logged and the host still starts, because bot mode is one capability.
    runDataMaintenance(config, logger, adapters);
    return new BotService({
      root: join(config.dataDir, 'bot'),
      adapters,
      // A bot's own workspace is under its root, but the host still supplies the
      // display name and the fallback directory a probe borrows.
      defaultWorkspace: config.workspace,
      logger,
    });
  } catch (error: unknown) {
    logger.error(
      `Bot mode is unavailable: ${join(config.dataDir, 'bot', 'registry.json')} could not be read. Bot requests will be refused until it is fixed.`,
      error,
    );
    return undefined;
  }
}

/** This build's version, stamped into `version.json` as the migrator's identity. */
function morseVersion(): string | undefined {
  try {
    const pkg = createRequire(import.meta.url)('../../package.json') as { version?: string };
    return pkg.version;
  } catch {
    // A bundled or repackaged host may not have the manifest: the version stamp
    // is a convenience, never a precondition.
    return undefined;
  }
}

/**
 * The upgrade contract: `morse start` brings `.morse/` to this build's data
 * layout and then reconciles it. What cannot be repaired is reported, not fatal.
 */
function runDataMaintenance(
  config: MorseServerConfig,
  logger: MorseLogger,
  adapters: Record<string, BotEngineAdapter>,
): void {
  try {
    const result = maintainData({
      root: config.dataDir,
      logger,
      migrations: botDataMigrations(),
      reconciles: [
        { name: 'bot data', run: (context) => reconcileBotData(context as BotDataContext) },
      ],
      extra: { adapters },
      ...(morseVersion() === undefined ? {} : { morseVersion: morseVersion() }),
    });
    if (result.applied.length > 0) {
      logger.info(
        `Data layout ${result.from} → ${result.to}: ${result.applied.join(', ')}. Backups are in ${join(config.dataDir, 'backups')}.`,
      );
    }
    for (const warning of result.warnings) {
      logger.warn(warning);
    }
  } catch (error: unknown) {
    // A directory from a newer Morse, or an unreadable version file: say exactly
    // that and keep serving, rather than half-migrating in the dark.
    logger.error('Morse could not prepare its data directory for this version.', error);
  }
}

/** Shutdown hook: dispose every warm agent session and the host-wide caches. */
@Injectable()
export class MorseRegistryLifecycle implements OnModuleDestroy {
  private readonly detachTranscripts: () => void;

  constructor(
    @Inject(MORSE_SESSION_REGISTRY) private readonly registry: SessionRegistry,
    @Inject(MORSE_TRANSCRIPT_STORE) transcripts: SessionTranscriptStore,
    @Inject(MORSE_AGENT_ROUTER) private readonly router: AgentRouter,
    // Bot mode is optional at the composition root: a host without the provider
    // (the extension, a bare test module) simply has nothing to shut down here.
    @Optional() @Inject(MORSE_BOT_SERVICE) private readonly bot?: BotService,
  ) {
    // A session retired by the hot limit (or closed, or deleted) drops its warm
    // transcript and paging cursor with its process, so the singleton store
    // tracks the hot set instead of every session the server has ever seen.
    this.detachTranscripts = bindTranscriptsToRegistry(registry, transcripts);
  }

  async onModuleDestroy(): Promise<void> {
    this.detachTranscripts();
    // The workspace index is module-global and LRU-capped while the host runs;
    // on shutdown there is nothing left to serve, so drop every listing rather
    // than hold them until the process exits.
    clearWorkspaceIndex();
    // Bot engines outlive an individual turn, so they are torn down with the
    // host: a bot's warm gateway may be a whole engine server process.
    await this.bot?.dispose();
    await this.registry.dispose();
    // An owned OpenCode server stops with the host; an attached one is untouched.
    for (const engine of this.router.registeredEngines()) {
      await engine.dispose?.().catch(() => undefined);
    }
  }
}
