/**
 * Frontend -> host: every message a client sends.
 */

import type {
  ChatPin,
  FrontendIdentity,
  InteractionResponse,
  PromptImage,
  ThinkingLevel,
} from '../dto.js';
import type { HostCommand, PromptMode } from './host.js';

/**
 * The shape every frontend -> host message shares. Same pattern as
 * `HostMessageBase`, and the same reason: a message a caller can name.
 */
export interface ClientMessageBase {
  type: string;
  payload: unknown;
}

export interface ClientReadyMessage extends ClientMessageBase {
  type: 'client/ready';
  payload: { protocolVersion: number; frontend?: FrontendIdentity };
}

export interface ChatPromptMessage extends ClientMessageBase {
  type: 'chat/prompt';
  payload: {
    text: string;
    mode?: PromptMode;
    images?: PromptImage[];
    pins?: ChatPin[];
    /**
     * A live session other than the host's active one, so a queued follow-up can
     * run in the background without switching the panel to it. Omitted when the
     * prompt belongs to the session in front (the common case).
     */
    sessionKey?: string;
  };
}

/**
 * Replaces a past user message: the host forks the conversation before it, drops
 * that turn, and sends the edited text as a new prompt. `itemId` is the transcript
 * item being edited; `text` is what the user typed in its place.
 */
export interface ChatEditMessage extends ClientMessageBase {
  type: 'chat/edit';
  payload: { itemId: string; text: string };
}

/**
 * Branches a new session before a past user message: the host forks the
 * conversation (pi's `fork`), leaves the old branch resumable, and re-homes the
 * transcript onto the new branch with an empty tail. Then it seeds the composer
 * with the forked prompt (`composer/seed`).
 */
export interface ChatForkMessage extends ClientMessageBase {
  type: 'chat/fork';
  payload: { itemId: string };
}

export interface ChatAbortMessage extends ClientMessageBase {
  type: 'chat/abort';
  payload: Record<string, never>;
}

export interface SessionNewMessage extends ClientMessageBase {
  type: 'session/new';
  payload: { cwd?: string };
}

export interface SessionLoadMessage extends ClientMessageBase {
  type: 'session/load';
  payload: { sessionId: string; cwd?: string };
}

export interface SessionActivateMessage extends ClientMessageBase {
  type: 'session/activate';
  payload: { sessionId: string; cwd?: string };
}

export interface SessionCloseMessage extends ClientMessageBase {
  type: 'session/close';
  payload: { sessionId: string };
}

/**
 * Deletes a session and its stored conversation for good. Closing only retires
 * the agent process (the session stays resumable); deleting removes the session
 * file. What that means per host is the catalog's business.
 */
export interface SessionDeleteMessage extends ClientMessageBase {
  type: 'session/delete';
  payload: { sessionId: string };
}

/**
 * Summarizes one session's context. `sessionKey` pins it to the conversation the
 * question was asked about; omitted, it means "whatever is in front", the shared
 * panel's behaviour. `schedule` asks the host to wait instead: pi compacts by
 * aborting the run in flight, so a conversation still working (with queued
 * follow-ups) gets its compaction when that run settles.
 */
export interface SessionCompactMessage extends ClientMessageBase {
  type: 'session/compact';
  payload: { instructions?: string; sessionKey?: string; schedule?: boolean };
}

export interface HistoryLoadMessage extends ClientMessageBase {
  type: 'history/load';
  payload: Record<string, never>;
}

export interface SessionListRequestMessage extends ClientMessageBase {
  type: 'session/list';
  payload: {
    /**
     * Fetch more of this project's sessions instead of the whole catalog.
     * Omitted, the host publishes the first page of every project. The host owns
     * the page size and cursor, so the caller only names the project.
     */
    cwd?: string;
  };
}

/**
 * Re-reads the resources the composer's palette lists. pi caches its prompt
 * templates at spawn, so a newly added template is invisible until this — the
 * host re-reads the template files and answers with a fresh `session/state`.
 */
