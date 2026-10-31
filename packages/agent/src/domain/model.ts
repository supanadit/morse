/**
 * The model and thinking-level vocabulary: what an agent can run, and how hard it
 * is asked to think.
 *
 * Shapes and constants only — no I/O, no ports, no framework imports (R2/R8).
 */

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export type NoticeLevel = 'info' | 'success' | 'warn' | 'error';

/**
 * What a model accepts as input — pi's `input` array. pi itself ships `text`
 * and `image` today; the wider union covers the modalities the picker has an
 * icon for. An unknown value from a future pi is dropped at the adapter
 * boundary, not rendered as a modality with no icon.
 */
export type ModelInput = 'text' | 'image' | 'audio' | 'video' | 'pdf';

/** Every modality Morse can badge, in the order the picker shows them. */
export const MODEL_INPUTS: readonly ModelInput[] = ['text', 'image', 'audio', 'video', 'pdf'];

export interface ModelRef {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
  /** Provider cap on the response length, for the footer's output limit. */
  maxTokens?: number;
  /**
   * Input modalities pi reported for the model. Optional on purpose: absent
   * means pi did not say, and the picker then shows no badge instead of
   * claiming a text-only model.
   */
  input?: ModelInput[];
}

/**
 * `'builtin'` is pi's own TUI slash commands, sourced live from the installed
 * pi binary's `dist/core/slash-commands.js` at spawn (and re-read whenever that
 * file changes on disk), so the list can never drift from a pi upgrade.
 */
export type AgentCommandSource = 'builtin' | 'extension' | 'prompt' | 'skill';

/** A command the agent exposes to the composer (pi `get_commands`). */
export interface AgentCommand {
  name: string;
  description?: string;
  source: AgentCommandSource;
  /**
   * pi's argument placeholder (`<provider/model>` for `/model`), as the TUI
   * shows it next to the command name. Only builtins declare one.
   */
  argumentHint?: string;
  /**
   * Raw Markdown of a prompt template, for `source: 'prompt'` only. pi does not
   * send the body over RPC, so the adapter reads the file `get_commands` named
   * and the modal expands it here. Absent when the file could not be read.
   */
  template?: string;
}
