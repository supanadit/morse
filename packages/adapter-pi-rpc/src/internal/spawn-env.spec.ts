import { describe, expect, it } from 'vitest';
import { cleanSpawnEnv } from './spawn-env.js';

describe('cleanSpawnEnv', () => {
  it('drops the IPC channel a `node --watch` parent leaks into the environment', () => {
    const cleaned = cleanSpawnEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      NODE_CHANNEL_FD: '3',
      NODE_CHANNEL_SERIALIZATION_MODE: 'json',
    });

    expect(cleaned).toEqual({ PATH: '/usr/bin', HOME: '/home/u' });
  });

  it('leaves pi configuration and credentials alone', () => {
    const cleaned = cleanSpawnEnv({
      PI_CODING_AGENT_DIR: '/tmp/agent',
      MORSE_PI_PATH: '/opt/pi',
      ANTHROPIC_API_KEY: 'secret',
    });

    expect(cleaned).toEqual({
      PI_CODING_AGENT_DIR: '/tmp/agent',
      MORSE_PI_PATH: '/opt/pi',
      ANTHROPIC_API_KEY: 'secret',
    });
  });

  it('does not mutate the source environment', () => {
    const source = { PATH: '/usr/bin', NODE_CHANNEL_FD: '3' };
    cleanSpawnEnv(source);

    expect(source).toHaveProperty('NODE_CHANNEL_FD', '3');
  });
});
