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
  frontend?: FrontendIdentity;
  capabilities: HostCapabilities | null;
  state: SessionViewState;
  items: TranscriptItem[];
  sessions: SessionSummary[];
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
    case 'host/ready':
      return {
        ...view,
        connection: 'ready',
        protocolVersion: message.payload.protocolVersion,
        capabilities: message.payload.capabilities,
        state: message.payload.state,
        frontend: message.payload.frontend ?? view.frontend,
      };
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
      return { ...view, sessions: [...message.payload.sessions] };
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

function upsertItem(items: TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
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
  const index = items.findIndex((candidate) => candidate.id === delta.id);
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
