import { spawnSync } from 'node:child_process';

/**
 * Real OS users for multi-user hosts (container only).
 *
 * Each Morse login user also exists as a Linux user whose home is
 * `/home/<username>` — a symlink into the single workspaces volume — so they
 * can SSH straight into their own tree with the same password they use in
 * Morse. Provisioning is best-effort and gated on `MORSE_OS_USERS=1` (set in
 * the container image, off everywhere else): outside the container every
 * function below is a silent no-op and user management never fails because
 * of it.
 *
 * The server runs as `morse` and reaches for root only through three
 * passwordless sudo entries baked into the image (`useradd`, `usermod`,
 * `chpasswd`). Files stay dual-writable because every home is
 * `<user>:morse` with the `morse` group, and both sides run umask 002 (the
 * server sets it at boot, sshd sessions via `/etc/login.defs`).
 */

/** True only where the image opted into OS users (`MORSE_OS_USERS=1`). */
export function osUsersEnabled(): boolean {
  return process.env.MORSE_OS_USERS === '1';
}

/** The home directory of a login user on OS-user hosts. */
export function osUserHome(username: string): string {
  return `/home/${username}`;
}

function sudo(args: string[], input?: string): { ok: boolean; error?: string } {
  try {
    const result = spawnSync('sudo', ['-n', ...args], {
      input,
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (result.error !== undefined) {
      return { ok: false, error: String(result.error) };
    }
    if (result.status === 0) {
      return { ok: true };
    }
    return { ok: false, error: (result.stderr ?? '').trim() || `exit ${result.status}` };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * Creates the Linux user for a Morse login (idempotent — an existing user is
 * success) without touching its password. Never throws.
 */
export function ensureOsUser(username: string, warn: (message: string) => void): void {
  if (!osUsersEnabled()) {
    return;
  }
  // Primary group `morse`, no private group: every file the user makes over
  // SSH is group `morse`, which is exactly what the server (and every other
  // user of this host) writes as. `-M` because the workspace directory is
  // the server's to create, not shadow's.
  const created = sudo([
    '/usr/sbin/useradd',
    '-M',
    '-N',
    '-g',
    'morse',
    '-d',
    osUserHome(username),
    '-s',
    '/bin/bash',
    username,
  ]);
  if (!created.ok && !/already exists/i.test(created.error ?? '')) {
    warn(`Could not create OS user "${username}": ${created.error}`);
  }
}

/** Points a login user's OS password at their Morse one. Never throws. */
export function setOsPassword(username: string, password: string, warn: (message: string) => void): void {
  if (!osUsersEnabled()) {
    return;
  }
  const keyed = sudo(['/usr/sbin/chpasswd'], `${username}:${password}`);
  if (!keyed.ok) {
    warn(`Could not set the SSH password for "${username}": ${keyed.error}`);
  }
}

/**
 * Creates the Linux user for a Morse login (idempotent — an existing user is
 * success) and points their password at the Morse one. Never throws: the
 * login itself must work even where provisioning cannot (non-container
 * installs, missing sudo).
 */
export function syncOsUser(username: string, password: string, warn: (message: string) => void): void {
  ensureOsUser(username, warn);
  setOsPassword(username, password, warn);
}

/**
 * Fixes a workspace directory up for SSH: owned by its user, group `morse`,
 * setgid so everything created under it inherits the group. The server keeps
 * full access through the group; the user through ownership.
 */
export function ownOsHome(username: string, path: string, warn: (message: string) => void): void {
  if (!osUsersEnabled()) {
    return;
  }
  const owned = sudo(['/usr/bin/chown', `${username}:morse`, path]);
  if (!owned.ok) {
    warn(`Could not hand "${path}" to "${username}": ${owned.error}`);
    return;
  }
  const flagged = sudo(['/usr/bin/chmod', '2770', path]);
  if (!flagged.ok) {
    warn(`Could not set the mode on "${path}": ${flagged.error}`);
  }
}

/** Drops the Linux user on Morse user delete. The home (their data) stays. */
export function removeOsUser(username: string, warn: (message: string) => void): void {
  if (!osUsersEnabled()) {
    return;
  }
  const removed = sudo(['/usr/sbin/userdel', username]);
  if (!removed.ok) {
    warn(`Could not remove OS user "${username}": ${removed.error}`);
  }
}
