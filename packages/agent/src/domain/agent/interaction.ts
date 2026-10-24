/**
 * The agent asking the user for something: a past message it can fork from, or one
 * of the questions it needs answered to continue.
 *
 * Shapes only — no I/O, no ports, no framework imports (R2/R8).
 */

/**
 * A past user message the agent can fork from: stable entry id plus the exact
 * text the model received. Forking re-parents the conversation before it, which
 * is how a frontend lets a user edit a prompt that already has an answer.
 */
export interface AgentForkMessage {
  entryId: string;
  text: string;
}

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}


/**
 * The shape every interaction request shares: which question it is and which
 * request it answers.
 *
 * A base interface each request extends. `kind` stays the discriminant.
 */
export interface AgentInteractionRequestBase {
  requestId: string;
  kind: 'select' | 'confirm' | 'input' | 'editor';
  title: string;
}

/** Pick one of a fixed list. */
export interface AgentSelectRequest extends AgentInteractionRequestBase {
  kind: 'select';
  message?: string;
  options: SelectOption[];
}

/** Yes or no, with the consequence spelled out. */
export interface AgentConfirmRequest extends AgentInteractionRequestBase {
  kind: 'confirm';
  message: string;
  danger?: boolean;
}

/** A single line of text. */
export interface AgentInputRequest extends AgentInteractionRequestBase {
  kind: 'input';
  placeholder?: string;
  value?: string;
}

/** A multi-line body, for a longer answer or an edit. */
export interface AgentEditorRequest extends AgentInteractionRequestBase {
  kind: 'editor';
  value?: string;
  language?: string;
}

/** The agent asking the user for input, normalised away from any transport. */
export type AgentInteractionRequest =
  | AgentSelectRequest
  | AgentConfirmRequest
  | AgentInputRequest
  | AgentEditorRequest;

export interface AgentInteractionResponse {
  requestId: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

