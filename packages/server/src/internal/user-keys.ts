import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { GpgStatus, SshStatus } from '@morse/protocol';

function sshDir(home: string): string {
  return join(home, '.ssh');
}

function ensureSshDir(home: string): string {
  const dir = sshDir(home);
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort */
  }
  return dir;
}

function readKey(dir: string, name: string): { publicKey: string; hasPrivate: boolean; type: string } {
  const pub = join(dir, `${name}.pub`);
  const priv = join(dir, name);
  let publicKey = '';
  try {
    publicKey = existsSync(pub) ? readFileSync(pub, 'utf8').trim() : '';
  } catch {
    publicKey = '';
  }
  const type = publicKey.startsWith('ssh-ed25519') ? 'ed25519' : publicKey.startsWith('ssh-rsa') ? 'rsa' : 'unknown';
  return { publicKey, hasPrivate: existsSync(priv), type };
}

const MANAGED = ['id_ed25519', 'id_rsa'];

/** Lists the member's managed keys plus their authorized_keys. */
export function sshStatusFor(home: string, username: string): SshStatus {
  const dir = ensureSshDir(home);
  const keys = MANAGED.map((name) => ({ name, ...readKey(dir, name) })).filter(
    (k) => k.publicKey.length > 0 || k.hasPrivate,
  );
  let authorizedKeys: string[] = [];
  try {
    const raw = existsSync(join(dir, 'authorized_keys')) ? readFileSync(join(dir, 'authorized_keys'), 'utf8') : '';
    authorizedKeys = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
  } catch {
    authorizedKeys = [];
  }
  return { username, home, keys, authorizedKeys };
}

/** Generates (or re-generates) one managed key with `ssh-keygen`. */
export function generateSshKey(home: string, username: string, type: 'ed25519' | 'rsa' = 'ed25519'): SshStatus {
  const dir = ensureSshDir(home);
  const name = type === 'rsa' ? 'id_rsa' : 'id_ed25519';
  const keyPath = join(dir, name);
  const args =
    type === 'rsa'
      ? ['-t', 'rsa', '-b', '3072', '-f', keyPath, '-N', '', '-q', '-C', `${username}@morse`]
      : ['-t', 'ed25519', '-f', keyPath, '-N', '', '-q', '-C', `${username}@morse`];
  // `-f` refuses to overwrite without `-y`; remove first so regenerate works.
  const wipe = (p: string): void => {
    try {
      if (existsSync(p)) {
        // eslint-disable-next-line no-sync -- CLI-adjacent keygen, one shot.
        execFileSync('rm', ['-f', p, `${p}.pub`]);
      }
    } catch {
      /* fall through to keygen error */
    }
  };
  wipe(keyPath);
  const result = spawnSync('ssh-keygen', args, { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) {
    throw new Error((result.stderr ?? '').trim() || 'ssh-keygen failed. Install OpenSSH or use a terminal.');
  }
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    /* best-effort */
  }
  return sshStatusFor(home, username);
}

/** Deletes one managed key pair (`id_ed25519` or `id_rsa`), both files. */
export function deleteSshKey(home: string, username: string, name: string): SshStatus {
  if (!MANAGED.includes(name)) {
    throw new Error('Unknown key.');
  }
  const dir = ensureSshDir(home);
  for (const suffix of ['', '.pub']) {
    try {
      const target = join(dir, `${name}${suffix}`);
      if (existsSync(target)) {
        // eslint-disable-next-line no-sync -- CLI-adjacent key delete, one shot.
        execFileSync('rm', ['-f', target]);
      }
    } catch {
      /* best-effort per file */
    }
  }
  return sshStatusFor(home, username);
}

/** Reads one private key — the only path private material leaves the host. */
export function readSshPrivate(home: string, name: string): string {
  if (!MANAGED.includes(name)) {
    throw new Error('Unknown key.');
  }
  const path = join(ensureSshDir(home), name);
  if (!existsSync(path)) {
    throw new Error('No such private key.');
  }
  return readFileSync(path, 'utf8');
}

