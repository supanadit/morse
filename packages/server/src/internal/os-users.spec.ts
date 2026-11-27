import { describe, expect, it } from 'vitest';
import { osUserHome, osUsersEnabled } from './os-users.js';

/** OS-user provisioning stays a no-op off the container (`MORSE_OS_USERS` unset). */
describe('os-users', () => {
  it('builds the home path off /home', () => {
    expect(osUserHome('bob')).toBe('/home/bob');
  });

  it('is disabled without the flag and never spawns', () => {
    expect(osUsersEnabled()).toBe(false);
  });
});
