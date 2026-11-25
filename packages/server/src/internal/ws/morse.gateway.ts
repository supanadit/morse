import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Inject } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import type { RawData, WebSocket } from 'ws';
import {
  DEFAULT_WS_PATH,
  LOGIN_REQUIRED_CLOSE_CODE,
  encodeWireMessage,
  parseClientMessage,
  type HostToClientMessage,
} from '@morse/protocol';
import { HostSessionController } from '@morse/system';
import type { MorseLogger } from '@morse/system';
import type { Knex } from 'knex';
import type { AuthUser } from '@morse/protocol';
import { MORSE_CONFIG, MORSE_DB, MORSE_LOGGER } from '../../app/tokens.js';
import { isAuthorized } from '../http/basic-auth.js';
import { authUserOfRequest } from '../http/auth.controller.js';
import { MorseSessionFactory } from './session-factory.service.js';

/**
 * Driving adapter: one WebSocket per client, one controller per connection.
 * Single-user hosts share one registry; multi-user hosts resolve the login
 * cookie and hand the connection its owner's bundle — so sessions in several
 * projects keep running while clients connect, refresh or disconnect.
 * Everything protocol-shaped is delegated to `HostSessionController`, which
 * the VS Code host also uses.
 */
@WebSocketGateway({ path: DEFAULT_WS_PATH })
export class MorseGateway implements OnGatewayConnection, OnGatewayDisconnect {
  /** Each socket's controller, plus the emit closure that belongs to it alone. */
  private readonly clients = new Map<
    WebSocket,
    { controller: HostSessionController; emit: (message: HostToClientMessage) => void }
  >();

  constructor(
    @Inject(MorseSessionFactory) private readonly sessions: MorseSessionFactory,
    @Inject(MORSE_LOGGER) private readonly logger: MorseLogger,
    @Inject(MORSE_CONFIG)
    private readonly config: {
      authPassword?: string;
      authUsername?: string;
      multiuser: boolean;
    },
    @Inject(MORSE_DB) private readonly db: Knex | undefined,
  ) {}

  async handleConnection(client: WebSocket, request?: IncomingMessage): Promise<void> {
    // Multi-user: the login cookie names the connection's owner (browsers
    // replay cookies on the same-origin upgrade). No valid login means no
    // session — 4401 tells the frontend to show login instead of retrying.
    if (this.config.multiuser) {
      const user =
        request === undefined
          ? undefined
          : await authUserOfRequest(this.db, request.headers as Record<string, unknown>);
      if (user === undefined) {
        client.close(LOGIN_REQUIRED_CLOSE_CODE, 'login required');
        return;
      }
      this.serve(client, request, { user });
      return;
    }
    // Browsers replay the Basic credentials from the page load on a same-origin
    // upgrade; anything that arrives without them never reaches a session.
    if (this.config.authPassword !== undefined &&
        (request === undefined ||
         !isAuthorized(request, this.config.authPassword, this.config.authUsername))) {
      client.close(1008, 'unauthorized');
      return;
    }
    this.serve(client, request, {});
  }

  private serve(
    client: WebSocket,
    request: IncomingMessage | undefined,
    identity: { user?: AuthUser },
  ): void {
    const emit = (message: HostToClientMessage): void => {
      if (client.readyState === 1) {
        client.send(encodeWireMessage(message));
      }
    };

    // The socket's peer, so `updateHost` can refuse anyone not on this machine.
    // Nest's ws adapter hands the upgrade request as the second argument; a
    // missing one simply means the command cannot be used.
    const remoteAddress = request?.socket?.remoteAddress;
    const controller = this.sessions.createFor(emit, {
      ...(remoteAddress === undefined ? {} : { remoteAddress }),
      ...identity,
    });
    this.clients.set(client, { controller, emit });

    client.on('message', (data: RawData) => {
      void this.onMessage(controller, emit, data);
    });
    client.on('error', (error: Error) => {
      this.logger.warn('WebSocket error', error);
    });

    void controller.start().catch((error: unknown) => {
      this.logger.error('Failed to start a Morse session for a new client', error);
    });
  }

  handleDisconnect(client: WebSocket): void {
    const entry = this.clients.get(client);
    this.clients.delete(client);
    // The bot feed belongs to this socket alone; detach it before the controller
    // goes, so a closed connection is never written to by the shared service.
    if (entry !== undefined) {
      this.sessions.release(entry.controller);
    }
    // Only the connection's controller goes away; its sessions stay warm in the
    // shared registry, so a refresh reattaches to the same `pi` processes.
    void entry?.controller.dispose().catch((error: unknown) => {
      this.logger.warn('Failed to dispose a Morse session controller', error);
    });
  }

  /**
   * One client frame. A handler that throws is a bug in this host, not a reason
   * for the socket to go silent: it is logged and reported down the connection's
   * own error channel, so the reader sees that the frame failed while the rest
   * of the session keeps working.
   */
  private async onMessage(
    controller: HostSessionController,
    emit: (message: HostToClientMessage) => void,
    data: RawData,
  ): Promise<void> {
    let type = 'unknown';
    try {
      const message = parseClientMessage(data);
      if (!message) {
        this.logger.warn('Ignoring an unrecognised client message');
        return;
      }
      type = message.type;
      await controller.handleClientMessage(message);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Morse could not handle a "${type}" message`, error);
      emit({ type: 'error', payload: { message, at: Date.now() } });
    }
  }
}