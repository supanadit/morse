/** The agent asking the user for input, and the frontend's answer. */

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

/**
 * A value a form field carries. Mirrors `@morse/agent`'s vocabulary: only what
 * every renderer can produce, so a form never asks for something the frontend
 * cannot send back.
 */
export type FormValue = string | number | boolean | string[];

/** The control a field asks for. */
export type FormFieldType = 'text' | 'number' | 'integer' | 'boolean' | 'select' | 'multiselect';

/** Show a field only when another field's answer matches. */
export interface FormCondition {
  field: string;
  equals?: FormValue;
  notEquals?: FormValue;
  in?: FormValue[];
}

/** One field: what to ask, what to render, and what it accepts. */
export interface FormField {
  key: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  placeholder?: string;
  defaultValue?: FormValue;
  min?: number;
  max?: number;
  /** A regular expression a text answer must match, as JavaScript source. */
  pattern?: string;
  options?: SelectOption[];
  when?: FormCondition;
}

/**
 * Mirrors the agent's interaction requests (pi `extension_ui_request`). Hosts with
 * native dialogs answer them without involving the frontend; hosts without (the
 * browser server host) forward them and the frontend renders a form.
 */
/** The shape every interaction request shares: which question, and which request. */
export interface InteractionRequestBase {
  requestId: string;
  kind: 'select' | 'confirm' | 'input' | 'editor' | 'form';
  title: string;
}

/** Pick one of a fixed list. */
export interface SelectRequest extends InteractionRequestBase {
  kind: 'select';
  message?: string;
  options: SelectOption[];
}

/** Yes or no, with the consequence spelled out. */
export interface ConfirmRequest extends InteractionRequestBase {
  kind: 'confirm';
  message: string;
  danger?: boolean;
}

/** A single line of text. */
export interface InputRequest extends InteractionRequestBase {
  kind: 'input';
  placeholder?: string;
  value?: string;
}

/** A multi-line body, for a longer answer or an edit. */
export interface EditorRequest extends InteractionRequestBase {
  kind: 'editor';
  value?: string;
  language?: string;
}

/** Several fields answered together, keyed by field. */
export interface FormRequest extends InteractionRequestBase {
  kind: 'form';
  message?: string;
  fields: FormField[];
}

export type InteractionRequest =
  | SelectRequest
  | ConfirmRequest
  | InputRequest
  | EditorRequest
  | FormRequest;

export interface InteractionResponse {
  requestId: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
  /** A form's answer: every answered field under its key. */
  values?: Record<string, FormValue>;
}
