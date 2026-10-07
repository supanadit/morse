/**
 * Turning a language server's JSON into Morse's own shapes.
 *
 * This is the LSP equivalent of the pi adapter's `event-mapping.ts`: the only
 * place that knows what a `Location | LocationLink | null` is, and the only
 * place that decides which of a server's answers the frontend may see. Nothing
 * here throws on a surprising payload — a shape Morse does not recognise becomes
 * `undefined`, and the caller degrades instead of failing the request.
 *
 * Paths cross the wire project-relative (`lsp.ts` says why), so every location
 * is converted back through `relativeWithin`, which drops a file the server
 * points at but the project does not own (a `node_modules` copy reached through
 * a symlink, say).
 */
import { relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  LspDiagnostic,
  LspDiagnostics,
  LspHover,
  LspLocation,
  LspPosition,
  LspRange,
  LspSeverity,
} from '@morse/protocol';

/** A path as a `file://` URI, which is what LSP names documents with. */
export function toFileUri(absolutePath: string): string {
  return pathToFileURL(absolutePath).toString();
}

/** The absolute path behind a `file://` URI, or `undefined` for any other scheme. */
export function fromFileUri(uri: unknown): string | undefined {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) {
    return undefined;
  }
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

/**
 * A path relative to the project, `/` on every platform, or `undefined` when it
 * is outside it. `listFiles` and `readFile` speak this dialect, and so does the
 * preview's `path`, so a location that cannot be written this way is not one the
 * frontend could open.
 */
export function relativeWithin(cwd: string, absolutePath: string): string | undefined {
  const rel = relative(cwd, absolutePath);
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
    return undefined;
  }
  return rel.split('\\').join('/');
}

/** A zero-based LSP position, or `undefined` when the shape is not one. */
export function positionFrom(value: unknown): LspPosition | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const { line, character } = value as { line?: unknown; character?: unknown };
  if (!Number.isInteger(line) || !Number.isInteger(character)) {
    return undefined;
  }
  return { line: line as number, character: character as number };
}

/** A half-open LSP range, or `undefined` when either end is unusable. */
export function rangeFrom(value: unknown): LspRange | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const { start, end } = value as { start?: unknown; end?: unknown };
  const from = positionFrom(start);
  const to = positionFrom(end);
  return from === undefined || to === undefined ? undefined : { start: from, end: to };
}

/** LSP's numeric severity as a word; anything unrecognised is `information`. */
export function severityFrom(value: unknown): LspSeverity {
  switch (value) {
    case 1:
      return 'error';
    case 2:
      return 'warning';
    case 3:
      return 'information';
    case 4:
      return 'hint';
    default:
      return 'information';
  }
}

/**
 * A `publishDiagnostics` payload as Morse's answer for one file, keeping the URI
 * the server named so the client can key its cache without rebuilding it.
 *
 * A payload that is not for a file inside the project is dropped (`undefined`),
 * so a server reporting on something it reached through a symlink cannot leak a
 * path.
 */
export interface PublishedDiagnostics extends LspDiagnostics {
  /** The document's URI, exactly as the server named it. */
  uri: string;
}

export function diagnosticsFrom(
  params: unknown,
  cwd: string,
): PublishedDiagnostics | undefined {
  if (typeof params !== 'object' || params === null) {
    return undefined;
  }
  const { uri, diagnostics } = params as { uri?: unknown; diagnostics?: unknown };
  if (typeof uri !== 'string') {
    return undefined;
  }
  const absolute = fromFileUri(uri);
  const path = absolute === undefined ? undefined : relativeWithin(cwd, absolute);
  if (path === undefined) {
    return undefined;
  }
  return {
    uri,
    path,
    available: true,
    diagnostics: Array.isArray(diagnostics)
      ? diagnostics.map(diagnosticFrom).filter((item): item is LspDiagnostic => item !== undefined)
      : [],
  };
}

function diagnosticFrom(value: unknown): LspDiagnostic | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const { range, severity, message, source, code } = value as Record<string, unknown>;
  const spot = rangeFrom(range);
  if (spot === undefined) {
    return undefined;
  }
  return {
    range: spot,
    severity: severityFrom(severity),
    message: typeof message === 'string' ? message : '',
    ...(typeof source === 'string' ? { source } : {}),
    ...(typeof code === 'string' || typeof code === 'number' ? { code: String(code) } : {}),
  };
}

/**
 * A hover result as one markdown string.
 *
 * LSP allows three shapes: a `MarkupContent`, a `MarkedString`, or an array of
 * either. All three collapse into the one card the frontend draws; a
 * `{ language, value }` marked string becomes a fenced block so its code stays
 * code, and plain text is passed through (every server Morse ships for sends
 * markdown, and prose that happens to contain an asterisk reads better than a
 * fenced paragraph).
 */
export function hoverFrom(result: unknown): LspHover | undefined {
  if (typeof result !== 'object' || result === null) {
    return undefined;
  }
  const { contents, range } = result as { contents?: unknown; range?: unknown };
  const text = markup(contents);
  if (text.length === 0) {
    return undefined;
  }
  const spot = rangeFrom(range);
  return spot === undefined ? { contents: text } : { contents: text, range: spot };
}

function markup(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(markup).filter((part) => part.length > 0).join('\n\n');
  }
  if (typeof value !== 'object' || value === null) {
    return '';
  }
  const { kind, value: body, language } = value as {
    kind?: unknown;
    value?: unknown;
    language?: unknown;
  };
  if (typeof body !== 'string') {
    return '';
  }
  // `MarkedString` with a language: fenced, so the frontend's markdown renderer
  // highlights it instead of re-flowing a signature into a paragraph.
  if (typeof language === 'string' && language.length > 0 && kind === undefined) {
    return `\`\`\`${language}\n${body}\n\`\`\``;
  }
  return body;
}

/**
 * Definition results (a `Location`, a `LocationLink`, or an array of either) as
 * locations inside the project, in the order the server gave them.
 */
export function locationsFrom(result: unknown, cwd: string): LspLocation[] {
  const items = Array.isArray(result) ? result : [result];
  const locations: LspLocation[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const { uri, targetUri, range, targetRange, targetSelectionRange } = item as Record<
      string,
      unknown
    >;
    // A `LocationLink` prefers the selection range: the target range is the whole
    // declaration (a class body), and a preview should land on the name.
    const absolute = fromFileUri(uri ?? targetUri);
    const spot = rangeFrom(range ?? targetSelectionRange ?? targetRange);
    const path = absolute === undefined ? undefined : relativeWithin(cwd, absolute);
    if (path === undefined || spot === undefined) {
      continue;
    }
    locations.push({ path, range: spot });
  }
  return locations;
}
