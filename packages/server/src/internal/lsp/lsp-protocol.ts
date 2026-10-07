/**
 * LSP's own framing: `Content-Length`-prefixed JSON-RPC over a byte stream.
 *
 * The one thing worth being careful about is that the length is in *bytes*, not
 * characters. A source file with a `—` in it would desynchronise a reader that
 * counted characters, so the buffer here is accumulated as `Buffer`s and the
 * header is the only part read as text (ASCII, by the protocol's definition).
 *
 * Kept free of `node:*` semantics beyond `Buffer` so it can be unit tested with
 * hand-written frames.
 */

/** A JSON-RPC frame, in either direction. One shape covers all four kinds. */
export interface LspMessage {
  jsonrpc?: string;
  /** Present on requests and responses; absent on notifications. */
  id?: number | string;
  /** Present on requests and notifications. */
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const HEADER_END = '\r\n\r\n';

/** Wraps one message in LSP's header and body, ready to write to a pipe. */
export function encodeLspMessage(message: LspMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

/**
 * A stateful frame reader for one stream. Feed it whatever chunks arrive; it
 * calls `onMessage` once per complete frame and keeps the remainder.
 *
 * A frame whose body is not valid JSON is dropped (and reported through
 * `onError` when one is given) rather than thrown: one malformed message must
 * not take down a session, the same rule the wire's own parsers follow.
 */
export function createLspFrameReader(
  onMessage: (message: LspMessage) => void,
  onError?: (error: Error) => void,
): (chunk: Buffer) => void {
  let pending: Buffer = Buffer.alloc(0);
  return (chunk: Buffer): void => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    for (;;) {
      const headerEnd = pending.indexOf(HEADER_END);
      if (headerEnd < 0) {
        return;
      }
      const header = pending.subarray(0, headerEnd).toString('ascii');
      const length = contentLength(header);
      if (length === undefined) {
        // An unreadable header cannot be resynchronised: drop it and keep the
        // rest, so a stray log line does not stall every later message.
        onError?.(new Error(`LSP frame without a usable Content-Length: ${header}`));
        pending = pending.subarray(headerEnd + HEADER_END.length);
        continue;
      }
      const bodyStart = headerEnd + HEADER_END.length;
      const bodyEnd = bodyStart + length;
      if (pending.length < bodyEnd) {
        return;
      }
      const body = pending.subarray(bodyStart, bodyEnd).toString('utf8');
      pending = pending.subarray(bodyEnd);
      try {
        onMessage(JSON.parse(body) as LspMessage);
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };
}

/** The `Content-Length` of a header block, or `undefined` when it is unusable. */
function contentLength(header: string): number | undefined {
  for (const line of header.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) {
      continue;
    }
    if (line.slice(0, colon).trim().toLowerCase() !== 'content-length') {
      continue;
    }
    const value = Number.parseInt(line.slice(colon + 1).trim(), 10);
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  return undefined;
}
