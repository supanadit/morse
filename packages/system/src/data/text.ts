/** Text conversions shared by the adapters' event mappings. */
import { readFileSync } from 'node:fs';

/** A file's text, or undefined when it is absent: an absent file is "" not an error. */
export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** The last path segment, on either separator; the whole path when there is none. */
export function baseName(path: string): string {
  return (
    path
      .split(/[\\/]/)
      .filter((part) => part.length > 0)
      .at(-1) ?? path
  );
}

/** A tool result as one line: whitespace collapsed, cut at `max` with an ellipsis. */
export function truncate(value: string, max: number): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

/** JSON for a tool value; a string stays itself, and an unserializable value is text. */
export function safeStringify(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
