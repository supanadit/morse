import type {
  AgentCommand,
  AgentInteractionRequest,
  AgentSessionState,
  ModelRef,
  ThinkingLevel,
  TokenUsage,
  WorkspaceRef,
} from '@morse/core';
import type {
  AgentFailure,
  CommandOption,
  InteractionRequest,
  ModelOption,
  NoticeLevel,
  SessionViewState,
} from '@morse/protocol';

export interface SessionStateMeta {
  agentReady: boolean;
  agentStarting: boolean;
  agentError?: string;
  /** What `agentError` means and what to do about it (see `AgentFailure`). */
  agentFailure?: AgentFailure;
  busy: boolean;
  /** True when older transcript entries can still be loaded from the session. */
  hasOlderHistory?: boolean;
  /** True while the host is fetching the previous history page. */
  loadingOlderHistory?: boolean;
}

export function emptySessionViewState(
  workspace: WorkspaceRef,
  meta: SessionStateMeta,
): SessionViewState {
  return {
    workspace: { cwd: workspace.cwd, name: workspace.name },
    thinkingLevel: 'off',
    availableModels: [],
    availableThinkingLevels: [],
    availableCommands: [],
    streaming: false,
    busy: meta.busy,
    agentReady: meta.agentReady,
    agentStarting: meta.agentStarting,
    agentError: meta.agentError,
    agentFailure: meta.agentFailure,
    hasOlderHistory: meta.hasOlderHistory,
    loadingOlderHistory: meta.loadingOlderHistory,
  };
}

/**
 * The empty panel as a *draft*: no session exists yet, but the state still
 * carries what the backend offers without one — model catalog, thinking
 * levels, commands (from a never-recording probe, see `SessionRegistry
 * .draftDefaults`) — plus whatever the user has already picked. Those pending
 * picks are applied to the session the first prompt opens.
 */
export function draftSessionViewState(
  workspace: WorkspaceRef,
  meta: SessionStateMeta,
  catalog: AgentSessionState | undefined,
  pendingModel: ModelRef | undefined,
  pendingThinking: ThinkingLevel | undefined,
): SessionViewState {
  const empty = emptySessionViewState(workspace, meta);
  if (!catalog) {
    return empty;
  }
  return {
    ...empty,
    model: toModelOption(pendingModel ?? catalog.model),
    thinkingLevel: pendingThinking ?? catalog.thinkingLevel ?? 'off',
    availableModels: catalog.availableModels.map(toModelOption).filter(isModelOption),
    availableThinkingLevels: catalog.availableThinkingLevels.map(toThinkingLevel),
    availableCommands: catalog.availableCommands.map(toCommandOption),
  };
}

export function toSessionViewState(
  state: AgentSessionState,
  meta: SessionStateMeta,
): SessionViewState {
  return {
    sessionId: state.sessionId,
    sessionTitle: state.sessionTitle,
    workspace: { cwd: state.workspace.cwd, name: state.workspace.name },
    model: toModelOption(state.model),
    thinkingLevel: state.thinkingLevel,
    availableModels: state.availableModels.map(toModelOption).filter(isModelOption),
    availableThinkingLevels: state.availableThinkingLevels.map(toThinkingLevel),
    availableCommands: state.availableCommands.map(toCommandOption),
    streaming: state.streaming,
    busy: meta.busy,
    usage: toUsage(state.usage),
    lastUsage: toUsage(state.lastUsage),
    costUsd: state.costUsd,
    contextUsage: state.contextUsage ? { ...state.contextUsage } : undefined,
    counts: state.counts ? { ...state.counts } : undefined,
    agentReady: meta.agentReady,
    agentStarting: meta.agentStarting,
    agentError: meta.agentError,
    agentFailure: meta.agentFailure,
    hasOlderHistory: meta.hasOlderHistory,
    loadingOlderHistory: meta.loadingOlderHistory,
  };
}

function toModelOption(model: ModelRef | undefined): ModelOption | undefined {
  if (!model) {
    return undefined;
  }
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function isModelOption(value: ModelOption | undefined): value is ModelOption {
  return value !== undefined;
}

function toCommandOption(command: AgentCommand): CommandOption {
  return {
    name: command.name,
    description: command.description,
    source: command.source,
    template: command.template,
  };
}

function toThinkingLevel(level: ThinkingLevel): ThinkingLevel {
  return level;
}

function toUsage(usage: TokenUsage | undefined): TokenUsage | undefined {
  return usage ? { ...usage } : undefined;
}
/** The agent's interaction requests already match the wire shape 1:1. */
export function toInteractionRequest(request: AgentInteractionRequest): InteractionRequest {
  switch (request.kind) {
    case 'select':
      return {
        requestId: request.requestId,
        kind: 'select',
        title: request.title,
        message: request.message,
        options: request.options.map((option) => ({ ...option })),
      };
    case 'confirm':
      return {
        requestId: request.requestId,
        kind: 'confirm',
        title: request.title,
        message: request.message,
        danger: request.danger,
      };
    case 'input':
      return {
        requestId: request.requestId,
        kind: 'input',
        title: request.title,
        placeholder: request.placeholder,
        value: request.value,
      };
    case 'editor':
      return {
        requestId: request.requestId,
        kind: 'editor',
        title: request.title,
        value: request.value,
        language: request.language,
      };
  }
}

export function noticeMessage(
  level: NoticeLevel,
  text: string,
  at: number,
): { type: 'notice'; payload: { level: NoticeLevel; text: string; at: number } } {
  return { type: 'notice', payload: { level, text, at } };
}
