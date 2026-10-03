export interface EditorSelection {
  startLine: number;
  endLine: number;
  text: string;
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