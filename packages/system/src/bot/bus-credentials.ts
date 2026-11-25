import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BotDelivery } from '@morse/protocol';
import { isBusTurnContext, isSafeUsername, type BusTurnContext } from './helpers.js';

/**
 * The credentials a bot's engine calls the bus back with: the bearer token it
 * was handed when it started, and the turn context file its plugin reads while
 * it answers.
 *
 * Both are keyed by username because both live in that bot's config directory,
 * and both are held in memory in the direction that matters: a token names its
 * bot, and a restart revokes what the previous process handed out.
 */
export interface BotBusCredentialsOptions {
  /** `<dataDir>/bot`: one directory per bot. */
  root: string;
  /** Refuses a username with no bot, so a token always names a live one. */
  assertBot(username: string): void;
}

/** The token and turn files one bot's engine is given, under its config dir. */
export class BotBusCredentials {
  /**
   * The bus token each bot's engine was started with, in both directions: a
   * token names its bot, and a bot's token is replaced when it is minted again.
   */
  private readonly tokens = new Map<string, string>();
  private readonly tokenOf = new Map<string, string>();

  constructor(private readonly options: BotBusCredentialsOptions) {}

  /** Where one bot's bus credentials live: the mint and the turn writer agree here. */
  paths(username: string): { tokenFile: string; turnFile: string } {
    // The username names a directory and both credentials are read from it, so
    // a value that could step outside the data dir is refused here rather than
    // trusted from a caller.
    if (!isSafeUsername(username)) {
      throw new Error(`"${username}" is not a usable username.`);
    }
    const config = join(join(this.options.root, username), 'config');
    return {
      tokenFile: join(config, '.morse-bus-token'),
      turnFile: join(config, '.morse-bus-turn.json'),
    };
  }

  /** Mints a bot's token, replacing whatever token it had. */
  issue(username: string): string {
    this.options.assertBot(username);
    this.forget(username);
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, username);
    this.tokenOf.set(username, token);
    const { tokenFile } = this.paths(username);
    writeFileSync(tokenFile, token, { mode: 0o600 });
    // The mode applies when the file is created; a file a crash left behind keeps
    // its own, and this credential must be private either way.
    chmodSync(tokenFile, 0o600);
    return token;
  }

  /** The bot a bearer token names, or `undefined` for a token this host never minted. */
  resolve(token: string): string | undefined {
    return this.tokens.get(token);
  }

  forget(username: string): void {
    const token = this.tokenOf.get(username);
    if (token === undefined) {
      return;
    }
    this.tokens.delete(token);
    this.tokenOf.delete(username);
  }

  /**
   * Writes the context file a bot's plugin reads during one turn: the delivery,
   * the room it names, the trigger it descends from and the hop count — none of
   * which the bot has to state, so none of which it can get wrong.
   */
  writeTurn(username: string, delivery: BotDelivery): void {
    const { turnFile } = this.paths(username);
    const context: BusTurnContext = {
      deliveryId: delivery.id,
      conversationId: delivery.conversationId,
      rootId: delivery.rootId,
      depth: delivery.depth,
      // Turns have no deadline; the plugins' liveness check only needs a finite
      // future value, while the host still refuses a hand-written past one.
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
    writeFileSync(turnFile, JSON.stringify(context), { mode: 0o600 });
    // Same rule as the token: a file left by a crash must not stay group-readable.
    chmodSync(turnFile, 0o600);
  }

  clearTurn(username: string): void {
    rmSync(this.paths(username).turnFile, { force: true });
  }

  readTurn(username: string): BusTurnContext | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.paths(username).turnFile, 'utf8'));
    } catch {
      // Missing, half-written or unreadable: one refusal, and no room to guess.
      return undefined;
    }
    return isBusTurnContext(parsed) ? parsed : undefined;
  }

  /** Credentials die with the process that handed them out. */
  clear(): void {
    this.tokens.clear();
    this.tokenOf.clear();
  }
}
