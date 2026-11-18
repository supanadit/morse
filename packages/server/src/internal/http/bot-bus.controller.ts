import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Optional,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { BotBusSendInput, BotDeliveryKind } from '@morse/protocol';
import { BotBusError, silentLogger, type BotBusPort, type MorseLogger } from '@morse/system';
import { MORSE_BOT_BUS, MORSE_LOGGER } from '../../app/tokens.js';

/** What the decorated route hands `call`: the socket and headers it needs. */
export interface BusRequest {
  headers: Record<string, string | undefined>;
  socket?: { remoteAddress?: string };
  ip?: string;
}

/**
 * The peer addresses that count as this machine. `::ffff:127.0.0.1` is how a
 * dual-stack listener reports an IPv4 loopback client, so refusing it would
 * refuse the plugin on a normal machine.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** The only tools this endpoint serves; `bot_ask` is deliberately absent. */
const TOOLS = new Set(['list', 'send']);

const KINDS: readonly BotDeliveryKind[] = ['message', 'assign', 'reply'];

/**
 * A refusal whose JSON body is exactly `{ error }`, and whose `message` stays
 * readable for the exception filter's log. Nest's default filter would otherwise
 * wrap a string response in `{ statusCode, message }`, which the plugins do not
 * look for.
 */
function refuse(status: number, message: string): HttpException {
  const exception = new HttpException({ error: message }, status);
  exception.message = message;
  return exception;
}

/** Header lookup that does not depend on Node lowering the name. */
function headerOf(headers: Record<string, string | undefined>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return undefined;
}

/** The `Bearer` value of `Authorization`, if the header carries one. */
function bearerToken(request: BusRequest): string | undefined {
  const header = headerOf(request.headers, 'authorization');
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token === undefined || token.length === 0 ? undefined : token;
}

/**
 * The peer this request came from, as an address the loopback set can name.
 * The socket is the authority; `req.ip` is the fallback for a request object
 * that has no socket (Nest's own test harness, a proxy adapter).
 */
function peerAddress(request: BusRequest): string | undefined {
  const remote = request.socket?.remoteAddress;
  const raw = remote === undefined || remote.length === 0 ? request.ip : remote;
  if (raw === undefined) {
    return undefined;
  }
  return raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;
}

/**
 * The three fields `bot_send` accepts, and nothing else in the body: a caller's
 * own ids and statuses are not the service's to trust. `kind` is checked here
 * because the delivery store refuses an unknown one, and a bad request from a
 * plugin should read as a bad request rather than a host failure.
 */
function readSendInput(body: unknown): BotBusSendInput {
  const row =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const to = row['to'];
  const text = row['text'];
  const kind = row['kind'];
  if (
    typeof to !== 'string' ||
    typeof text !== 'string' ||
    (kind !== undefined && !KINDS.includes(kind as BotDeliveryKind))
  ) {
    throw refuse(
      HttpStatus.BAD_REQUEST,
      'A send needs "to" and "text", and "kind" must be message, assign or reply.',
    );
  }
  return {
    to,
    text,
    ...(kind === undefined ? {} : { kind: kind as BotDeliveryKind }),
  };
}

/**
 * The one endpoint a bot's engine calls: `POST /internal/bot-bus/<tool>`.
 *
 * Two credentials make a call: a peer that is this machine, and a bearer token
 * this host minted for one bot while it started that bot's engine. The token
 * names the caller, so the body never does — a bot cannot read or write as
 * another bot, and no tool here reaches a lane, a transcript or a registry
 * write (`BotBusPort` is the whole surface).
 *
 * The body of every answer is `{ error }` when the call is refused. That is
 * deliberate: the engine plugins turn `error` into the sentence the bot reads
 * inside its turn, so a refusal ends a tool call, never the person's message.
 * A `BotBusError` is such a sentence and keeps HTTP 200; a failure Morse did not
 * plan for is logged and answered with one generic line.
 */
@Controller('internal/bot-bus')
export class BotBusController {
  constructor(
    @Optional() @Inject(MORSE_BOT_BUS) private readonly bot?: BotBusPort,
    @Optional() @Inject(MORSE_LOGGER) private readonly logger: MorseLogger = silentLogger,
  ) {}

  @Post(':tool')
  @HttpCode(HttpStatus.OK)
  route(
    @Param('tool') tool: string,
    @Body() body: unknown,
    @Req() request: BusRequest,
  ): Promise<unknown> {
    return this.call(tool, body, request);
  }

  /**
   * The endpoint's logic without the transport, so its refusals can be tested
   * directly: peer first, then host capability, then the token, then the tool.
   * Nothing a request carries reaches the service before all four pass.
   */
  async call(tool: string, body: unknown, request: BusRequest): Promise<unknown> {
    if (!LOOPBACK.has(peerAddress(request) ?? '')) {
      throw refuse(HttpStatus.FORBIDDEN, 'The bot bus accepts only local calls.');
    }
    const bot = this.bot;
    if (bot === undefined) {
      throw refuse(HttpStatus.SERVICE_UNAVAILABLE, 'Bot mode is not available on this host.');
    }
    const token = bearerToken(request);
    const username = token === undefined ? undefined : bot.resolveBusToken(token);
    if (username === undefined) {
      throw refuse(HttpStatus.UNAUTHORIZED, 'A bot bus call needs a token this host minted.');
    }
    if (!TOOLS.has(tool)) {
      throw refuse(HttpStatus.NOT_FOUND, `The bot bus has no tool "${tool}".`);
    }
    try {
      if (tool === 'list') {
        return { bots: bot.busRoster(username) };
      }
      return await bot.busSend(username, readSendInput(body));
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        // A bad request this endpoint already worded; it is not a host failure.
        throw error;
      }
      if (error instanceof BotBusError) {
        // The bot can act on this, so it rides back as the tool's own answer.
        return { error: error.reason };
      }
      this.logger.error(`The bot bus failed to "${tool}" for "${username}".`, error);
      throw refuse(HttpStatus.INTERNAL_SERVER_ERROR, 'Morse could not handle that request.');
    }
  }
}
