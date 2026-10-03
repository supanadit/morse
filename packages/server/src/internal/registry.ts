import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { SessionRegistry, type MorseLogger } from '@morse/core';
import { SessionTranscriptStore } from '@morse/host-runtime';
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
  constructor(
    @Inject(MORSE_SESSION_REGISTRY) private readonly registry: SessionRegistry,
    @Inject(MORSE_TRANSCRIPT_STORE) private readonly transcripts: SessionTranscriptStore,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.registry.dispose();
    this.transcripts.dispose();
  }
}
