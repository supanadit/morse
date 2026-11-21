import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@morse/agent';
import type {
  ChatPin,
  ComposerPauseReason,
  HostToClientMessage,
  PromptImage,
  PromptMode,
  SharedComposerCommand,
  SharedComposerDraft,
  SharedComposerPrompt,
  SharedComposerState,
} from '@morse/protocol';
import type { MorseLogger } from '../logger.js';
import { readComposer, saveComposer } from './workbench-store.js';

/** The one chat surface the hub needs; `ChatService` satisfies it. */
export interface ComposerChat {
  prompt(
    text: string,
    mode?: PromptMode,
    images?: PromptImage[],
    pins?: ChatPin[],
    sessionKey?: string,
  ): Promise<{ accepted: boolean; reason?: string }>;
  compact(instructions?: string, sessionKey?: string): Promise<void>;
}

/** The transcript sink a dispatched prompt writes its user row through. */
export interface ComposerTranscripts {
  userPrompt(
    sessionKey: string,
    text: string,
    images?: PromptImage[],
    pins?: ChatPin[],
  ): void;
}

/** The registry slice the hub reads: live events and a session's current state. */
export interface ComposerRegistry {
  subscribe(listener: (tagged: { sessionKey: string; event: AgentEvent }) => void): () => void;
  stateOf(key: string): { streaming: boolean } | undefined;
}

export interface ComposerHubOptions {
  chat: ComposerChat;
  transcripts: ComposerTranscripts;
  registry: ComposerRegistry;
  dataDir: string;
  logger: MorseLogger;
}

interface HubSession {
  queue: SharedComposerPrompt[];
  paused?: ComposerPauseReason;
}

const COMPOSER_VERSION = 1;
const NOT_OPEN_NOTICE =
  'That session is not open yet — open it before sending its queued message.';

/**
 * The host-owned composer queue and the live draft relay.
 *
 * The queue used to live in each browser: closing a tab deleted it, a reload lost
 * it, and two devices could not see each other's. Here one instance owns every
 * session's queue and pause flag, dispatches on the shared registry's run events,
 * persists to `<data dir>/composer.json`, and broadcasts to every connected
 * client. It is the only dispatcher, so two devices can never send the same item.
 *
 * A run that settles naturally drains the queue. A Stop the reader asked for, or
 * a run that failed, pauses it: the reader chooses whether to continue the
 * interrupted answer or send the queued item. `aborted` alone is not a stop —
 * pi compacts by aborting the run in flight — so the pause needs the explicit
 * marker `requestStop` leaves.
 *
 * Text is relayed, not persisted here: every device already saves its draft to
 * `drafts.json`, and the relay keeps those files converged. A device that
 * connects mid-sentence receives the hub's current text with the snapshot.
 */
export class ComposerHub {
  private readonly sessions = new Map<string, HubSession>();
  /** The last text each session's composer showed, for the connect snapshot. */
  private readonly texts = new Map<string, string>();
  private readonly stopRequested = new Set<string>();
  private readonly dispatching = new Set<string>();
  /** Sessions whose context rewrite is in flight; their queues wait for it. */
  private readonly compacting = new Set<string>();
  private readonly listeners = new Set<(message: HostToClientMessage) => void>();

  constructor(private readonly options: ComposerHubOptions) {
    this.load();
    options.registry.subscribe(({ sessionKey, event }) => {
      void this.onEvent(sessionKey, event);
    });
  }

