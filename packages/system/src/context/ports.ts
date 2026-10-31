export interface EditorSelection {
  startLine: number;
  endLine: number;
  /**
   * 1-based column of the first selected character, matching the editor's own
   * status bar (a tab counts as one). Present with `endColumn`, absent for a
   * line-only selection.
   */
  startColumn?: number;
  /** 1-based column of the last selected character (the selection's end is exclusive). */
  endColumn?: number;
  /** How many UTF-16 characters the selection covers, line breaks included. */
  characters?: number;
  /** The selected words, capped for a one-line selection; absent across lines. */
  text?: string;
}

export interface EditorContextSnapshot {
  path?: string;
  languageId?: string;
  selection?: EditorSelection;
  openEditors: string[];
}

/**
 * Driven port (R2): where editor context comes from. The VS Code host reads the
 * real selection; hosts without an editor return `undefined`.
 *
 * The snapshot is only exposed to the frontend as an attachment (a pinned
 * selection chip), never merged into a prompt silently — the prompt must carry
 * merely the words the user typed.
 */
export interface EditorContextProvider {
  snapshot(): Promise<EditorContextSnapshot | undefined>;
}
