import { randomUUID } from 'node:crypto';
import type { AgentEvent, ModelRef, ThinkingLevel } from '@morse/agent';
import type {
  ChatPin,
  ComposerPauseReason,
  HostToClientMessage,
  Pick,
  PromptImage,
  PromptMode,
  SharedComposerCommand,
  SharedComposerDraft,
  SharedComposerPrompt,
  SharedComposerState,
} from '@morse/protocol';
import type { MorseLogger } from '../logger.js';
import { AgentUnavailableError } from '../errors.js';
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
  setModel(model: ModelRef, sessionKey?: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel, sessionKey?: string): Promise<void>;
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
  /** A pick made mid-run, waiting for the next turn (see `SharedComposerState`). */
  pending?: Pick;
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
  /** Controllers mirror these into their per-connection busy flags, so a queued
   * compaction lights the same Working indicator the dialog's yes does. */
  private readonly compactingListeners = new Set<(sessionKey: string, active: boolean) => void>();

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

  /**
   * A compaction started or ended in the queue (a drained item, or the
   * dialog's yes mirrored back here). Controllers keep their own per-view
   * busy flags, and this is how they learn about rewrites they did not start.
   */
  subscribeCompacting(listener: (sessionKey: string, active: boolean) => void): () => void {
    this.compactingListeners.add(listener);
    return () => {
      this.compactingListeners.delete(listener);
    };
  }

  /** Every stored queue and live text, for a client that just said hello. */
  snapshot(): { states: SharedComposerState[]; drafts: SharedComposerDraft[] } {
    const states: SharedComposerState[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (session.queue.length > 0 || session.paused !== undefined || session.pending !== undefined) {
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
      case 'pick': {
        // A model pick and a thinking pick are two halves of one next turn:
        // merge them, so choosing a model then a level keeps both.
        const session = this.sessionOf(command.sessionId);
        const pending = session.pending;
        session.pending = {
          ...(pending?.model === undefined ? {} : { model: pending.model }),
          ...(pending?.thinking === undefined ? {} : { thinking: pending.thinking }),
          ...(command.pick.model === undefined ? {} : { model: command.pick.model }),
          ...(command.pick.thinking === undefined ? {} : { thinking: command.pick.thinking }),
        };
        this.changed(command.sessionId);
        return;
      }
    }
  }

  /**
   * The pick the next queued turn of this session fires on: the one stamped
   * on the item when it was queued, else whatever is pending, else nothing —
   * the session's pick in force. The first item to leave with a pending pick
   * consumes it, exactly as a send after the run would.
   */
  private takePick(sessionKey: string, item: SharedComposerPrompt): Pick | undefined {
    const pending = this.sessions.get(sessionKey)?.pending;
    if (pending === undefined) {
      return item.pick;
    }
    // The pending pick belongs to the *next* turn, whichever item that is: an
    // item stamped from it was a snapshot of the same choice, so leaving the
    // pending copy behind would apply it a second time, to the turn after.
    this.sessionOf(sessionKey).pending = undefined;
    this.broadcastState(sessionKey);
    this.persist();
    return item.pick ?? pending;
  }

  /** Applies a pick to the session right before its turn starts. */
  private async applyPick(pick: Pick | undefined, sessionKey: string): Promise<void> {
    if (pick === undefined) {
      return;
    }
    if (pick.model !== undefined) {
      await this.options.chat.setModel(
        { provider: pick.model.provider, id: pick.model.id, name: pick.model.name ?? pick.model.id },
        sessionKey,
      );
    }
    if (pick.thinking !== undefined) {
      await this.options.chat.setThinkingLevel(pick.thinking, sessionKey);
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
      if (this.compacting.has(sessionKey)) {
        return;
      }
      this.compacting.add(sessionKey);
      for (const listener of this.compactingListeners) {
        listener(sessionKey, true);
      }
      return;
    }
    if (this.compacting.delete(sessionKey)) {
      for (const listener of this.compactingListeners) {
        listener(sessionKey, false);
      }
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
      ...(item.pick ?? session.pending
        ? { pick: item.pick ?? session.pending }
        : {}),
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
    // A steer joins the run in flight, which keeps its own model; only a new
    // turn takes the pick. The stamped pick stays with the item either way.
    const pick = streaming ? undefined : this.takePick(sessionKey, item);
    const result = await this.dispatch(sessionKey, item, streaming ? 'steer' : 'new', pick);
    if (result === 'failed' || (result === 'wait' && index >= 0)) {
      // Only the session's own consumed pick returns to pending: a pick that
      // was the item's would otherwise leak onto some later, unrelated turn.
      if (pick !== undefined && item.pick === undefined) {
        this.sessionOf(sessionKey).pending = pick;
      }
      session.queue.splice(Math.min(index, session.queue.length), 0, item);
      if (result === 'failed') {
        this.failQueue(sessionKey);
      }
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
    const pick = this.takePick(sessionKey, item);
    const result = await this.dispatch(sessionKey, item, 'new', pick);
    if (result === 'failed' || result === 'wait') {
      const current = this.sessionOf(sessionKey);
      if (pick !== undefined && item.pick === undefined) {
        current.pending = pick;
      }
      current.queue.unshift(item);
      if (result === 'failed') {
        this.failQueue(sessionKey);
      }
    }
    this.dispatching.delete(sessionKey);
    this.changed(sessionKey);
  }

  /**
   * Hands one item to the agent. `sent` means it was accepted (or a
   * compaction started); `wait` means the session is not open yet, so the
   * item stays queued for its opening; `failed` means the run itself refused,
   * so the queue pauses and the reader chooses. A refusal never loses the item.
   */
  private async dispatch(
    sessionKey: string,
    item: SharedComposerPrompt,
    mode: PromptMode,
    pick?: Pick,
  ): Promise<'sent' | 'wait' | 'failed'> {
    try {
      await this.applyPick(pick, sessionKey);
      if (item.compaction !== undefined) {
        // A rewrite owns the session exactly like the dialog's yes does: the
        // flags gate queued sends and light the Working indicator, and the
        // `finally` hands both back even when the engine refuses.
        this.setCompacting(sessionKey, true);
        try {
          await this.options.chat.compact(item.compaction.instructions, sessionKey);
        } finally {
          this.setCompacting(sessionKey, false);
        }
        return 'sent';
      }
      const outcome = await this.options.chat.prompt(
        item.text,
        mode,
        item.images,
        item.pins,
        sessionKey,
      );
      if (outcome.accepted) {
        this.options.transcripts.userPrompt(sessionKey, item.text, item.images, item.pins);
        return 'sent';
      }
      // The session is not open yet: keep the item for its opening, exactly
      // like a persisted queue waiting for `agent/ready`.
      if (outcome.reason === 'no-session') {
        this.warnNotOpen();
        return 'wait';
      }
      this.options.logger.warn(
        `The queued message for ${sessionKey} was refused`,
        outcome.reason,
      );
      return 'failed';
    } catch (error) {
      // A compaction (or prompt) against a session that is not open yet is a
      // wait, not a failure: the queue keeps working once it opens.
      if (error instanceof AgentUnavailableError) {
        this.warnNotOpen();
        return 'wait';
      }
      this.options.logger.warn(
        `The queued message for ${sessionKey} could not be sent`,
        error,
      );
      return 'failed';
    }
  }

  /** A queued item whose session is not open: say so instead of failing silently. */
  private warnNotOpen(): void {
    this.broadcast({
      type: 'notice',
      payload: { level: 'warn', text: NOT_OPEN_NOTICE, at: Date.now() },
    });
  }

  /**
   * A queued item the run itself refused: pause and say so, so the reader
   * chooses instead of the queue retrying blindly on every settle. The item
   * stays at the head, ready for Continue or Send now.
   */
  private failQueue(sessionKey: string): void {
    this.pause(sessionKey, 'failed');
    this.broadcast({
      type: 'notice',
      payload: {
        level: 'error',
        text: 'That queued item failed to run — Continue retries it, Send now runs it immediately.',
        at: Date.now(),
      },
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
      ...(session?.pending === undefined ? {} : { pending: session.pending }),
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
      if (session.queue.length > 0 || session.paused !== undefined || session.pending !== undefined) {
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
  const candidate = value as { queue?: unknown; paused?: unknown; pending?: unknown };
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
  const pending = asPick(candidate.pending);
  return {
    queue,
    ...(paused === undefined ? {} : { paused }),
    ...(pending === undefined ? {} : { pending }),
  };
}

/**
 * A pick as persisted or as a client sent it. Read field by field: a model
 * with no provider or id, or a thinking level outside the known set, is
 * dropped rather than sent to an engine that would refuse it.
 */
function asPick(value: unknown): Pick | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const model = candidate['model'];
  const modelPick =
    typeof model === 'object' &&
    model !== null &&
    typeof (model as Record<string, unknown>)['provider'] === 'string' &&
    typeof (model as Record<string, unknown>)['id'] === 'string'
      ? (model as Pick['model'])
      : undefined;
  const thinking = THINKING_LEVELS.has(candidate['thinking'] as ThinkingLevel)
    ? (candidate['thinking'] as ThinkingLevel)
    : undefined;
  if (modelPick === undefined && thinking === undefined) {
    return undefined;
  }
  return {
    ...(modelPick === undefined ? {} : { model: modelPick }),
    ...(thinking === undefined ? {} : { thinking }),
  };
}

const THINKING_LEVELS = new Set<string>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

function asPrompt(value: unknown): SharedComposerPrompt | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['id'] !== 'string' || typeof candidate['text'] !== 'string') {
    return undefined;
  }
  const compaction = candidate['compaction'];
  const pick = asPick(candidate['pick']);
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
    ...(pick === undefined ? {} : { pick }),
  };
}
