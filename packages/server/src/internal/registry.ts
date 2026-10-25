import { join } from 'node:path';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  AgentRouter,
  FileSessionStore,
  SessionRegistry,
  type MorseLogger,
} from '@morse/system';
import { bindTranscriptsToRegistry, SessionTranscriptStore } from '@morse/system';
import type { PiRpcAdapter } from '@morse/integration-pi';
import { openOpenCodeEngine } from '@morse/integration-opencode';
import type { MorseServerConfig } from '../app/config.js';
import { MORSE_AGENT_ROUTER, MORSE_SESSION_REGISTRY, MORSE_TRANSCRIPT_STORE } from '../app/tokens.js';
import { clearWorkspaceIndex } from './workspace/workspace-index.js';

/**
 * Composition root glue (R7): builds the one agent router this server owns, and
 * the session registry over it.
 *
 * The router owns Morse's ids and serves the sidebar catalog from the
 * file-backed index, so the rest of the host (and every engine) is unaware of
 * which harness created a session. pi is always registered; OpenCode registers
 * itself only when a URL is configured or its binary is on PATH, so a pi-only
 * machine never starts one.
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

  // `MORSE_ENGINE` picks the new-session default, but an engine that could not
  // start never becomes the default: the host keeps working on pi.
  const defaultIsOpenCode = config.engine === 'opencode' && openCode !== undefined;
  router.register(adapter.engine, {
    label: 'pi',
    catalog: adapter.catalog,
    extras: adapter.extras,
    default: !defaultIsOpenCode,
  });
  if (openCode !== undefined) {
    router.register(openCode.engine, {
      label: 'OpenCode',
      catalog: openCode.catalog,
      default: defaultIsOpenCode,
    });
    logger.info(
      `OpenCode engine registered (${openCode.owned ? 'Morse owns its server' : `attached to ${openCode.baseUrl}`})`,
    );
  }
  return router;
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

/** Shutdown hook: dispose every warm agent session and the host-wide caches. */
@Injectable()
export class MorseRegistryLifecycle implements OnModuleDestroy {
  private readonly detachTranscripts: () => void;

  constructor(
    @Inject(MORSE_SESSION_REGISTRY) private readonly registry: SessionRegistry,
    @Inject(MORSE_TRANSCRIPT_STORE) transcripts: SessionTranscriptStore,
    @Inject(MORSE_AGENT_ROUTER) private readonly router: AgentRouter,
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
    await this.registry.dispose();
    // An owned OpenCode server stops with the host; an attached one is untouched.
    for (const engine of this.router.registeredEngines()) {
      await engine.dispose?.().catch(() => undefined);
    }
  }
}
