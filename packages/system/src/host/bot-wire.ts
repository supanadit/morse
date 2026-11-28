import type { BotControllerPort, MorseLogger } from '@morse/system';
import type { ClientToHostMessage, HostToClientMessage } from '@morse/protocol';
import { describeError } from '../errors.js';
import { noticeMessage } from './view-state.js';

/** A value the controller accepted after validating it against something. */
interface GuardedOk<T> {
  ok: true;
  value: T;
}

/** A value the controller refused; the caller answers with its own error. */
interface GuardedFailed {
  ok: false;
}

export type Guarded<T> = GuardedOk<T> | GuardedFailed;

/**
 * What bot mode's wire needs from its host: the port itself, where notices go,
 * and where a failure is logged. Read through on every call rather than copied,
 * because a reattached client swaps the emitter.
 */
export interface BotWirePort {
  readonly bot?: BotControllerPort;
  readonly emit: (message: HostToClientMessage) => void;
  readonly logger: MorseLogger;
}

export class BotWire {
  constructor(private readonly port: BotWirePort) {}

  /**
   * Bot mode's client requests, delegated to the host's bot port.
   *
   * Everything here is a projection of what `BotService` already does: the roster
   * is read back after a mutation, an open asks for the full in-memory
   * transcript, and a probe echoes the wizard's `requestId` so its dialog can
   * match the answer. `bot/send` is deliberately not awaited — one round can run
   * for minutes, and the transport must keep reading the reader's Stop while it
   * does. Its refusal (a round already in flight) is a notice, never a throw at
   * the socket.
   */
  async handle(message: ClientToHostMessage): Promise<void> {
    const bot = this.port.bot;
    if (bot === undefined) {
      return;
    }
    // The name is read before narrowing: the fallthrough below has no case left
    // to narrow against.
    const type: string = message.type;
    switch (message.type) {
      case 'bot/list':
        this.emitRoster(bot);
        return;
      case 'bot/create':
        // `requestId` rides on the payload for the wizard's own bookkeeping; the
        // service ignores it and the answer is the roster, which is what the
        // wizard's list is drawn from.
        await this.runAction(() => bot.createBot(message.payload));
        return;
      case 'bot/delete':
        await this.runAction(() => bot.deleteBot(message.payload.name));
        return;
      case 'bot/inspect': {
        // A read, so the answer is the config itself rather than a roster: the
        // wizard only needs the one bot the reader asked to edit.
        const result = await this.guard(() => bot.inspectBot(message.payload.name));
        if (result.ok) {
          this.port.emit({ type: 'bot/config', payload: result.value });
        }
        return;
      }
      case 'bot/update':
        await this.runAction(() => bot.updateBot(message.payload));
        return;
      case 'bot/groupCreate':
        await this.runAction(() => bot.createGroup(message.payload));
        return;
      case 'bot/groupUpdate':
        await this.runAction(() => bot.updateGroup(message.payload));
        return;
      case 'bot/groupDelete':
        await this.runAction(() => bot.deleteGroup(message.payload.id));
        return;
      case 'bot/threadDelete':
        await this.runAction(() => bot.deleteThread(message.payload.id));
        return;
      case 'bot/probeModels': {
        const { requestId, kind } = message.payload;
        const result = await this.guard(() =>
          bot.probeModels(
            kind,
            message.payload.envVars,
            message.payload.credentials,
            message.payload.env,
            message.payload.useGoAuth,
          ),
        );
        if (result.ok) {
          this.port.emit({
            type: 'bot/models',
            payload: { requestId, kind, models: result.value },
          });
        }
        return;
      }
      case 'bot/discoverModels': {
        const { requestId, baseUrl, credential } = message.payload;
        const result = await this.guard(() => bot.discoverModels(baseUrl, credential));
        if (result.ok) {
          this.port.emit({
            type: 'bot/models',
            payload: {
              requestId,
              kind: 'discover',
              // Discovered entries carry no engine provider: the wizard knows the
              // record id it asked about and binds the choice to that provider.
              models: result.value.map((model) => ({
                provider: 'discover',
                id: model.id,
                name: model.name ?? model.id,
                ...(model.contextWindow === undefined
                  ? {}
                  : { contextWindow: model.contextWindow }),
                ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
              })),
            },
          });
        }
        return;
      }
      case 'bot/open': {
        const { conversationId, limit } = message.payload;
        // The newest page of the transcript, replacing whatever the client held:
        // a conversation is reopened at its end, not at its beginning.
        const page = bot.open(conversationId, limit);
        this.port.emit({
          type: 'bot/transcript',
          payload: {
            conversationId,
            entries: page.entries,
            replace: true,
            hasMore: page.hasMore,
          },
        });
        // The two facts the service only pushes when they change: a client that
        // arrives (or comes back) mid-round has to be told them, or the chat shows
        // nothing happening while a bot is still working — and the composer's ring
        // stays empty over a conversation that already has counters.
        const routing = bot.routing(conversationId);
        this.port.emit({
          type: 'bot/routing',
          payload: { conversationId, state: routing },
        });
        const usages = bot.usages(conversationId);
        for (const usage of usages) {
          this.port.emit({ type: 'bot/usage', payload: usage });
        }
        return;
      }
      case 'bot/history': {
        const { conversationId, before, limit } = message.payload;
        // Scrolling up: the page before the oldest line the client holds, put in
        // front of it rather than replacing anything.
        const page = bot.history(conversationId, before, limit);
        this.port.emit({
          type: 'bot/transcript',
          payload: {
            conversationId,
            entries: page.entries,
            replace: false,
            prepend: true,
            hasMore: page.hasMore,
          },
        });
        return;
      }
      case 'bot/send': {
        // Attachments travel with the line rather than through an upload round
        // trip: the host writes files into the bot's own workspace on the way in.
        const images = message.payload.images;
        const files = message.payload.files;
        const attachments = {
          ...(images === undefined || images.length === 0 ? {} : { images }),
          ...(files === undefined || files.length === 0 ? {} : { files }),
        };
        void bot
          .send(message.payload.conversationId, message.payload.text, attachments)
          .catch((error: unknown) => this.emitFailure(error));
        return;
      }
      case 'bot/stop':
        // A reader's stop ends what the room sent to threads too, or the next
        // answer handed back would wake it again.
        bot.stop(message.payload.conversationId, message.payload.username, true);
        this.emitRoster(bot);
        return;
      case 'bot/newDiscussion':
        await this.runAction(() => bot.newDiscussion(message.payload.conversationId));
        return;
      case 'bot/clear':
        // The service pushes the emptied transcript itself (`replace` with no
        // lines), so the client's page is cleared by the same path that clears
        // the file; the roster is republished because the prune also ends any
        // round, and a warm bot goes cold with it.
        await this.runAction(() => bot.clear(message.payload.conversationId));
        return;
      case 'bot/compact':
        // Compaction is a model call per member, so it is awaited like any other
        // bot mutation: the round of notes and counters it writes arrives through
        // the service's own pushes.
        await this.runAction(() => bot.compact(message.payload.conversationId));
        return;
      default:
        // A `bot/*` request this controller does not route (a newer frontend on
        // an older host): said out loud, the way an unknown host command is.
        this.port.emit(noticeMessage('warn', `This host does not support "${type}".`, Date.now()));
        return;
    }
  }

  /** Runs a bot mutation, then republishes the roster it changed. */
  private async runAction(action: () => unknown | Promise<unknown>): Promise<void> {
    const bot = this.port.bot;
    const result = await this.guard(action);
    if (result.ok && bot !== undefined) {
      this.emitRoster(bot);
    }
  }

  /** Pushes the roster as the one message every bot surface redraws from. */
  private emitRoster(bot: BotControllerPort): void {
    this.port.emit({ type: 'bot/roster', payload: bot.roster() });
  }

  /**
   * A bot request failed. It belongs to the bot panel, not to the chat transcript
   * in front, so it is a notice and a log line — never the wire `error` channel,
   * which the frontend reads as a refused connection.
   */
  private emitFailure(error: unknown): void {
    const message = describeError(error);
    this.port.logger.error(`Bot request failed: ${message}`, error);
    this.port.emit(noticeMessage('error', message, Date.now()));
  }

  /** `guard`, for a bot port: the same refusal as a value, without touching the chat. */
  private async guard<T>(action: () => T | Promise<T>): Promise<Guarded<T>> {
    try {
      return { ok: true, value: await action() };
    } catch (error: unknown) {
      this.emitFailure(error);
      return { ok: false };
    }
  }
}
