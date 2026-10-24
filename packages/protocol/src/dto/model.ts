/** The model and command pickers: what the reader chooses, as the host reports it. */
import type { ModelInput } from './primitives.js';

export interface ModelOption {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  /** Input modalities pi reported; absent means pi did not say. */
  input?: ModelInput[];
}

export type CommandSource = 'builtin' | 'extension' | 'prompt' | 'skill';

/**
 * A command the agent session offers in the composer: an extension command, a
 * prompt template or a skill (`/skill:name`). Run by sending `/name` as a
 * prompt. Morse's own built-ins (`/new`, `/compact`, ...) are merged in by the
 * frontend because pi keeps them in the TUI only.
 */
export interface CommandOption {
  name: string;
  description?: string;
  source: CommandSource;
  /** pi's argument placeholder (`<provider/model>` for `/model`); builtins only. */
  argumentHint?: string;
  /** Raw prompt-template Markdown, for `source: 'prompt'` only (see `AgentCommand`). */
  template?: string;
}

/** Which prompt directory a template lives in: the user's, or this project's `.pi`.
 * A project definition shadows a user one with the same name, exactly as pi loads it. */
