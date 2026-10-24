import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { SessionRegistry, type MorseLogger } from '@morse/system';
import { bindTranscriptsToRegistry, SessionTranscriptStore } from '@morse/system';
import type { PiRpcAdapter } from '@morse/integration-pi';
import type { MorseServerConfig } from '../app/config.js';
import { MORSE_SESSION_REGISTRY, MORSE_TRANSCRIPT_STORE } from '../app/tokens.js';
import { clearWorkspaceIndex } from './workspace/workspace-index.js';

/**
 * Composition root glue (R7): builds the one session registry this server owns.
 * Because it is shared, multiple projects and sessions keep running while
 * clients connect, refresh and disconnect.
 */
export function createSessionRegistry(
  adapter: PiRpcAdapter,
  config: MorseServerConfig,
  logger: MorseLogger,
): SessionRegistry {
  return new SessionRegistry({
    factory: adapter.factory,
    catalog: adapter.catalog,
    defaultWorkspace: config.workspace,
    hotLimit: config.hotSessions,
    logger,
  });
}

/** Shutdown hook: dispose every warm `pi` process and the host-wide caches. */
@Injectable()
export class MorseRegistryLifecycle implements OnModuleDestroy {
  private readonly detachTranscripts: () => void;

  constructor(
    @Inject(MORSE_SESSION_REGISTRY) private readonly registry: SessionRegistry,
    @Inject(MORSE_TRANSCRIPT_STORE) transcripts: SessionTranscriptStore,
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
  }
}
