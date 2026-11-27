import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import { DEFAULT_WS_PATH } from '@morse/protocol';
import { AppModule } from './app.module.js';
import { MORSE_CONFIG } from './app/tokens.js';
import { basicAuthMiddleware } from './internal/http/basic-auth.js';
import { osUsersEnabled } from './internal/os-users.js';
import type { MorseServerConfig } from './app/config.js';

/**
 * SSH host key for OS-user hosts: generated once into `<MORSE_HOME>/ssh` so
 * every deployment (and every rebuild over a kept volume) has its own key.
 * The container's sshd is handed this path by the entrypoint.
 */
function ensureSshHostKey(home: string, logger: Logger): void {
  if (!osUsersEnabled()) {
    return;
  }
  try {
    const dir = join(home, 'ssh');
    mkdirSync(dir, { recursive: true });
    const key = join(dir, 'ssh_host_ed25519_key');
    if (!existsSync(key)) {
      const generated = spawnSync('ssh-keygen', ['-t', 'ed25519', '-f', key, '-N', '', '-q'], {
        timeout: 30_000,
      });
      if (generated.status !== 0) {
        logger.warn('Could not generate the SSH host key; sshd will fail to start.');
      }
    }
  } catch (error) {
    logger.warn(`Could not prepare SSH host keys: ${String(error)}`);
  }
}

/**
 * Composition root entry point. Morse has two of these — this one and the VS
 * Code extension — and both wire the same core + adapter packages.
 */
async function bootstrap(): Promise<void> {
  // OS-user hosts share every tree through the `morse` group: umask 002 keeps
  // group-write on everything the server (and its engines) create, so an SSH
  // user in that group can edit agent-made files and vice versa.
  if (osUsersEnabled()) {
    process.umask(0o002);
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get<MorseServerConfig>(MORSE_CONFIG);

  app.useWebSocketAdapter(new WsAdapter(app));
  // Gate every browser-facing route (frontend, /api, /ws upgrade) behind HTTP
  // Basic auth when MORSE_AUTH_PASSWORD is set; health and the bot bus stay open.
  // Multi-user hosts skip this gate: the login form (cookie + /api/auth) owns
  // identity there, and the static login page must load unauthenticated.
  if (!config.multiuser) {
    app.use(basicAuthMiddleware(config.authPassword, config.authUsername));
  }
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
  ensureSshHostKey(config.dataDir, logger);
  logger.log(`Morse server listening on http://${config.host}:${config.port}`);
  logger.log(`WebSocket endpoint: ws://${config.host}:${config.port}${DEFAULT_WS_PATH}`);
  logger.log(`Frontend served from ${config.uiDir}`);
  if (config.multiuser) {
    logger.log('Multi-user mode: sessions are scoped per login user');
  } else if (config.authPassword !== undefined) {
    logger.log('HTTP Basic auth enabled (MORSE_AUTH_PASSWORD)');
  }
  logger.log(`Workspace: ${config.workspace.cwd} (override with MORSE_WORKSPACE)`);
}

void bootstrap();
