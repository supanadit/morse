import { Module } from '@nestjs/common';
import { createPiRpcAdapter, type PiRpcAdapter } from '@morse/adapter-pi-rpc';
import { SessionRegistry, type MorseLogger } from '@morse/core';
import type { ProjectPolicy } from '@morse/host-runtime';
import { SessionTranscriptStore } from '@morse/host-runtime';
import { HealthController } from './internal/http/health.controller.js';
import { NestMorseLogger } from './internal/logging/nest-logger.js';
import { ServerProjectPolicy } from './internal/projects/project-policy.js';
import { ServerTerminalBackend } from './internal/terminal/terminal.service.js';
import { ServerLanguageServers } from './internal/lsp/lsp.service.js';
import { createSessionRegistry, MorseRegistryLifecycle } from './internal/registry.js';
import { MorseGateway } from './internal/ws/morse.gateway.js';
import { MorseSessionFactory } from './internal/ws/session-factory.service.js';
import { loadConfig, type MorseServerConfig } from './app/config.js';
import {
  MORSE_CONFIG,
  MORSE_LOGGER,
  MORSE_PI_ADAPTER,
  MORSE_PROJECT_POLICY,
  MORSE_SESSION_REGISTRY,
  MORSE_TRANSCRIPT_STORE,
} from './app/tokens.js';

/**
 * Every provider here is wiring (clean-architecture R7): config in, concrete
 * adapters out. The NestJS DI container *is* this host's composition root.
 *
 * The session registry is a singleton, so the agent sessions (and their
 * projects) keep running across client reconnects; only the per-connection
 * controller is created and disposed with the WebSocket.
 */
@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: MORSE_CONFIG,
      useFactory: (): MorseServerConfig => loadConfig(),
    },
    {
      provide: MORSE_LOGGER,
      useFactory: (): MorseLogger => new NestMorseLogger(),
    },
    {
      provide: MORSE_PI_ADAPTER,
      useFactory: (config: MorseServerConfig, logger: MorseLogger): PiRpcAdapter =>
        createPiRpcAdapter(
          {
            piPath: config.piPath,
            nodeEntryPath: config.nodeEntryPath,
            sessionDir: config.sessionDir,
            noSession: config.noSession,
            requestTimeoutMs: config.requestTimeoutMs,
            clientVersion: config.frontend?.version,
          },
          logger,
        ),
      inject: [MORSE_CONFIG, MORSE_LOGGER],
    },
    {
      provide: MORSE_SESSION_REGISTRY,
      useFactory: (
        adapter: PiRpcAdapter,
        config: MorseServerConfig,
        logger: MorseLogger,
      ): SessionRegistry => createSessionRegistry(adapter, config, logger),
      inject: [MORSE_PI_ADAPTER, MORSE_CONFIG, MORSE_LOGGER],
    },
    {
      provide: MORSE_TRANSCRIPT_STORE,
      useFactory: (): SessionTranscriptStore => new SessionTranscriptStore(),
    },
    {
      provide: MORSE_PROJECT_POLICY,
      useFactory: (config: MorseServerConfig): ProjectPolicy =>
        new ServerProjectPolicy(config.projects),
      inject: [MORSE_CONFIG],
    },
    MorseRegistryLifecycle,
    ServerTerminalBackend,
    // The browser host's language servers: a singleton, like the terminal
    // backend, because starting one is the expensive part.
    ServerLanguageServers,
    MorseSessionFactory,
    MorseGateway,
  ],
})
export class AppModule {}
