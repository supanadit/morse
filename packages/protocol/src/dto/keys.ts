/**
 * Per-member SSH / GPG access: public keys Morse generated for a login user,
 * their `authorized_keys`, and their GPG identities. Private material is
 * returned only by the explicit `sshPrivate` command, so listings stay safe
 * to render; the Access page shows the generate command too, since a reader
 * may prefer their own terminal.
 */

export interface SshKeyInfo {
  /** File name under `~/.ssh` (`id_ed25519`). */
  name: string;
  /** Key type (`ed25519`, `rsa`). */
  type: string;
  /** The public line (`ssh-ed25519 AAAA… comment`). Empty when missing. */
  publicKey: string;
  /** True when the private file exists beside it. */
  hasPrivate: boolean;
}

export interface SshStatus {
  username: string;
  /** Home the keys were read from (the user's workspace root). */
  home: string;
  keys: SshKeyInfo[];
  /** Lines of `~/.ssh/authorized_keys` (other people's keys allowed in). */
  authorizedKeys: string[];
}

export interface GpgKeyInfo {
  /** Long key id (`sec` line). */
  id: string;
  /** Fingerprint (`fpr` line), when reported. */
  fingerprint?: string;
  /** Uids attached (`Name <mail>`). */
  uids: string[];
}

export interface GpgStatus {
  username: string;
  keys: GpgKeyInfo[];
}

/**
 * One member's global git identity (`~/.gitconfig`): the handful of keys that
 * matter everywhere — who commits say they are from, and whether signing is
 * on. Missing keys are simply unset (empty string on the wire), never
 * defaulted: the panel shows what git would actually use.
 */
export interface GitIdentity {
  username: string;
  /** Home the config was read from (the user's workspace root). */
  home: string;
  name: string;
  email: string;
  editor: string;
  defaultBranch: string;
  /** `true` / `false` / empty (unset). */
  pullRebase: string;
  /** `true` / `false` / empty (unset). */
  autoSetupRemote: string;
  /** `true` when `commit.gpgsign` is on, else empty (unset). */
  gpgSign: string;
  signingKey: string;
}
