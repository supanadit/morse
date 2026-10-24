/**
 * What pi answers: responses, models, commands and session stats.
 */

export interface RpcResponse {
  type: 'response';
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface RpcModel {
  id: string;
  name?: string;
  provider: string;
  api?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  /** Input modalities pi accepts for this model (`text`, `image`). */
  input?: string[];
}

/** `get_commands`: extension commands, prompt templates and skills. */
export interface RpcCommandInfo {
  name?: string;
  description?: string;
  source?: string;
  /** Where pi loaded the resource from; a prompt template's `.md` lives at `path`. */
  sourceInfo?: { path?: string; scope?: string; origin?: string };
}

export interface RpcSessionStateData {
  model?: RpcModel;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  messageCount?: number;
  pendingMessageCount?: number;
}

export interface RpcUsage {
  input?: number;
  output?: number;
  totalTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Reasoning tokens; a subset of `output`. */
  reasoning?: number;
}

export interface RpcContextUsage {
  tokens?: number | null;
  contextWindow?: number;
  percent?: number | null;
}

/** `get_session_stats`: cumulative tokens/cost, counts, and the live context. */
export interface RpcSessionStatsData {
  tokens?: RpcUsage & { total?: number };
  cost?: number;
  contextUsage?: RpcContextUsage;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  toolResults?: number;
  totalMessages?: number;
}

export interface RpcAssistantMessageEvent {
  type: string;
  contentIndex?: number;
  delta?: string;
  id?: string;
  toolName?: string;
  content?: string;
}

export interface RpcMessage {
  role?: string;
  content?: unknown;
  model?: string;
  provider?: string;
  stopReason?: string;
  usage?: RpcUsage;
  [key: string]: unknown;
}
