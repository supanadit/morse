import { afterEach, describe, expect, it } from 'vitest';
import { resolveTransport } from './resolve-transport.js';
import { VsCodeHostTransport } from './vscode-transport.js';

const host = globalThis as { acquireVsCodeApi?: () => unknown };

afterEach(() => {
  delete host.acquireVsCodeApi;
});

describe('resolveTransport', () => {
  it('picks the VS Code bridge and acquires the API exactly once', () => {
    let calls = 0;
    host.acquireVsCodeApi = () => {
      calls += 1;
      if (calls > 1) {
        // This is what VS Code itself throws on the second call, and it used to
        // abort the whole bootstrap — leaving the webview blank.
        throw new Error('An instance of the VS Code API has already been acquired');
      }
      return { postMessage: () => undefined };
    };

    const transport = resolveTransport();

    expect(transport).toBeInstanceOf(VsCodeHostTransport);
    expect(calls).toBe(1);
  });

  it('uses the in-memory mock host for ?mock=1', () => {
    expect(resolveTransport({ href: 'http://localhost/?mock=1' }).kind).toBe('memory');
  });

  it('falls back to a WebSocket transport outside VS Code', () => {
    const transport = resolveTransport({ href: 'https://morse.test/chat' });

    expect(transport.kind).toBe('websocket');
  });
});
