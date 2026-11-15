import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

/** The variable through which the bot's shell plugin learns the host's config root. */
export const BOT_HOST_XDG_CONFIG_HOME_ENV = 'MORSE_HOST_XDG_CONFIG_HOME';
/** The variable through which the bot's shell plugin learns the host's data root. */
export const BOT_HOST_XDG_DATA_HOME_ENV = 'MORSE_HOST_XDG_DATA_HOME';

/** A plugin that can reach the reader's home is readable by its owner only. */
const PRIVATE_FILE_MODE = 0o600;
/** Morse's own tree: the bot's directories are closed to everyone else. */
const PRIVATE_DIR_MODE = 0o700;

/**
 * A host root the shell can actually use: present, non-empty and absolute. A
 * relative value would resolve against whatever directory the bot's command
 * happens to run in, and an empty one is not a root at all.
 */
function knownRoot(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 && isAbsolute(value) ? value : undefined;
}

/**
 * The environment a bot's OpenCode server gets.
 *
 * Both XDG roots are redirected into the bot, not appended to, on purpose:
 * OpenCode reads providers, agents, MCP servers and commands from the config
 * root, and sessions, logs and auth from the data root, so inheriting the
 * host's would let a bot read and write the user's own engine state. The host's
 * real roots are not thrown away, though — they travel alongside as
 * `MORSE_HOST_XDG_*`, which is how the shell plugin (`writeBotUserSpacePlugin`)
 * hands them back to the commands a bot runs. Only the shell is given them: the
 * server's own file reads keep using the bot's two roots.
 *
 * Everything else — `PATH` above all, which the spawn needs to find the binary —
 * is inherited unchanged. Because that inheritance is wholesale, an
 * `OPENCODE_*` config-path override already set by the host reaches the bot too
 * and would bypass the XDG redirects; that is an accepted MVP risk, documented
 * here rather than silently scrubbing the user's environment.
 */
export function botUserSpaceEnv(
  botRoot: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const home = knownRoot(base['HOME']);
  const configHome =
    knownRoot(base['XDG_CONFIG_HOME']) ??
    (home === undefined ? undefined : join(home, '.config'));
  const dataHome =
    knownRoot(base['XDG_DATA_HOME']) ??
    (home === undefined ? undefined : join(home, '.local', 'share'));
  return {
    ...base,
    XDG_CONFIG_HOME: join(botRoot, 'config'),
    XDG_DATA_HOME: join(botRoot, 'sessions'),
    ...(configHome === undefined ? {} : { [BOT_HOST_XDG_CONFIG_HOME_ENV]: configHome }),
    ...(dataHome === undefined ? {} : { [BOT_HOST_XDG_DATA_HOME_ENV]: dataHome }),
  };
}

/** Where the bot's shell plugin lives: the plugins dir of its own OpenCode config. */
export function botUserSpacePluginPath(botRoot: string): string {
  return join(botRoot, 'config', 'opencode', 'plugins', 'morse-user-space.ts');
}

/**
 * The plugin source, exactly as OpenCode loads it.
 *
 * The env names are interpolated from the constants above so the writer and
 * `botUserSpaceEnv` cannot drift apart: a plugin reading a variable nothing
 * sets would silently leave the bot's shell confined.
 */
const PLUGIN_SOURCE = `import { Plugin } from "@opencode/plugin"

const configHome = process.env.${BOT_HOST_XDG_CONFIG_HOME_ENV}
const dataHome = process.env.${BOT_HOST_XDG_DATA_HOME_ENV}

export default Plugin.define({
  id: "morse.user-space",
  async setup(ctx) {
    await ctx.shell.hook("create.before", (event) => {
      if (configHome !== undefined) event.env.XDG_CONFIG_HOME = configHome
      if (dataHome !== undefined) event.env.XDG_DATA_HOME = dataHome
    })
  },
})
`;

/**
 * Installs the bot's shell plugin.
 *
 * The bot's OpenCode server must stay inside its own tree, but a command it runs
 * is the reader's own work — a Podman socket, an SSH key, a checkout — and must
 * find the reader's real roots. The plugin restores the host's
 * `XDG_CONFIG_HOME`/`XDG_DATA_HOME` on the shell's environment only, and only
 * when `botUserSpaceEnv` carried them; with no host root known, the bot's own
 * value is left alone rather than set to `undefined`.
 *
 * The write is private and atomic (temp file beside the target, then rename), the
 * same discipline as the bot's credentials: a plugin that can read the reader's
 * home is mode 0600 from the moment it exists, and a host that dies mid-save
 * leaves the previous plugin intact instead of a truncated one. Rewriting the
 * same source produces the same file, so installing on every save is harmless.
 */
export function writeBotUserSpacePlugin(botRoot: string): void {
  const path = botUserSpacePluginPath(botRoot);
  const temp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    writeFileSync(temp, PLUGIN_SOURCE, { mode: PRIVATE_FILE_MODE });
    // `mode` only applies when the temp file is created; a stale temp left by a
    // crashed run could be broader, so the mode is enforced explicitly.
    chmodSync(temp, PRIVATE_FILE_MODE);
    renameSync(temp, path);
  } catch (error) {
    // Some filesystems refuse a rename over an existing file (a Windows mount).
    // Mirroring the credential writer, the fallback writes in place: not
    // atomic, but failing a bot save on such a host is worse.
    try {
      writeFileSync(path, PLUGIN_SOURCE, { mode: PRIVATE_FILE_MODE });
      chmodSync(path, PRIVATE_FILE_MODE);
      rmSync(temp, { force: true });
    } catch {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}
