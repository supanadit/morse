/**
 * Terminal-colored extension text arrives over RPC — Morse renders it as DOM.
 *
 * pi's TUI formats a widget line or a footer status with `theme.fg(...)`, which
 * returns an SGR escape sequence. pi's RPC mode forwards that string verbatim,
 * so it reaches Morse already colored:
 *
 *     `\u001b[38;2;126;136;142mLSP Inactive\u001b[39m`
 *
 * Morse is a browser/webview frontend, not a terminal: it paints the text as
 * DOM text nodes, where those bytes show up as literal `[38;2;...m` garbage
 * instead of color. Strip the escapes at the pi boundary, once, so every
 * extension's chrome is rendered the same way — no plugin is special-cased.
 *
 * This is deliberately narrow. Only terminal *control* sequences are removed;
 * any visible text (including literal brackets an extension prints, e.g.
 * `[1,3]`) survives. Extensions that build their own DOM or use the dialog
 * protocol (pi's `select`/`input`/`confirm`, as `@juicesharp/rpiv-ask-user-question`
 * does) never pass through here and are unaffected.
 */

/** CSI sequence: `ESC [ … <final byte>` (SGR color, erase, cursor, …). */
const CSI_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** OSC sequence (hyperlink, window title), BEL- or ST-terminated. */
const OSC_SEQUENCE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;

/** Remove terminal escape sequences, leaving the visible text untouched. */
export function stripAnsi(text: string): string {
  return text.replace(OSC_SEQUENCE, '').replace(CSI_SEQUENCE, '');
}
