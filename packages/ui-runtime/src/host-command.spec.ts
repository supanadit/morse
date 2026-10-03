import { describe, expect, it } from 'vitest';
import { parseHostMessage } from '@morse/protocol';
import { createMorseClient } from './client.js';
import { MemoryHostTransport } from './transport/memory-transport.js';

/**
 * `host/command/result` is a host -> frontend message, so it must pass the same
 * `parseHostMessage` guard every transport applies to incoming frames. It was
 * missing from `HOST_MESSAGE_TYPES`, which made the VS Code transport silently
 * drop the reply and left the file picker with "no workspace files".
 */
describe('host/command/result', () => {
  it('survives the host-message guard', () => {
    const message = parseHostMessage({
      type: 'host/command/result',
      payload: { requestId: 'host-1', ok: true, data: { files: ['README.md'] } },
    });

    expect(message?.type).toBe('host/command/result');
  });

  it('resolves a pending host command with its value', async () => {
    const client = createMorseClient({ transport: new MemoryHostTransport() });

    const value = (await client.actions.hostCommand('listFiles')) as { files?: string[] };
    expect(value.files).toContain('README.md');

    client.dispose();
  });
});
