import { describe, expect, it } from 'vitest';
import { createMorseClient } from '../client.js';
import { MemoryHostTransport } from './memory-transport.js';

describe('mock git history', () => {
  it('scopes the log to the named ref', async () => {
    const client = createMorseClient({ transport: new MemoryHostTransport() });
    const log = (await client.actions.hostCommand('gitLog', { ref: 'origin/main' })) as {
      commits: Array<{ subject: string }>;
    };

    expect(log.commits.map((c) => c.subject)).not.toContain(
      'Add the git panel to the browser host',
    );
    expect(log.commits.map((c) => c.subject)).toContain('Merge branch feature/graph');
    client.dispose();
  });

  it('shows an amended message in the mock log', async () => {
    const client = createMorseClient({ transport: new MemoryHostTransport() });
    await client.actions.hostCommand('gitCommit', { message: 'rewritten', amend: true });
    const log = (await client.actions.hostCommand('gitLog', {})) as {
      commits: Array<{ subject: string }>;
    };

    expect(log.commits[0]?.subject).toBe('rewritten');
    client.dispose();
  });
});
