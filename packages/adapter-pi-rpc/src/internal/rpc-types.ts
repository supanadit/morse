/**
 * Subset of the pi RPC protocol this adapter needs.
 *
 * Mirrors the documented contract (docs/rpc-commands.md, docs/json.md,
 * docs/rpc-extension-ui.md) rather than depending on the very large
 * `@earendil-works/pi-coding-agent` package, which stays a runtime-only,
 * spawn-based dependency.
 */

export interface RpcImage {
  type: 'image';
  data: string;
  mimeType: string;
}

export type RpcCommand =
  | { type: 'prompt'; message: string; images?: RpcImage[]; streamingBehavior?: 'steer' | 'followUp' }
  | { type: 'steer'; message: string; images?: RpcImage[] }
  | { type: 'follow_up'; message: string; images?: RpcImage[] }
  | { type: 'abort' }
  | { type: 'new_session'; parentSession?: string }
  | { type: 'switch_session'; sessionPath: string }
  | { type: 'get_state' }
  | { type: 'get_messages' }
  | { type: 'get_entries'; since?: string }
  | { type: 'get_available_models' }
  | { type: 'get_available_thinking_levels' }
  | { type: 'get_commands' }
  | { type: 'get_session_stats' }
  | { type: 'fork'; entryId: string }
  | { type: 'get_fork_messages' }
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'set_thinking_level'; level: string }
  | { type: 'compact'; customInstructions?: string }
  | { type: 'set_session_name'; name: string }
  | { type: 'bash'; command: string };

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

export interface RpcExtensionUiRequest {
  type: 'extension_ui_request';
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: string;
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: string;
  text?: string;
}

export interface RpcExtensionUiResponse {
  type: 'extension_ui_response';
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

/** Anything else pi writes on stdout: a session event we may or may not map. */
export type RpcRecord = (RpcResponse | RpcExtensionUiRequest | { type: string }) &
  Record<string, unknown>;

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
