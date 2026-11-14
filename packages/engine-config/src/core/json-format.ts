/**
 * The JSON and JSONC format: parsing, a bounded error snippet, and two-space
 * serialization. Reading is lenient so a hand-edited file with comments still
 * yields a value; writing is always strict JSON.
 */
import type { ConfigIssue, ConfigScope } from '@morse/protocol';

/** What a format's parse produced: the value, whether the text was strict, and the complaints. */
export interface ConfigParseResult {
  value: unknown;
  strict: boolean;
  issues: ConfigIssue[];
}

/** The text-level half of a config file: how bytes become a value and back. */
export abstract class ConfigFormat {
  abstract readonly kind: 'json' | 'jsonc';
  abstract parse(text: string, path: string, fileId: string, scope: ConfigScope): ConfigParseResult;
  abstract serialize(value: unknown): string;
}

/** How much of the offending region a parse issue carries. */
const SNIPPET_LIMIT = 400;

/** Strict JSON both ways; JSONC only on the way in. */
export class JsonFormat extends ConfigFormat {
  readonly kind = 'json';

  /**
   * Strict JSON first. When that fails, strip comments and trailing commas and
   * try again: a successful second parse is JSONC (`strict: false`) and carries
   * one fixable `normalize` issue. A second failure is a real syntax error, and
   * the issue quotes the first (native) parser message with a bounded snippet
   * of the original text.
   */
  parse(raw: string, path: string, fileId: string, scope: ConfigScope): ConfigParseResult {
    // A byte-order mark is not part of the JSON value but `JSON.parse` rejects
    // it; an editor on Windows may save one, and such a file must still read.
    const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
    if (text.trim().length === 0) {
      return { value: undefined, strict: true, issues: [] };
    }
    try {
      return { value: JSON.parse(text) as unknown, strict: true, issues: [] };
    } catch (error) {
      const stripped = stripJsonc(text);
      if (stripped.trim().length === 0) {
        // Nothing but whitespace and comments: an empty document, which a write
        // may initialize rather than an unfixable syntax error.
        return { value: undefined, strict: true, issues: [] };
      }
      try {
        const value = JSON.parse(stripped) as unknown;
        return {
          value,
          strict: false,
          issues: [
            {
              file: path,
              fileId,
              scope,
              code: 'normalize',
              message: `${path}: comments and trailing commas will be dropped when this file is written.`,
              fixable: true,
            },
          ],
        };
      } catch {
        return {
          value: undefined,
          strict: true,
          issues: [parseIssue(error, text, path, fileId, scope)],
        };
      }
    }
  }

  serialize(value: unknown): string {
    const text = JSON.stringify(value, null, 2);
    if (text === undefined) {
      throw new TypeError('Cannot serialize a value JSON cannot represent.');
    }
    return `${text}\n`;
  }
}

/** The original text with comments and trailing commas removed, outside strings only. */
export function stripJsonc(text: string): string {
  return stripTrailingCommas(stripComments(text));
}

function parseIssue(
  error: unknown,
  text: string,
  path: string,
  fileId: string,
  scope: ConfigScope,
): ConfigIssue {
  const native = error instanceof Error ? error.message : String(error);
  return {
    file: path,
    fileId,
    scope,
    code: 'parse',
    message: `${path}: ${native}`,
    snippet: snippetAt(text, errorOffset(native, text)),
    fixable: false,
  };
}

/**
 * Where the native parser pointed, as a byte offset: a reported position is
 * exact, a line/column pair is counted out, and an `Unexpected token` message
 * (which only quotes a window of the text) locates its window.
 */
function errorOffset(message: string, text: string): number {
  const position = /at position (\d+)/.exec(message);
  if (position) {
    return clamp(Number(position[1]), 0, text.length);
  }
  const lineColumn = /at line (\d+) column (\d+)/.exec(message);
  if (lineColumn) {
    const lines = text.split('\n');
    let offset = 0;
    for (let index = 0; index < Math.min(Number(lineColumn[1]) - 1, lines.length); index += 1) {
      offset += lines[index]!.length + 1;
    }
    return clamp(offset + Number(lineColumn[2]) - 1, 0, text.length);
  }
  const fragment = quotedFragment(message);
  if (fragment !== undefined) {
    const at = text.indexOf(fragment);
    if (at >= 0) {
      return at;
    }
  }
  if (message.includes('Unexpected end of JSON input')) {
    return text.length;
  }
  return 0;
}

/**
 * V8's `Unexpected token` messages carry the offending window as `...<text>...`,
 * shortened to the error's neighbourhood. The window is verbatim file text, so
 * finding it locates the error even when it was cut short.
 */
function quotedFragment(message: string): string | undefined {
  const marker = ' is not valid JSON';
  if (!message.endsWith(marker)) {
    return undefined;
  }
  const separator = message.indexOf(', ');
  if (separator === -1) {
    return undefined;
  }
  let fragment = message.slice(separator + 2, message.length - marker.length);
  if (fragment.startsWith('...')) {
    fragment = fragment.slice(3);
  }
  if (fragment.endsWith('...')) {
    fragment = fragment.slice(0, -3);
  }
  if (fragment.startsWith('"')) {
    fragment = fragment.slice(1);
  }
  if (fragment.endsWith('"')) {
    fragment = fragment.slice(0, -1);
  }
  return fragment.length > 0 ? fragment : undefined;
}

/** Two lines around the offset, capped, so a huge file cannot flood an issue. */
function snippetAt(text: string, offset: number): string {
  const lines = text.split('\n');
  const line = text.slice(0, clamp(offset, 0, text.length)).split('\n').length - 1;
  const start = Math.max(0, line - 1);
  const snippet = lines.slice(start, Math.min(lines.length, start + 2)).join('\n');
  return snippet.length > SNIPPET_LIMIT ? snippet.slice(0, SNIPPET_LIMIT) : snippet;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function stripComments(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      const end = stringEnd(text, index);
      out += text.slice(index, end);
      index = end;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') {
        index += 1;
      }
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      index = close === -1 ? text.length : close + 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      const end = stringEnd(text, index);
      out += text.slice(index, end);
      index = end;
      continue;
    }
    if (char === ',') {
      let next = index + 1;
      while (next < text.length && isJsonWhitespace(text[next]!)) {
        next += 1;
      }
      if (text[next] === '}' || text[next] === ']') {
        index += 1;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return out;
}

/** The index just past the string literal opening at `start`, honouring escapes. */
function stringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2;
      continue;
    }
    index += 1;
    if (text[index - 1] === '"') {
      return index;
    }
  }
  return text.length;
}

function isJsonWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}
