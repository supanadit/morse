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
 * The server runs as `morse` and reaches for root only through passwordless
 * sudo entries baked into the image. Isolation is per-uid, not per-group:
 * every home is `<user>:<user>` mode `2750` plus a default ACL granting
 * exactly uid `morse` read/write (so agents keep working) — and nothing
 * grants one login user access to another's tree. Both sides run umask 002
 * (the server sets it at boot, sshd sessions via `/etc/login.defs`).
 */

/** True only where the image opted into OS users (`MORSE_OS_USERS=1`). */
export function osUsersEnabled(): boolean {
  return process.env.MORSE_OS_USERS === '1';
}

/** The login shell every workspace user gets: their own `~/.zshrc` to keep. */
const USER_SHELL = '/bin/zsh';

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

/** Runs a read-only lookup (no sudo): `id -gn <user>` for group repair. */
function lookup(args: string[]): string | undefined {
  try {
    const result = spawnSync(args[0] as string, args.slice(1), {
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (result.error !== undefined || result.status !== 0) {
      return undefined;
    }
    return (result.stdout ?? '').trim();
  } catch {
    return undefined;
  }
}

/**
 * Creates the Linux user for a Morse login (idempotent — an existing user is
 * success) without touching its password. Users get a private group and are
 * never in any shared group, so no sudo, no cross-home reads: exactly their
 * tree, nothing else. Never throws.
 */
export function ensureOsUser(username: string, warn: (message: string) => void): void {
  if (!osUsersEnabled()) {
    return;
  }
  // Default shadow behavior: private group `<user>`, primary group `<user>`.
  // `-M` because the workspace directory is the server's to create, not
  // shadow's. No `-g morse`, no supplementary groups — a shared group would
  // let every user into every home.
  const created = sudo([
    '/usr/sbin/useradd',
    '-M',
    '-s',
    USER_SHELL,
    '-d',
    osUserHome(username),
    username,
  ]);
  if (!created.ok && !/already exists/i.test(created.error ?? '')) {
    warn(`Could not create OS user "${username}": ${created.error}`);
    return;
  }
  // Legacy repair (pre-private-group accounts): primary group back to the
  // private one, dropped from the shared `morse` group.
  if (lookup(['/usr/bin/id', '-gn', username]) !== username) {
    sudo(['/usr/sbin/groupadd', username]);
    const regrouped = sudo(['/usr/sbin/usermod', '-g', username, username]);
    if (!regrouped.ok) {
      warn(`Could not repair the group for "${username}": ${regrouped.error}`);
    }
  }
  sudo(['/usr/bin/gpasswd', '-d', username, 'morse']);
  // Pre-zsh accounts keep their old shell unless repaired: every login
  // converges on it, idempotently.
  const shelled = sudo(['/usr/sbin/usermod', '-s', USER_SHELL, username]);
  if (!shelled.ok) {
    warn(`Could not set the shell for "${username}": ${shelled.error}`);
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
 * Fixes a workspace directory up for SSH: owned by its user and private
 * group, unreadable to anyone else, with a default ACL that lets exactly uid
 * `morse` (the server) keep working inside. The user reaches it through
 * ownership, the server through the ACL, nobody else at all.
 */
export function ownOsHome(username: string, path: string, warn: (message: string) => void): void {
  if (!osUsersEnabled()) {
    return;
  }
  const owned = sudo(['/usr/bin/chown', `${username}:${username}`, path]);
  if (!owned.ok) {
    warn(`Could not hand "${path}" to "${username}": ${owned.error}`);
    return;
  }
  const flagged = sudo(['/usr/bin/chmod', '2750', path]);
  if (!flagged.ok) {
    warn(`Could not set the mode on "${path}": ${flagged.error}`);
    return;
  }
  // Access ACL: only owner + uid morse. Default ACL: new files stay reachable
  // by both, and the private group keeps write under umask 002.
  const fenced = sudo([
    '/usr/bin/setfacl',
    '-m',
    'u:morse:rwx',
    '-d',
    '-m',
    `u::rwx,u:morse:rwx,g::rwx,g:${username}:rwx,m::rwx,o::---`,
    path,
  ]);
  if (!fenced.ok) {
    warn(`Could not fence "${path}" for "${username}": ${fenced.error}`);
    return;
  }
  // Seed `~/.zshrc` once from the image skeleton — only when the user has
  // none, so their edits are never clobbered.
  const seeded = sudo(['/usr/bin/cp', '-n', '/etc/skel/.zshrc', `${path}/.zshrc`]);
  if (!seeded.ok) {
    warn(`Could not seed .zshrc for "${username}": ${seeded.error}`);
    return;
  }
  const zshrc = sudo(['/usr/bin/chown', `${username}:${username}`, `${path}/.zshrc`]);
  if (!zshrc.ok) {
    warn(`Could not hand .zshrc to "${username}": ${zshrc.error}`);
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
