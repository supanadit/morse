import type {
  ChatPin,
  ComposerSeed,
  FrontendIdentity,
  HostCapabilities,
  InteractionRequest,
  InteractionResponse,
  NoticeLevel,
  ProjectSummary,
  PromptImage,
  SessionActivity,
  SessionSummary,
  SessionViewState,
  ThinkingLevel,
  TranscriptItem,
} from './dto.js';

export type PromptMode = 'new' | 'steer' | 'followUp';

export type HostCommand =
  | 'listFiles'
  | 'listDirectories'
  | 'uploadFile'
  | 'openSettings'
  | 'showOutput'
  | 'copyToClipboard'
  | 'insertIntoEditor'
  | 'revealFile'
  | 'getEditorContext'
  /** Ask the host to confirm a destructive action in its own dialog. */
  | 'confirmDeleteSession';

/** Host -> frontend. */
export type HostToClientMessage =
  | {
      type: 'host/ready';
      payload: {
        protocolVersion: number;
        capabilities: HostCapabilities;
        state: SessionViewState;
        frontend?: FrontendIdentity;
      };
    }
  | { type: 'session/state'; payload: SessionViewState }
  | { type: 'project/list'; payload: { projects: ProjectSummary[] } }
  /** Every live session, so the frontend can mark several as working at once. */
  | { type: 'session/activity'; payload: { sessions: SessionActivity[] } }
  | { type: 'transcript/append'; payload: TranscriptItem }
  | { type: 'transcript/update'; payload: TranscriptItem }
  | { type: 'transcript/delta'; payload: { id: string; text?: string; thinking?: string } }
  | { type: 'transcript/replace'; payload: { items: TranscriptItem[] } }
  /** A page of older history, inserted in front of what the client already has. */
  | { type: 'transcript/prepend'; payload: { items: TranscriptItem[] } }
  | { type: 'session/list'; payload: { sessions: SessionSummary[] } }
  | { type: 'interaction/request'; payload: InteractionRequest }
  | { type: 'interaction/dismiss'; payload: { requestId: string } }
  | { type: 'notice'; payload: { level: NoticeLevel; text: string; at: number } }
  /**
   * The host pinned the editor selection (the title-bar attach command). The
   * frontend owns the chip; the prompt text itself never changes behind the
   * user's back.
   */
  | { type: 'context/selection'; payload: { path: string; startLine?: number; endLine?: number } }
  /**
   * What the user has selected in the editor right now, streamed as they drag.
   * This is a preview, not a pin: the frontend shows it as a live chip that
   * keeps updating (dragging and even multi-selection) until the user clicks
   * it to lock. A payload without `startLine` means the selection is gone; the
   * frontend hides the preview without touching the locked pins.
   */
  | { type: 'context/selectionLive'; payload: { path: string; startLine?: number; endLine?: number } }
  /**
   * Hands a forked prompt back to the composer: the message the branch
   * re-opened, with its attachments. Sent after a successful `chat/fork` — a
   * fork that pi cancelled leaves the composer alone.
   */
  | { type: 'composer/seed'; payload: ComposerSeed }
  /** Answer to `host/command` when the frontend asked for a value. */
  | {
      type: 'host/command/result';
      payload: { requestId: string; ok: boolean; data?: unknown; error?: string };
    }
  | { type: 'error'; payload: { message: string; detail?: string; at: number } };

