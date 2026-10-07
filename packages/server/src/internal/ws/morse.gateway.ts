import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Inject } from '@nestjs/common';
import type { RawData, WebSocket } from 'ws';
import {
  DEFAULT_WS_PATH,
  encodeWireMessage,
  parseClientMessage,
  type HostToClientMessage,
} from '@morse/protocol';
import { HostSessionController } from '@morse/host-runtime';
import type { MorseLogger } from '@morse/core';
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
  private readonly clients = new Map<WebSocket, HostSessionController>();

  constructor(
    @Inject(MorseSessionFactory) private readonly sessions: MorseSessionFactory,
    @Inject(MORSE_LOGGER) private readonly logger: MorseLogger,
  ) {}

  handleConnection(client: WebSocket): void {
    const emit = (message: HostToClientMessage): void => {
      if (client.readyState === 1) {
        client.send(encodeWireMessage(message));
      }
    };

    const controller = this.sessions.createFor(emit);
    this.clients.set(client, controller);

    client.on('message', (data: RawData) => {
      void this.onMessage(controller, data);
    });
    client.on('error', (error: Error) => {
      this.logger.warn('WebSocket error', error);
    });

    void controller.start().catch((error: unknown) => {
      this.logger.error('Failed to start a Morse session for a new client', error);
    });
  }

  handleDisconnect(client: WebSocket): void {
    const controller = this.clients.get(client);
    this.clients.delete(client);
    // Only the connection's controller goes away; its sessions stay warm in the
    // shared registry, so a refresh reattaches to the same `pi` processes.
    void controller?.dispose().catch((error: unknown) => {
      this.logger.warn('Failed to dispose a Morse session controller', error);
    });
  }

  private async onMessage(controller: HostSessionController, data: RawData): Promise<void> {
    const message = parseClientMessage(data);
    if (!message) {
      this.logger.warn('Ignoring an unrecognised client message');
      return;
    }
    await controller.handleClientMessage(message);
  }
}