  /** One socket's broadcast receiver; the caller unsubscribes on disconnect. */
  subscribe(listener: (message: HostToClientMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Every stored queue and live text, for a client that just said hello. */
  snapshot(): { states: SharedComposerState[]; drafts: SharedComposerDraft[] } {
    const states: SharedComposerState[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (session.queue.length > 0 || session.paused !== undefined) {
        states.push(this.stateOf(sessionId));
      }
    }
    const drafts: SharedComposerDraft[] = [];
    for (const [sessionId, text] of this.texts) {
      drafts.push({ sessionId, text, origin: '' });
    }
    return { states, drafts };
  }

  /**
   * A Stop is about to be sent. Marks this session's next run-end as the
   * reader's, so a compaction's internal abort does not pause the queue. Returns
   * the undo the abort path calls when the abort itself fails.
   */
  requestStop(sessionKey: string | undefined): () => void {
    if (sessionKey === undefined || this.options.registry.stateOf(sessionKey)?.streaming !== true) {
      return () => undefined;
    }
    this.stopRequested.add(sessionKey);
    return () => {
      this.stopRequested.delete(sessionKey);
    };
  }

  /** Relays the composer text of one session to the other connected devices. */
  setDraft(draft: SharedComposerDraft): void {
    if (draft.sessionId.length === 0) {
      return;
    }
    this.texts.set(draft.sessionId, draft.text);
    this.broadcast({ type: 'composer/draft', payload: draft });
  }

  /** One queue request from any client. */
  handle(command: SharedComposerCommand): void {
    switch (command.action) {
      case 'enqueue':
        this.enqueue(command.sessionId, command.item);
        return;
      case 'remove':
        this.remove(command.sessionId, command.itemId);
        return;
      case 'move':
        this.move(command.sessionId, command.itemId, command.targetId);
        return;
      case 'send':
        void this.sendNow(command.sessionId, command.itemId);
        return;
      case 'continue':
        this.resume(command.sessionId);
        void this.drain(command.sessionId);
        return;
      case 'resume':
        this.resume(command.sessionId);
        return;
    }
  }

  /** A deleted session's queue has nowhere to return to. */
  forget(sessionKey: string): void {
    if (!this.sessions.has(sessionKey) && !this.texts.has(sessionKey)) {
      return;
    }
    this.sessions.delete(sessionKey);
    this.texts.delete(sessionKey);
    this.stopRequested.delete(sessionKey);
    this.dispatching.delete(sessionKey);
    this.broadcastState(sessionKey);
    this.persist();
  }

  /**
   * The controller tells the hub when a compaction starts and ends in one
   * session. The gate is per session: a rewrite in A cannot hold B's queue,
   * and a queued message cannot jump ahead of the rewrite it was typed during.
   */
  setCompacting(sessionKey: string, active: boolean): void {
    if (active) {
      this.compacting.add(sessionKey);
      return;
    }
    if (this.compacting.delete(sessionKey)) {
      // The rewrite's own run-end may have come before it was marked busy, so
      // nothing else will wake a queue that was held back until now.
      void this.drain(sessionKey);
    }
  }

  private async onEvent(sessionKey: string, event: AgentEvent): Promise<void> {
    if (event.type === 'agent/ready') {
      // A persisted queue waits for its session to be opened, then continues.
      await this.drain(sessionKey);
      return;
    }
    if (event.type === 'agent/run-end') {
      if (this.stopRequested.delete(sessionKey)) {
        this.pause(sessionKey, 'stopped');
        return;
      }
      if (event.reason === 'error') {
        this.pause(sessionKey, 'failed');
        return;
      }
      // `settled`, and an `aborted` nobody asked the reader for (a compaction's
      // internal abort, an engine switch): the queue keeps moving.
      await this.drain(sessionKey);
      return;
    }
    if (event.type === 'agent/fatal') {
      this.pause(sessionKey, 'failed');
    }
  }

  private enqueue(sessionKey: string, item: SharedComposerCommandItem): void {
    const session = this.sessionOf(sessionKey);
    session.queue.push({
      id: randomUUID(),
      text: item.text,
      ...(item.images === undefined ? {} : { images: item.images }),
      ...(item.pins === undefined ? {} : { pins: item.pins }),
      ...(item.compaction === undefined ? {} : { compaction: item.compaction }),
    });
    this.changed(sessionKey);
    // The run can settle between the keypress and this command: an idle session
    // must not leave the item waiting for a run-end that already happened.
    if (session.paused === undefined) {
      void this.drain(sessionKey);
    }
  }

  private remove(sessionKey: string, itemId: string): void {
    const session = this.sessions.get(sessionKey);
    if (session === undefined) {
      return;
    }
    const next = session.queue.filter((item) => item.id !== itemId);
    if (next.length === session.queue.length) {
      return;
    }
    session.queue = next;
    if (next.length === 0) {
      session.paused = undefined;
    }
    this.changed(sessionKey);
  }

  private move(sessionKey: string, itemId: string, targetId: string): void {
    const session = this.sessions.get(sessionKey);
    if (session === undefined || itemId === targetId) {
      return;
    }
    const from = session.queue.findIndex((item) => item.id === itemId);
    const to = session.queue.findIndex((item) => item.id === targetId);
    if (from === -1 || to === -1) {
      return;
    }
    const [moved] = session.queue.splice(from, 1);
    if (moved === undefined) {
      return;
    }
    const target = session.queue.findIndex((item) => item.id === targetId);
    session.queue.splice(from < to ? target + 1 : target, 0, moved);
    this.changed(sessionKey);
  }

  private async sendNow(sessionKey: string, itemId: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (session === undefined || this.compacting.has(sessionKey)) {
      // A rewrite owns the session: leave the item queued, ready to run after.
      return;
    }
    const index = session.queue.findIndex((item) => item.id === itemId);
    if (index === -1) {
      return;
    }
    const [item] = session.queue.splice(index, 1);
    if (item === undefined) {
      return;
    }
    session.paused = undefined;
    const streaming = this.options.registry.stateOf(sessionKey)?.streaming === true;
    const sent = await this.dispatch(sessionKey, item, streaming ? 'steer' : 'new');
    if (!sent && index >= 0) {
      session.queue.splice(Math.min(index, session.queue.length), 0, item);
    }
    this.changed(sessionKey);
  }

  private resume(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (session === undefined || session.paused === undefined) {
      return;
    }
    session.paused = undefined;
    this.changed(sessionKey);
  }

  private pause(sessionKey: string, reason: ComposerPauseReason): void {
    const session = this.sessions.get(sessionKey);
    if (session === undefined || session.queue.length === 0 || session.paused === reason) {
      return;
    }
    session.paused = reason;
    this.changed(sessionKey);
  }

  /**
   * Sends the head, one item per settle. A session that is not hot is left alone:
   * its queue waits for `agent/ready` (a persisted queue that has just been
   * opened) or for an explicit send.
   */
  private async drain(sessionKey: string): Promise<void> {
    if (this.dispatching.has(sessionKey)) {
      return;
    }
    const session = this.sessions.get(sessionKey);
    if (session === undefined || session.paused !== undefined || session.queue.length === 0) {
      return;
    }
    const state = this.options.registry.stateOf(sessionKey);
    if (this.compacting.has(sessionKey) || state === undefined || state.streaming) {
      return;
    }
    const item = session.queue[0];
    if (item === undefined) {
      return;
    }
    this.dispatching.add(sessionKey);
    session.queue = session.queue.slice(1);
    this.changed(sessionKey);
    const sent = await this.dispatch(sessionKey, item, 'new');
    if (!sent) {
      const current = this.sessionOf(sessionKey);
      current.queue.unshift(item);
    }
    this.dispatching.delete(sessionKey);
    this.changed(sessionKey);
  }

  /**
   * Hands one item to the agent. `true` when it was accepted (or a compaction
   * started); a refusal keeps the caller's item so nothing is lost.
   */
  private async dispatch(
    sessionKey: string,
    item: SharedComposerPrompt,
    mode: PromptMode,
  ): Promise<boolean> {
    try {
      if (item.compaction !== undefined) {
        await this.options.chat.compact(item.compaction.instructions, sessionKey);
        return true;
      }
      const outcome = await this.options.chat.prompt(
        item.text,
        mode,
        item.images,
        item.pins,
        sessionKey,
      );
      if (!outcome.accepted) {
        this.warnNotOpen();
        return false;
      }
      this.options.transcripts.userPrompt(sessionKey, item.text, item.images, item.pins);
      return true;
    } catch (error) {
      this.options.logger.warn(
        `The queued message for ${sessionKey} could not be sent`,
        error,
      );
      this.warnNotOpen();
      return false;
    }
  }

  /** A queued item whose session is not open: say so instead of failing silently. */
  private warnNotOpen(): void {
    this.broadcast({
      type: 'notice',
      payload: { level: 'warn', text: NOT_OPEN_NOTICE, at: Date.now() },
    });
  }

  private sessionOf(sessionKey: string): HubSession {
    let session = this.sessions.get(sessionKey);
    if (session === undefined) {
      session = { queue: [] };
      this.sessions.set(sessionKey, session);
    }
    return session;
  }

  private stateOf(sessionKey: string): SharedComposerState {
    const session = this.sessions.get(sessionKey);
    return {
      sessionId: sessionKey,
      queue: session?.queue ?? [],
      ...(session?.paused === undefined ? {} : { paused: session.paused }),
    };
  }

  /** Persists and tells every client. */
  private changed(sessionKey: string): void {
    this.broadcastState(sessionKey);
    this.persist();
  }

  private broadcastState(sessionKey: string): void {
    this.broadcast({ type: 'composer/state', payload: this.stateOf(sessionKey) });
  }

  private broadcast(message: HostToClientMessage): void {
    for (const listener of [...this.listeners]) {
      listener(message);
    }
  }

  private load(): void {
    let saved;
    try {
      saved = readComposer(this.options.dataDir);
    } catch {
      return;
    }
    if (saved === undefined) {
      return;
    }
    const sessions = (saved.data as { sessions?: unknown } | undefined)?.sessions;
    if (typeof sessions !== 'object' || sessions === null) {
      return;
    }
    for (const [sessionId, value] of Object.entries(sessions)) {
      const parsed = asHubSession(value);
      if (parsed !== undefined) {
        this.sessions.set(sessionId, parsed);
      }
    }
  }

  private persist(): void {
    const sessions: Record<string, HubSession> = {};
    for (const [sessionId, session] of this.sessions) {
      if (session.queue.length > 0 || session.paused !== undefined) {
        sessions[sessionId] = session;
      }
    }
    try {
      saveComposer(this.options.dataDir, {
        version: COMPOSER_VERSION,
        data: { sessions },
      });
    } catch (error) {
      this.options.logger.warn('The composer queue could not be saved', error);
    }
  }
}

type SharedComposerCommandItem = Extract<
  SharedComposerCommand,
  { action: 'enqueue' }
>['item'];

/** One persisted entry, accepted only when its queue items have the right shape. */
function asHubSession(value: unknown): HubSession | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as { queue?: unknown; paused?: unknown };
  if (!Array.isArray(candidate.queue)) {
    return undefined;
  }
  const queue: SharedComposerPrompt[] = [];
  for (const entry of candidate.queue) {
    const item = asPrompt(entry);
    if (item === undefined) {
      return undefined;
    }
    queue.push(item);
  }
  const paused =
    candidate.paused === 'stopped' || candidate.paused === 'failed' ? candidate.paused : undefined;
  return {
    queue,
    ...(paused === undefined ? {} : { paused }),
  };
}

function asPrompt(value: unknown): SharedComposerPrompt | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['id'] !== 'string' || typeof candidate['text'] !== 'string') {
    return undefined;
  }
  const compaction = candidate['compaction'];
  return {
    id: candidate['id'],
    text: candidate['text'],
    ...(Array.isArray(candidate['images'])
      ? { images: candidate['images'] as PromptImage[] }
      : {}),
    ...(Array.isArray(candidate['pins']) ? { pins: candidate['pins'] as ChatPin[] } : {}),
    ...(typeof compaction === 'object' && compaction !== null
      ? { compaction: compaction as { instructions?: string } }
      : {}),
  };
}
