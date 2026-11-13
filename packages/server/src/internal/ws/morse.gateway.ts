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
  encodeWireMessage,
  parseClientMessage,
  type HostToClientMessage,
} from '@morse/protocol';
import { HostSessionController } from '@morse/system';
import type { MorseLogger } from '@morse/system';
import { MORSE_LOGGER } from '../../app/tokens.js';
import { MorseSessionFactory } from './session-factory.service.js';

/**
 * Driving adapter: one WebSocket per client, one controller per connection, and
 * a shared session registry — so sessions in several projects keep running while
 * clients connect, refresh or disconnect. Everything protocol-shaped is
 * delegated to `HostSessionController`, which the VS Code host also uses.
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
  ) {}

  handleConnection(client: WebSocket, request?: IncomingMessage): void {
    const emit = (message: HostToClientMessage): void => {
      if (client.readyState === 1) {
        client.send(encodeWireMessage(message));
      }
    };

    // The socket's peer, so `updateHost` can refuse anyone not on this machine.
    // Nest's ws adapter hands the upgrade request as the second argument; a
    // missing one simply means the command cannot be used.
    const remoteAddress = request?.socket?.remoteAddress;
    const controller = this.sessions.createFor(emit, remoteAddress);
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