/** Frontend -> host. */
export type ClientToHostMessage =
  | { type: 'client/ready'; payload: { protocolVersion: number; frontend?: FrontendIdentity } }
  | {
      type: 'chat/prompt';
      payload: { text: string; mode?: PromptMode; images?: PromptImage[]; pins?: ChatPin[] };
    }
  /**
   * Replaces a past user message: the host forks the conversation before it,
   * drops that turn, and sends the edited text as a new prompt. `itemId` is the
   * transcript item being edited; `text` is what the user typed in its place.
   */
  | { type: 'chat/edit'; payload: { itemId: string; text: string } }
  /**
   * Branches a new session before a past user message: the host forks the
   * conversation (pi's `fork`), leaves the old branch resumable, and re-homes
   * the transcript onto the new branch with an empty tail. Then it seeds the
   * composer with the forked prompt (`composer/seed`).
   */
  | { type: 'chat/fork'; payload: { itemId: string } }
  | { type: 'chat/abort'; payload: Record<string, never> }
  | { type: 'session/new'; payload: { cwd?: string } }
  | { type: 'session/load'; payload: { sessionId: string; cwd?: string } }
  | { type: 'session/activate'; payload: { sessionId: string; cwd?: string } }
  | { type: 'session/close'; payload: { sessionId: string } }
  /**
   * Deletes a session and its stored conversation for good. Closing only
   * retires the agent process (the session stays resumable); deleting removes
   * the session file. What that means per host is the catalog's business.
   */
  | { type: 'session/delete'; payload: { sessionId: string } }
  | { type: 'session/compact'; payload: { instructions?: string } }
  | { type: 'history/load'; payload: Record<string, never> }
  | { type: 'session/list'; payload: Record<string, never> }
  /**
   * Re-reads the resources the composer's palette lists. pi caches its prompt
   * templates at spawn, so a newly added template is invisible until this — the
   * host re-reads the template files and answers with a fresh `session/state`.
   */
  | { type: 'commands/refresh'; payload: Record<string, never> }
  | { type: 'project/list'; payload: Record<string, never> }
  | { type: 'project/open'; payload: { path: string } }
  | { type: 'model/set'; payload: { provider: string; id: string } }
  | { type: 'thinking/set'; payload: { level: ThinkingLevel } }
  | { type: 'interaction/respond'; payload: InteractionResponse }
  | {
      type: 'host/command';
      payload: { command: HostCommand; args?: Record<string, unknown>; requestId?: string };
    };

export type WireMessage = HostToClientMessage | ClientToHostMessage;

export const HOST_MESSAGE_TYPES = [
  'host/ready',
  'session/state',
  'project/list',
  'session/activity',
  'transcript/append',
  'transcript/update',
  'transcript/delta',
  'transcript/replace',
  'transcript/prepend',
  'session/list',
  'interaction/request',
  'interaction/dismiss',
  'notice',
  'context/selection',
  'context/selectionLive',
  'composer/seed',
  'host/command/result',
  'error',
] as const;

export const CLIENT_MESSAGE_TYPES = [
  'client/ready',
  'chat/prompt',
  'chat/edit',
  'chat/fork',
  'chat/abort',
  'session/new',
  'session/load',
  'session/activate',
  'session/close',
  'session/delete',
  'session/compact',
  'history/load',
  'session/list',
  'commands/refresh',
  'project/list',
  'project/open',
  'model/set',
  'thinking/set',
  'interaction/respond',
  'host/command',
] as const;

export function encodeWireMessage(message: WireMessage): string {
  return JSON.stringify(message);
}

export function isHostToClientMessage(value: unknown): value is HostToClientMessage {
  return hasKnownType(value, HOST_MESSAGE_TYPES);
}

export function isClientToHostMessage(value: unknown): value is ClientToHostMessage {
  return hasKnownType(value, CLIENT_MESSAGE_TYPES);
}

/** Accepts a JSON string or an already parsed object; returns undefined when invalid. */
export function parseHostMessage(raw: unknown): HostToClientMessage | undefined {
  const value = decode(raw);
  return isHostToClientMessage(value) ? value : undefined;
}

export function parseClientMessage(raw: unknown): ClientToHostMessage | undefined {
  const value = decode(raw);
  return isClientToHostMessage(value) ? value : undefined;
}

/**
 * Transport-agnostic decode: WebSocket frames may arrive as Buffer/Uint8Array,
 * the VS Code webview passes objects, tests pass strings.
 */
export function decode(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (raw instanceof Uint8Array) {
    return decode(new TextDecoder().decode(raw));
  }
  if (raw instanceof ArrayBuffer) {
    return decode(new TextDecoder().decode(new Uint8Array(raw)));
  }
  return raw;
}

function hasKnownType(value: unknown, allowed: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && allowed.includes(type);
}
