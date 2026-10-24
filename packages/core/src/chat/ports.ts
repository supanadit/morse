import type { AgentSessionState, ChatPin, ModelRef, ThinkingLevel } from '../domain.js';
import type { PromptDisposition, PromptImage, PromptMode } from '../session/ports.js';

/**
 * Ports of the chat use case.
 *
 * Local to this module (R10): the chat module never imports the session module's
 * class. `SessionRegistry` satisfies `ChatAgentHolder` structurally, which is what
 * lets a host pass it without either module depending on the other's type.
 */

export interface ChatAgent {
  state(): Promise<AgentSessionState>;
  prompt(
    text: string,
    mode: PromptMode,
    images?: PromptImage[],
    pins?: ChatPin[],
  ): Promise<PromptDisposition>;
  abort(): Promise<void>;
  setModel(model: ModelRef): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  compact(customInstructions?: string): Promise<void>;
}

/** Also satisfied structurally by `SessionRegistry`. */
export interface ChatAgentHolder {
  requireActive(): ChatAgent;
  /**
   * The agent of one live session, when the host still has it hot. A prompt can
   * then be addressed to a session other than the active one — a queued follow-up
   * that must run while the reader looks elsewhere. Optional: a holder that only
   * tracks the active session omits it, and such a prompt is dropped.
   */
  agentFor?(key: string): ChatAgent | undefined;
}

export interface PromptOutcome {
  accepted: boolean;
  disposition?: PromptDisposition;
  reason?: string;
}
