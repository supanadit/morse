import { describe, expect, it, vi } from 'vitest';
import { createLspFrameReader, encodeLspMessage, type LspMessage } from './lsp-protocol';

/** One frame's bytes, as the reader would receive them. */
function frame(message: LspMessage): Buffer {
  return encodeLspMessage(message);
}

function reader(): { messages: LspMessage[]; errors: Error[]; feed: (chunk: Buffer) => void } {
  const messages: LspMessage[] = [];
  const errors: Error[] = [];
  const feed = createLspFrameReader(
    (message) => messages.push(message),
    (error) => errors.push(error),
  );
  return { messages, errors, feed };
}

describe('LSP framing', () => {
  it('writes the byte length, not the character count', () => {
    // `—` is one character and three bytes: a reader counting characters would
    // desynchronise on exactly this frame.
    const encoded = encodeLspMessage({ jsonrpc: '2.0', method: 'x', params: { text: '—' } });
    const header = encoded.subarray(0, encoded.indexOf('\r\n\r\n')).toString('ascii');
    const body = encoded.subarray(encoded.indexOf('\r\n\r\n') + 4);
    expect(header).toBe(`Content-Length: ${body.byteLength}`);
    expect(body.byteLength).toBeGreaterThan(body.toString('utf8').length);
  });

  it('reads one frame per message', () => {
    const { messages, feed } = reader();
    feed(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    feed(frame({ jsonrpc: '2.0', method: 'initialized', params: {} }));
    expect(messages).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'initialized', params: {} },
    ]);
  });

  it('keeps a frame whole when it arrives in pieces', () => {
    const { messages, feed } = reader();
    const bytes = frame({ jsonrpc: '2.0', id: 2, result: { answer: 'split' } });
    for (const byte of bytes) {
      feed(Buffer.from([byte]));
    }
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 2, result: { answer: 'split' } }]);
  });

  it('reads several frames out of one chunk', () => {
    const { messages, feed } = reader();
    feed(Buffer.concat([frame({ id: 1, result: 'a' }), frame({ id: 2, result: 'b' })]));
    expect(messages.map((message) => message.result)).toEqual(['a', 'b']);
  });

  it('drops a body that is not JSON and keeps reading', () => {
    const { messages, errors, feed } = reader();
    const broken = Buffer.concat([
      Buffer.from('Content-Length: 7\r\n\r\n', 'ascii'),
      Buffer.from('notjson', 'utf8'),
    ]);
    feed(Buffer.concat([broken, frame({ id: 3, result: 'after' })]));
    expect(errors).toHaveLength(1);
    expect(messages).toEqual([{ id: 3, result: 'after' }]);
  });

  it('resynchronises after a header it cannot read', () => {
    const { messages, errors, feed } = reader();
    feed(Buffer.concat([Buffer.from('garbage\r\n\r\n', 'ascii'), frame({ id: 4, result: 'ok' })]));
    expect(errors).toHaveLength(1);
    expect(messages).toEqual([{ id: 4, result: 'ok' }]);
  });

  it('waits for the rest of a frame instead of reporting it', () => {
    const { messages, errors, feed } = reader();
    const bytes = frame({ id: 5, result: 'later' });
    feed(bytes.subarray(0, bytes.length - 3));
    expect(messages).toHaveLength(0);
    expect(errors).toHaveLength(0);
    feed(bytes.subarray(bytes.length - 3));
    expect(messages).toEqual([{ id: 5, result: 'later' }]);
  });

  it('reports a header with no usable length once', () => {
    const onError = vi.fn();
    const feed = createLspFrameReader(() => undefined, onError);
    feed(Buffer.from('Content-Length: abc\r\n\r\n', 'ascii'));
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
