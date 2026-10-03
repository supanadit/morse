import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import { DEFAULT_WS_PATH } from '@morse/protocol';
import { AppModule } from './app.module.js';
import { MORSE_CONFIG } from './app/tokens.js';
import type { MorseServerConfig } from './app/config.js';

/**
 * Composition root entry point. Morse has two of these — this one and the VS
 * Code extension — and both wire the same core + adapter packages.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get<MorseServerConfig>(MORSE_CONFIG);

  app.useWebSocketAdapter(new WsAdapter(app));
  // Serves the built Angular frontend. No SPA fallback is registered, so
  // /api/* and /ws keep working.
  app.useStaticAssets(config.uiDir);
  app.enableCors({ origin: true });
  // Release the port promptly and dispose agent sessions on SIGINT/SIGTERM.
  // Without this, `node --watch` restarts race with the old process and fail
  // with EADDRINUSE, and spawned pi processes are leaked.
  app.enableShutdownHooks();

  await app.listen(config.port, config.host);

  const logger = new Logger('morse');
  logger.log(`Morse server listening on http://${config.host}:${config.port}`);
  logger.log(`WebSocket endpoint: ws://${config.host}:${config.port}${DEFAULT_WS_PATH}`);
  logger.log(`Frontend served from ${config.uiDir}`);
  logger.log(`Workspace: ${config.workspace.cwd} (override with MORSE_WORKSPACE)`);
}

void bootstrap();
