import type { AgentSessionState, ChatPin, ModelRef, NoticeLevel, ThinkingLevel } from '../domain.js';
import type { MorseLogger } from '../logger.js';
import type { PromptDisposition, PromptImage, PromptMode } from '../session/service.js';

/**
 * Local port (R10): the slice of the agent the chat use case needs. The concrete
 * `SessionRegistry` satisfies it structurally — the chat module never imports the
 * session module's class.
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
}

export interface PromptOutcome {
  accepted: boolean;
  disposition?: PromptDisposition;
  reason?: string;
}

export interface ChatServiceDeps {
  agent: ChatAgentHolder;
  logger: MorseLogger;
  onNotice?: (level: NoticeLevel, text: string) => void;
}

/**
 * Chat use case: validates prompts and decides between running, steering and
 * following up. Shared by every host.
 *
 * Attachments (images and pins) travel on the turn as attachments — the prompt
 * text stays exactly what the user typed. A host that wants the agent to know
 * about an editor selection pins it like any other attachment instead of
 * prepending an invisible "context from the editor" preamble: preamble text
 * cannot be untangled later, and it made every persisted session carry words
 * the user never wrote.
 */
export class ChatService {
  constructor(private readonly deps: ChatServiceDeps) {}

  async prompt(
    text: string,
    mode: PromptMode = 'new',
    images?: PromptImage[],
    pins?: ChatPin[],
  ): Promise<PromptOutcome> {
    const trimmed = text.trim();
    // Attachments count as content: an image (or a pinned selection) is allowed
    // to travel on its own, without the user being forced to type filler text.
    const hasAttachments =
      (images !== undefined && images.length > 0) || (pins !== undefined && pins.length > 0);
    if (trimmed.length === 0 && !hasAttachments) {
      this.notice('warn', 'Nothing to send — the prompt is empty.');
      return { accepted: false, reason: 'empty-prompt' };
    }

    let agent: ChatAgent;
    try {
      agent = this.deps.agent.requireActive();
    } catch (error: unknown) {
      this.deps.logger.error('Prompt rejected: no active agent session', error);
      return { accepted: false, reason: 'no-session' };
    }

    let effectiveMode = mode;
    const state = await agent.state();
    if (state.streaming && effectiveMode === 'new') {
      effectiveMode = 'followUp';
      this.notice('info', 'The agent is still working — queued as a follow-up.');
    }

    const disposition = await agent.prompt(trimmed, effectiveMode, images, pins);
    return { accepted: true, disposition };
  }

  async abort(): Promise<void> {
    await this.deps.agent.requireActive().abort();
  }

  async setModel(model: ModelRef): Promise<void> {
    await this.deps.agent.requireActive().setModel(model);
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.deps.agent.requireActive().setThinkingLevel(level);
  }

  /** Shrinks the conversation context (`/compact` in the TUI). */
  async compact(customInstructions?: string): Promise<void> {
    await this.deps.agent.requireActive().compact(customInstructions);
  }

  async state(): Promise<AgentSessionState> {
    return this.deps.agent.requireActive().state();
  }

  private notice(level: NoticeLevel, text: string): void {
    this.deps.onNotice?.(level, text);
  }
}