import type {
  FrontendIdentity,
  HostCapabilities,
  InteractionRequest,
  NoticeLevel,
  ProjectSummary,
  SessionActivity,
  SessionSummary,
  SessionViewState,
  TranscriptItem,
  WorkspaceInfo,
} from './dto.js';
import type { HostToClientMessage } from './wire.js';
import { PROTOCOL_VERSION } from './version.js';

export type ConnectionStatus = 'connecting' | 'ready' | 'closed' | 'error';

/**
 * The single state object every frontend renders. It is produced by a pure
 * reducer, so Angular/React/Svelte bindings only differ in how they render it.
 */
export interface SessionView {
  protocolVersion: number;
  connection: ConnectionStatus;
  connectionDetail?: string;
  /**
   * Bumped every time the client reaches a *new* host instance (`host/ready`
   * after a drop). A fresh page starts at 0; a reconnection moves it. Stateful
   * frontends that hold resources the *host* owns — the terminal's PTYs — watch
   * this to re-attach, because the new host has never seen them.
   */
  hostEpoch: number;
  frontend?: FrontendIdentity;
  capabilities: HostCapabilities | null;
  state: SessionViewState;
  items: TranscriptItem[];
  sessions: SessionSummary[];
  /**
   * Whether the host holds more sessions past the first page for each project,
   * keyed by cwd. `list()` caps a project to a page, so the sidebar offers a
   * "Load more" row until the host says there is nothing left.
   */
  sessionHasMore: Record<string, boolean>;
  /**
   * Whether `session/list` has arrived at least once. A frontend that prunes
   * tabs against `sessions` must wait for this: an empty list before the first
   * publish is "not asked yet", not "no sessions", and pruning then would drop
   * the tab of the session that is actually in front.
   */
  sessionsLoaded: boolean;
  /** Live agent sessions; a session can be working even while another is shown. */
  activity: SessionActivity[];
  /** Directories pi has sessions for; the browser host's project list. */
  projects: ProjectSummary[];
  pendingInteraction: InteractionRequest | null;
  lastNotice?: { level: NoticeLevel; text: string; at: number };
  lastError?: { message: string; detail?: string; at: number };
}

export function createInitialView(
  workspace: WorkspaceInfo = { cwd: '', name: 'workspace' },
): SessionView {
  return {
    protocolVersion: PROTOCOL_VERSION,
    connection: 'connecting',
    hostEpoch: 0,
    capabilities: null,
    state: {
      workspace,
      thinkingLevel: 'off',
      availableModels: [],
      availableThinkingLevels: [],
      availableCommands: [],
      streaming: false,
      busy: false,
      agentReady: false,
      agentStarting: false,
    },
    items: [],
    sessions: [],
    sessionsLoaded: false,
    sessionHasMore: {},
    activity: [],
    projects: [],
    pendingInteraction: null,
  };
}

export function reduceConnection(
  view: SessionView,
  connection: ConnectionStatus,
  detail?: string,
): SessionView {
  return { ...view, connection, connectionDetail: detail };
}

/** Pure reducer: no clocks, no I/O — every timestamp comes from the host message. */
export function reduceSessionView(view: SessionView, message: HostToClientMessage): SessionView {
  switch (message.type) {
    case 'host/ready': {
      // The first ready is the initial handshake; a later one, on a connection
      // that had dropped, is a *new* host (or a restarted one). Only the latter
      // advances the epoch, so a manual re-handshake on a live socket does not
      // make a terminal re-attach (and kill its shell) for nothing.
      const reconnected = view.capabilities !== null && view.connection !== 'ready';
      return {
        ...view,
        connection: 'ready',
        hostEpoch: reconnected ? view.hostEpoch + 1 : view.hostEpoch,
        protocolVersion: message.payload.protocolVersion,
        capabilities: message.payload.capabilities,
        state: message.payload.state,
        frontend: message.payload.frontend ?? view.frontend,
      };
    }
    case 'session/state':
      return { ...view, state: message.payload };
    case 'transcript/append':
      return { ...view, items: [...view.items, message.payload] };
    case 'transcript/update':
      return { ...view, items: upsertItem(view.items, message.payload) };
    case 'transcript/delta':
      return { ...view, items: applyDelta(view.items, message.payload) };
    case 'transcript/replace':
      return { ...view, items: [...message.payload.items] };
    case 'transcript/prepend':
      return { ...view, items: [...message.payload.items, ...view.items] };
    case 'session/list':
      // A payload with `cwd` is one project's next page (the sidebar's "Load
      // more"), so it is merged into what is already shown. Without `cwd` it is
      // the whole first-page list, which replaces the view.
      if (message.payload.cwd !== undefined) {
        return {
          ...view,
          sessions: mergeSessions(view.sessions, message.payload.sessions),
          sessionsLoaded: true,
          sessionHasMore: {
            ...view.sessionHasMore,
            [message.payload.cwd]: message.payload.hasMore === true,
          },
        };
      }
      return {
        ...view,
        sessions: [...message.payload.sessions],
        sessionsLoaded: true,
        sessionHasMore: { ...(message.payload.hasMoreByProject ?? {}) },
      };
    case 'session/activity':
      return { ...view, activity: [...message.payload.sessions] };
    case 'project/list':
      return { ...view, projects: [...message.payload.projects] };
    case 'interaction/request':
      return { ...view, pendingInteraction: message.payload };
    case 'interaction/dismiss':
      return view.pendingInteraction?.requestId === message.payload.requestId
        ? { ...view, pendingInteraction: null }
        : view;
    case 'notice':
      return { ...view, lastNotice: { ...message.payload } };
    case 'error':
      return { ...view, lastError: { ...message.payload } };
    default:
      return view;
  }
}

/**
 * One project's next page into the list already held. Existing ids are replaced
 * (a session can grow or be renamed between pages) and new ones are appended,
 * keeping the newest-first order the host sent.
 */
function mergeSessions(
  current: readonly SessionSummary[],
  incoming: readonly SessionSummary[],
): SessionSummary[] {
  const byId = new Map(current.map((session) => [session.id, session] as const));
  for (const session of incoming) {
    byId.set(session.id, session);
  }
  return [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt);
}

/**
 * Index of the item carrying `id`, scanning from the end.
 *
 * The reducer's hot messages (a streamed delta, a tool update) always target an
 * item near the tail, so the common case is a handful of comparisons instead of
 * a walk of the whole transcript. Direction cannot change the answer: ids are
 * unique across both producers — the projector's `morse-<kind>-<n>`, and
 * history's `<key>#history-<page>-<index>` — so there is only one match.
 */
function indexOfItem(items: TranscriptItem[], id: string): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.id === id) {
      return index;
    }
  }
  return -1;
}

function upsertItem(items: TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  const index = indexOfItem(items, item.id);
  if (index === -1) {
    return [...items, item];
  }
  const next = [...items];
  next[index] = item;
  return next;
}

function applyDelta(
  items: TranscriptItem[],
  delta: { id: string; text?: string; thinking?: string },
): TranscriptItem[] {
  const index = indexOfItem(items, delta.id);
  if (index === -1) {
    return items;
  }
  const target = items[index];
  if (target.kind !== 'assistant') {
    return items;
  }
  const next = [...items];
  next[index] = {
    ...target,
    text: target.text + (delta.text ?? ''),
    thinking: target.thinking + (delta.thinking ?? ''),
    streaming: true,
  };
  return next;
}
