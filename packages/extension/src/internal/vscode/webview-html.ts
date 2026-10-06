import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { PROTOCOL_VERSION } from '@morse/protocol';

export interface WebviewHtmlOptions {
  title: string;
  /** Frontend identity to log, purely informational. */
  frontend?: { name: string; version: string };
  /**
   * A hash route to enter before the bundle boots (`/mcp` -> `#/mcp`). One
   * Angular build serves several surfaces: the chat view and the MCP editor
   * panel pick their root from the hash.
   */
  route?: string;
}

/**
 * Serves the built frontend inside the webview.
 *
 * The frontend stays a plain static bundle: this function only rewrites the
 * `<base>` to the webview resource root and injects a CSP with a nonce, so any
 * frontend build (Angular today, React or Svelte tomorrow) works unchanged.
 */
export async function renderWebviewHtml(
  webview: vscode.Webview,
  webviewRoot: vscode.Uri,
  options: WebviewHtmlOptions,
): Promise<string> {
  const indexUri = vscode.Uri.joinPath(webviewRoot, 'index.html');
  const raw = await readFile(indexUri.fsPath, 'utf8');
  const nonce = createNonce();
  const base = webview.asWebviewUri(webviewRoot).toString();
  const cspSource = webview.cspSource;
  const csp = [
    `default-src 'none'`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    // Angular injects component styles at runtime, so inline styles are required.
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    // The only request the frontend makes off-machine: reading the published
    // version so the sidebar can name a newer release (see
    // `ui-angular/src/app/core/update.ts`). Read-only, public data, and the
    // frontend asks only when the host advertises `updateCheck`.
    `connect-src ${cspSource} https://registry.npmjs.org`,
  ].join('; ');

  const withBase = /<base\s+href=/i.test(raw)
    ? raw.replace(/<base\s+href="[^"]*"\s*>/i, `<base href="${base}/">`)
    : raw.replace(/<head>/i, `<head>\n  <base href="${base}/">`);

  const routeScript =
    options.route !== undefined && options.route.length > 0
      ? `\n  <script nonce="${nonce}">window.location.hash = ${JSON.stringify(`#${options.route}`)};</script>`
      : '';

  return withBase
    .replace(/<script\b/gi, `<script nonce="${nonce}"`)
    .replace(/<title>.*?<\/title>/i, `<title>${escapeHtml(options.title)}</title>`)
    .replace(
      /<head>/i,
      `<head>\n  <meta http-equiv="Content-Security-Policy" content="${csp}">\n  <meta name="morse-protocol" content="${PROTOCOL_VERSION}">${routeScript}`,
    );
}

export function createNonce(): string {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let index = 0; index < 32; index += 1) {
    nonce += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return nonce;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
