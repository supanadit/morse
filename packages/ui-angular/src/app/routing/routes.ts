import type { Type } from '@angular/core';
import { App } from '../shell/app';
import { McpEditorPage } from '../features/surfaces/mcp-editor/mcp-editor-page';

/**
 * A surface this bundle can boot, keyed by URL hash.
 *
 * The same Angular build serves every host, so a second surface is a new row
 * here plus a component — the bootstrap in `main.ts` does not change. VS Code
 * uses this for editor panels (`#/mcp`): it has no Morse tab strip, so a
 * standalone surface needs its own `WebviewPanel` and its own route.
 *
 * A row may name a `component` (eager, part of the initial bundle) or a `load`
 * that code-splits it. Use `load` for a surface whose component is heavy and
 * only needed when the route is actually booted.
 */
export interface AppRoute {
  /** Hash path without the leading `#`, e.g. `/mcp`. */
  path: string;
  /** What that path boots, when it is not code-split. */
  component?: Type<unknown>;
  /** Resolves the component when it is code-split. */
  load?: () => Promise<Type<unknown>>;
}

export const APP_ROUTES: readonly AppRoute[] = [
  { path: '/mcp', component: McpEditorPage },
  {
    path: '/prompts',
    load: () => import('../features/surfaces/prompt-editor/prompt-editor-page').then((m) => m.PromptEditorPage),
  },
  // One session as a whole editor tab (VS Code). Code-split like the prompt
  // editor: a session tab is not the chat app's own bundle, and loading it only
  // when the route is actually booted keeps the sidebar panel's first paint out
  // of it.
  {
    path: '/session',
    load: () => import('./session-page/session-page').then((m) => m.SessionPage),
  },
];

/** What an unknown or empty hash boots: the chat app (also the shell's `<app-root>`). */
export const DEFAULT_ROUTE: AppRoute = { path: '/', component: App };

/**
 * The path out of a `location.hash` (`#/mcp`, `#/mcp?x=1` -> `/mcp`). Exported
 * for the test, and so a host can name the same path it routes.
 */
export function hashPath(hash: string): string {
  const withoutHash = hash.startsWith('#') ? hash.slice(1) : hash;
  const path = withoutHash.split('?')[0].split('&')[0];
  return path.length > 0 ? path : '/';
}

/** The route for a hash; anything unknown falls back to the chat app. */
export function resolveAppRoute(hash: string): AppRoute {
  const path = hashPath(hash);
  return APP_ROUTES.find((route) => route.path === path) ?? DEFAULT_ROUTE;
}