export interface CommandsRefreshMessage extends ClientMessageBase {
  type: 'commands/refresh';
  payload: Record<string, never>;
}

/**
 * Re-reads the model catalog. pi caches its configured models while a session is
 * warm, so a model added to `models.json` is invisible until this — the host
 * re-reads it and answers with a fresh `session/state`.
 */
export interface ModelsRefreshMessage extends ClientMessageBase {
  type: 'models/refresh';
  payload: Record<string, never>;
}

/**
 * Re-reads the modes the harness offers. OpenCode keeps its primary agents in
 * configuration, so a newly added mode is invisible until this — the host
 * re-reads the catalog and answers with a fresh `session/state`.
 */
export interface ModesRefreshMessage extends ClientMessageBase {
  type: 'modes/refresh';
  payload: Record<string, never>;
}

/**
 * Picks the engine a new session starts in. Only meaningful while the panel is
 * the empty draft; a running session's engine is fixed by its record.
 */
export interface EngineSetMessage extends ClientMessageBase {
  type: 'engine/set';
  payload: { kind: string };
}

/** Picks the named way of working for a draft or a running session. */
export interface ModeSetMessage extends ClientMessageBase {
  type: 'mode/set';
  payload: { mode: string };
}

export interface ProjectListRequestMessage extends ClientMessageBase {
  type: 'project/list';
  payload: Record<string, never>;
}

export interface ProjectOpenMessage extends ClientMessageBase {
  type: 'project/open';
  payload: { path: string };
}

export interface ModelSetMessage extends ClientMessageBase {
  type: 'model/set';
  payload: { provider: string; id: string };
}

export interface ThinkingSetMessage extends ClientMessageBase {
  type: 'thinking/set';
  payload: { level: ThinkingLevel };
}

export interface InteractionRespondMessage extends ClientMessageBase {
  type: 'interaction/respond';
  payload: InteractionResponse;
}

export interface HostCommandMessage extends ClientMessageBase {
  type: 'host/command';
  payload: { command: HostCommand; args?: Record<string, unknown>; requestId?: string };
}

/**
 * Starts an interactive shell in the viewing session's directory (or `cwd`) and
 * streams it back as `terminal/output` / `terminal/exit`.
 */
export interface TerminalOpenMessage extends ClientMessageBase {
  type: 'terminal/open';
  payload: { terminalId: string; cwd?: string; cols?: number; rows?: number };
}

/** Keystrokes (or a pasted line) for a running terminal. */
export interface TerminalInputMessage extends ClientMessageBase {
  type: 'terminal/input';
  payload: { terminalId: string; data: string };
}

/** The viewer's terminal was resized; the shell gets the new geometry. */
export interface TerminalResizeMessage extends ClientMessageBase {
  type: 'terminal/resize';
  payload: { terminalId: string; cols: number; rows: number };
}

/** Closes a terminal and kills its shell. */
export interface TerminalCloseMessage extends ClientMessageBase {
  type: 'terminal/close';
  payload: { terminalId: string };
}

/** Frontend -> host. */
export type ClientToHostMessage =
  | ClientReadyMessage
  | ChatPromptMessage
  | ChatEditMessage
  | ChatForkMessage
  | ChatAbortMessage
  | SessionNewMessage
  | SessionLoadMessage
  | SessionActivateMessage
  | SessionCloseMessage
  | SessionDeleteMessage
  | SessionCompactMessage
  | HistoryLoadMessage
  | SessionListRequestMessage
  | CommandsRefreshMessage
  | ModelsRefreshMessage
  | ModesRefreshMessage
  | ProjectListRequestMessage
  | ProjectOpenMessage
  | EngineSetMessage
  | ModeSetMessage
  | ModelSetMessage
  | ThinkingSetMessage
  | InteractionRespondMessage
  | HostCommandMessage
  | TerminalOpenMessage
  | TerminalInputMessage
  | TerminalResizeMessage
  | TerminalCloseMessage;

