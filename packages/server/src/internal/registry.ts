import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { SessionRegistry, type MorseLogger } from '@morse/core';
import { bindTranscriptsToRegistry, SessionTranscriptStore } from '@morse/host-runtime';
import type { PiRpcAdapter } from '@morse/adapter-pi-rpc';
import type { MorseServerConfig } from '../app/config.js';
import { MORSE_SESSION_REGISTRY, MORSE_TRANSCRIPT_STORE } from '../app/tokens.js';

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

/** Shutdown hook: dispose every warm `pi` process and the transcripts. */
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
    await this.registry.dispose();
  }
}
