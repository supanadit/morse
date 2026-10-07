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
    // `'strict-dynamic'` is what lets the nonced entry script load the
    // code-split chunks it `import()`s. Without it a lazy route — the prompt
    // editor, a session tab — is a runtime `import()` that VS Code's nonce does
    // not cover, so the request is blocked and the panel renders blank. Only
    // scripts the entry itself loads are trusted; an inline script elsewhere in
    // the document still needs the nonce.
    //
    // `cspSource` is the fallback for an engine that ignores `strict-dynamic`:
    // it ignores that keyword and uses the host list instead, which is this
    // webview's own bundle and nothing else.
    `script-src 'nonce-${nonce}' 'strict-dynamic' ${cspSource}`,
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
