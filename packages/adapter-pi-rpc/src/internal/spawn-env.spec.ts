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

  it('drops the session identity Morse itself was launched with', () => {
    // Morse started from inside pi (or a shell pi exported into) would otherwise
    // hand its own session to the pi it spawns.
    const cleaned = cleanSpawnEnv({
      PATH: '/usr/bin',
      PI_SESSION_ID: '01a114bf-67f4-7536-b03f-f72b22854760',
      PI_SESSION_FILE: '/home/u/.pi/agent/sessions/s.jsonl',
      PI_PROVIDER: 'ollama-native',
      PI_MODEL: 'deepseek-v4.1-flash',
      PI_REASONING_LEVEL: 'low',
    });

    expect(cleaned).toEqual({ PATH: '/usr/bin' });
  });

  it('keeps PI_ variables that are configuration rather than session state', () => {
    const cleaned = cleanSpawnEnv({
      PI_CODING_AGENT: 'true',
      PI_CODING_AGENT_DIR: '/tmp/agent',
    });

    expect(cleaned).toEqual({ PI_CODING_AGENT: 'true', PI_CODING_AGENT_DIR: '/tmp/agent' });
  });

  it('does not mutate the source environment', () => {
    const source = { PATH: '/usr/bin', NODE_CHANNEL_FD: '3' };
    cleanSpawnEnv(source);

    expect(source).toHaveProperty('NODE_CHANNEL_FD', '3');
  });
});
