/** The agent asking the user for input, and the frontend's answer. */

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

/**
 * Mirrors the agent's interaction requests (pi `extension_ui_request`). Hosts with
 * native dialogs answer them without involving the frontend; hosts without (the
 * browser server host) forward them and the frontend renders a form.
 */
/** The shape every interaction request shares: which question, and which request. */
export interface InteractionRequestBase {
  requestId: string;
  kind: 'select' | 'confirm' | 'input' | 'editor';
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

export type InteractionRequest =
  | SelectRequest
  | ConfirmRequest
  | InputRequest
  | EditorRequest;

export interface InteractionResponse {
  requestId: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}
