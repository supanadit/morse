import { InjectionToken, type Type } from '@angular/core';

/** Resolves the editor's class; the dynamic import keeps CodeMirror out of the initial bundle. */
export type CodeEditorLoader = () => Promise<Type<unknown>>;

/**
 * The seam a feature mounts the editor through, and the seam its specs replace
 * with a fake — an `EditorView` cannot be mounted in jsdom.
 */
export const CODE_EDITOR_LOADER = new InjectionToken<CodeEditorLoader>('CODE_EDITOR_LOADER', {
  providedIn: 'root',
  factory: () => () => import('./code-editor').then((module) => module.CodeEditor),
});
