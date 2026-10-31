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
 * A value a form field carries.
 *
 * Deliberately limited to what every renderer can produce: text and numbers from
 * an input, a boolean from a checkbox, and strings from a multi-select. A harness
 * with a richer widget degrades to one of these rather than inventing a value the
 * frontend cannot render.
 */
export type AgentFormValue = string | number | boolean | string[];

/** The control a field asks for; a renderer picks the widget by this, not by name. */
export type AgentFormFieldType =
  | 'text'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'select'
  | 'multiselect';

/**
 * A field is shown only when another field's answer matches.
 *
 * Stated in the form's own vocabulary (`equals` / `notEquals` / `in`), never a
 * harness expression: a renderer evaluates it locally, so it can hide and show
 * without asking the agent.
 */
export interface AgentFormCondition {
  /** The key of the field whose answer is compared. */
  field: string;
  equals?: AgentFormValue;
  notEquals?: AgentFormValue;
  /** Show when the answer is one of these (for a multi-select, any of them). */
  in?: AgentFormValue[];
}

/** One field of a form: what to ask, how to render it, and what it accepts. */
export interface AgentFormField {
  /** The key the answer is labelled by; unique within the form. */
  key: string;
  label: string;
  type: AgentFormFieldType;
  required?: boolean;
  placeholder?: string;
  defaultValue?: AgentFormValue;
  /** Inclusive bounds for a number/integer field. */
  min?: number;
  max?: number;
  /** A regular expression a text answer must match, as JavaScript source. */
  pattern?: string;
  /** The choices for `select` / `multiselect`. */
  options?: SelectOption[];
  /** Visibility, when the field depends on another answer. */
  when?: AgentFormCondition;
}

/**
 * The shape every interaction request shares: which question it is and which
 * request it answers.
 *
 * A base interface each request extends. `kind` stays the discriminant.
 */
export interface AgentInteractionRequestBase {
  requestId: string;
  kind: 'select' | 'confirm' | 'input' | 'editor' | 'form';
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

/**
 * Several fields answered together, keyed by field.
 *
 * A harness asks this when one value cannot express the answer (a form the agent
 * rendered, several settings to choose at once). The frontend renders it, checks
 * its constraints locally, and answers with a map — or cancels, which is
 * deliberately not the same as submitting empty values.
 */
export interface AgentFormRequest extends AgentInteractionRequestBase {
  kind: 'form';
  message?: string;
  fields: AgentFormField[];
}

/** The agent asking the user for input, normalised away from any transport. */
export type AgentInteractionRequest =
  | AgentSelectRequest
  | AgentConfirmRequest
  | AgentInputRequest
  | AgentEditorRequest
  | AgentFormRequest;

export interface AgentInteractionResponse {
  requestId: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
  /** A form's answer: every answered field under its key. */
  values?: Record<string, AgentFormValue>;
}

