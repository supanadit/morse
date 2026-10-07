/**
 * The language-server contract between the browser host and its frontend.
 *
 * The host runs the servers (a browser cannot), so the frontend's preview asks
 * over the same `host/command` channel `readFile` uses and gets these shapes
 * back. Two rules keep the seam honest:
 *
 * - **LSP's own coordinates.** `line` and `character` are zero-based and
 *   `character` counts UTF-16 code units, exactly as the protocol defines them.
 *   Keeping LSP's frame end to end means nothing translates twice; the frontend
 *   converts to its 1-based line numbers at the edge, where it renders.
 * - **Project-relative paths.** A location names a path the way `listFiles` and
 *   `readFile` do (relative to the viewing session's directory, `/` separators).
 *   A `file://` URI is the server's business; a path that escapes the project is
 *   refused by the host rather than sent, so the frontend cannot be handed a
 *   location it is not allowed to open.
 */

/** A position in a document: zero-based line and character, LSP's own frame. */
export interface LspPosition {
  line: number;
  character: number;
}

/** A half-open range: `start` inclusive, `end` exclusive. */
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/**
 * How bad a diagnostic is. LSP's numeric severities (1-4) are mapped here by the
 * host, so the frontend never compares magic numbers; an unknown severity
 * becomes `information`.
 */
export type LspSeverity = 'error' | 'warning' | 'information' | 'hint';

/** One problem a language server reported for an open document. */
export interface LspDiagnostic {
  range: LspRange;
  severity: LspSeverity;
  message: string;
  /** The tool that reported it (`typescript`, `eslint`, …), when it says. */
  source?: string;
  /** The server's own code for this kind of problem, as a string. */
  code?: string;
}

/** A place in the project: what `lspDefinition` and `lspReferences` answer with. */
export interface LspLocation {  /** Path relative to the viewing session's directory, `/` on every platform. */
  path: string;
  range: LspRange;
}

/**
 * What a hover shows. LSP allows an array of marked strings and markdown; the
 * host flattens all of it into one markdown string, because the frontend only
 * needs to render one card.
 */
export interface LspHover {
  /** Markdown (LSP's `MarkupContent`, or the plain text of a `MarkedString`). */
  contents: string;
  /** The identifier range the hover describes, so the UI can underline it. */
  range?: LspRange;
}

/** What `lspDefinition` answers: where the symbol under the cursor is defined. */
export type LspDefinition = LspLocation;

/** What `lspReferences` answers: every place the symbol is used. */
export interface LspReferences {
  path: string;
  locations: LspLocation[];
}

/**
 * What `lspDiagnostics` answers for one file.
 *
 * `available: false` means no language server covers this file (or one failed to
 * start), which is not the same as "no problems" — the preview says so instead
 * of implying a clean file.
 */
export interface LspDiagnostics {
  path: string;
  available: boolean;
  diagnostics: LspDiagnostic[];
}
