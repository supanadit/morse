import type { Type } from '@angular/core';
import { App } from './app';
import { McpEditorPage } from './chat/mcp-editor/mcp-editor-page';

/**
 * A surface this bundle can boot, keyed by URL hash.
 *
 * The same Angular build serves every host, so a second surface is a new row
 * here plus a component — the bootstrap in `main.ts` does not change. VS Code
 * uses this for editor panels (`#/mcp`): it has no Morse tab strip, so a
 * standalone surface needs its own `WebviewPanel` and its own route.
 */
export interface AppRoute {
  /** Hash path without the leading `#`, e.g. `/mcp`. */
  path: string;
  /** What that path boots. */
  component: Type<unknown>;
}

export const APP_ROUTES: readonly AppRoute[] = [
  { path: '/mcp', component: McpEditorPage },
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
