import { execFileSync, spawnSync } from 'node:child_process';
import type { GitIdentity } from '@morse/protocol';

/**
 * One member's global git identity (`~/.gitconfig`), managed self-service.
 *
 * Read and written through `git config --global` with `HOME` pointed at the
 * member's tree — never the server's own home — so the file lands where every
 * shell, agent and SSH session already looks. Only the allowlisted keys below
 * are touched: the panel owns identity, not repository or credential state.
 */

const KEYS = {
  name: 'user.name',
  email: 'user.email',
  editor: 'core.editor',
  defaultBranch: 'init.defaultBranch',
  pullRebase: 'pull.rebase',
  autoSetupRemote: 'push.autoSetupRemote',
  gpgSign: 'commit.gpgsign',
  signingKey: 'user.signingkey',
} as const;

type Field = keyof typeof KEYS;

/** The writable identity fields (everything on the wire except username/home). */
export const GIT_IDENTITY_FIELDS = Object.keys(KEYS) as Field[];

/** Tri-state fields only accept git's own booleans (or empty, meaning unset). */
const TRI_STATE: ReadonlySet<string> = new Set(['pullRebase', 'autoSetupRemote', 'gpgSign']);

function envFor(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home };
}

function readOne(home: string, key: string): string {
  try {
    const out = execFileSync('git', ['config', '--global', '--get', key], {
      encoding: 'utf8',
      timeout: 15_000,
      env: envFor(home),
    });
    return out.trim();
  } catch {
    return '';
  }
}

/** Reads the member's global identity; missing git or missing keys read empty. */
export function gitIdentityFor(home: string, username: string): GitIdentity {
  const identity: GitIdentity = { username, home, name: '', email: '', editor: '', defaultBranch: '', pullRebase: '', autoSetupRemote: '', gpgSign: '', signingKey: '' };
  for (const [field, key] of Object.entries(KEYS)) {
    identity[field as Field] = readOne(home, key);
  }
  return identity;
}

/**
 * Replaces the allowlisted global keys (empty value unsets). Unknown fields
 * are refused, so a crafted request cannot reach `credential.*` or `core.*`
 * beyond the editor. Returns the fresh identity.
 */
export function saveGitIdentity(home: string, username: string, values: Partial<Record<Field, string>>): GitIdentity {
  for (const [field, raw] of Object.entries(values)) {
    if (!(field in KEYS)) {
      throw new Error(`Unknown git setting "${field}".`);
    }
    const value = (raw ?? '').trim();
    if (TRI_STATE.has(field) && value !== '' && value !== 'true' && value !== 'false') {
      throw new Error(`"${field}" must be true, false, or empty.`);
    }
    const key = KEYS[field as Field];
    const args = value === '' ? ['config', '--global', '--unset', key] : ['config', '--global', key, value];
    const result = spawnSync('git', args, { encoding: 'utf8', timeout: 15_000, env: envFor(home) });
    // Unsetting an absent key exits 5: already the desired state, not a failure.
    if (result.status !== 0 && !(args[2] === '--unset' && result.status === 5)) {
      throw new Error((result.stderr ?? '').trim() || `Could not write "${key}". Install git first.`);
    }
  }
  return gitIdentityFor(home, username);
}