/** Replaces `authorized_keys` (one key per line), mode 600. */
export function saveAuthorizedKeys(home: string, username: string, keys: string[]): SshStatus {
  const dir = ensureSshDir(home);
  const lines = keys
    .map((k) => k.trim())
    .filter((k) => k.length > 0 && !k.startsWith('#') && (k.startsWith('ssh-') || k.startsWith('ecdsa-')));
  if (lines.length !== keys.map((k) => k.trim()).filter((k) => k.length > 0).length) {
    throw new Error('Each line must be an SSH public key.');
  }
  const path = join(dir, 'authorized_keys');
  writeFileSync(path, `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort */
  }
  return sshStatusFor(home, username);
}

function gnupgHome(home: string): string {
  const dir = join(home, '.gnupg');
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort */
  }
  return dir;
}

/** Lists the member's GPG keys (`gpg --list-keys --with-colons`). */
export function gpgStatusFor(home: string, username: string): GpgStatus {
  const keys: GpgStatus['keys'] = [];
  try {
    const out = execFileSync('gpg', ['--homedir', gnupgHome(home), '--list-keys', '--with-colons'], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    let current: { id: string; uids: string[]; fingerprint?: string } | undefined;
    for (const line of out.split('\n')) {
      const parts = line.split(':');
      if (parts[0] === 'pub' && parts[4]) {
        current = { id: parts[4].slice(-16), uids: [] };
        keys.push(current);
      } else if (parts[0] === 'fpr' && current && parts[9] && current.fingerprint === undefined) {
        current.fingerprint = parts[9];
      } else if (parts[0] === 'uid' && current && parts[9]) {
        current.uids.push(parts[9]);
      }
    }
  } catch {
    /* gpg missing or empty homedir: no keys */
  }
  // Least surprise: surface any stray public key files as unreadable is out of
  // scope; the terminal (`gpg --list-keys`) is the fallback.
  void username;
  return { username, keys };
}

/** Exports one armored key (`--export` or `--export-secret-keys`). */
function exportGpgArmor(home: string, keyId: string | undefined, secret: boolean): string {
  const args = [
    '--homedir',
    gnupgHome(home),
    '--armor',
    secret ? '--export-secret-keys' : '--export',
    ...(keyId !== undefined && keyId.length > 0 ? [keyId] : []),
  ];
  try {
    const out = execFileSync('gpg', args, { encoding: 'utf8', timeout: 15_000 });
    if (!out.includes('BEGIN PGP')) {
      throw new Error('No GPG key to export yet.');
    }
    return out;
  } catch (error: unknown) {
    if (error instanceof Error && /No GPG key/.test(error.message)) {
      throw error;
    }
    throw new Error(
      'Could not export the GPG key. Install it first (`sudo apt-get install -y gnupg`, or `brew install gnupg` on macOS).',
    );
  }
}

/** The armored public key block, for copying into GitHub/GitLab. */
export function exportGpgPublic(home: string, keyId?: string): string {
  return exportGpgArmor(home, keyId, false);
}

/** The armored private key block — the only path it leaves the host. */
export function exportGpgSecret(home: string, keyId?: string): string {
  return exportGpgArmor(home, keyId, true);
}

/**
 * Generates one RSA GPG key with no passphrase (server-side agent use).
 * Uses `--quick-generate-key` rather than a batch parameter file: the same
 * result with no parameter parser in the path (which proved flaky).
 */
export function generateGpgKey(home: string, username: string, name?: string, email?: string): GpgStatus {
  const real = (name ?? username).slice(0, 80);
  const userId = email !== undefined && email.length > 0 ? `${real} <${email}>` : real;
  const result = spawnSync(
    'gpg',
    [
      '--homedir',
      gnupgHome(home),
      '--batch',
      '--pinentry-mode',
      'loopback',
      '--passphrase',
      '',
      '--quick-generate-key',
      userId,
      'rsa3072',
      'sign,encr',
      'never',
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  if (result.status !== 0) {
    throw new Error(
      (result.stderr ?? '').trim() ||
        'gpg failed. Install it first (`sudo apt-get install -y gnupg`, or `brew install gnupg` on macOS), then retry.',
    );
  }
  // Readdir keeps the homedir honest for tests that stub the binary.
  void readdirSync;
  return gpgStatusFor(home, username);
}

/** Deletes one GPG key (secret + public) by id or fingerprint. */
export function deleteGpgKey(home: string, username: string, keyId: string): GpgStatus {
  if (!/^[0-9A-Fa-f]{8,40}$/.test(keyId.trim())) {
    throw new Error('Unknown key.');
  }
  const result = spawnSync(
    'gpg',
    ['--homedir', gnupgHome(home), '--batch', '--yes', '--delete-secret-and-public-key', keyId.trim()],
    { encoding: 'utf8', timeout: 30_000 },
  );
  if (result.status !== 0) {
    throw new Error((result.stderr ?? '').trim() || 'Could not delete the GPG key.');
  }
  return gpgStatusFor(home, username);
}
