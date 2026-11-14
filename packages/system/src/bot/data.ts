import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import type { ModelRef, ThinkingLevel } from '@morse/agent';
import type { DataContext, DataMigration } from '../data/layout.js';
import type { BotEngineAdapter } from './service.js';
import { dmConversationId, loadBotRegistry, saveBotRegistry, writeBotIdentity } from './store.js';
import type { BotRecord, BotRegistryFile } from './types.js';

/**
 * Bot mode's data compatibility: the migrations a Morse upgrade runs, and the
 * reconcile pass that runs on every start.
 *
 * Bot data is the only part of Morse that stores *another program's* state —
 * each engine's own configuration files — so it is the part that can drift:
 * an engine tree deleted by hand, a bot directory left behind by an older
 * release, a registry entry that lost its DM. The migration steps below are
 * one-way shape changes recorded in `.morse/version.json`; the reconcile is
 * additive and runs every start, because "the engine's config is missing" is a
 * repairable state, not a version.
 */

/** Where bot mode keeps everything, relative to the data directory. */
export const BOT_DIR = 'bot';
const REGISTRY_FILE = 'registry.json';
const IDENTITY_FILE = 'engine.json';

/** What a reconcile needs: the bot tree and the engines this host can run. */
export interface BotDataContext extends DataContext {
  adapters: Record<string, BotEngineAdapter>;
}

/** The registry as a bot directory holds it, or `undefined` when there is none. */
function readRegistry(botDir: string): BotRegistryFile | undefined {
  if (!existsSync(join(botDir, REGISTRY_FILE))) {
    return undefined;
  }
  return loadBotRegistry(botDir);
}

/** The registry and every bot's identity file: what the bot steps may rewrite. */
function ownedFiles(registry: BotRegistryFile | undefined): string[] {
  const files = [join(BOT_DIR, REGISTRY_FILE)];
  for (const bot of registry?.bots ?? []) {
    files.push(join(BOT_DIR, bot.username, IDENTITY_FILE));
  }
  return files;
}

/**
 * The versioned steps, ascending. Each one is safe to re-run only in the sense
 * that its predecessor's output is its input: `version.json` moves forward as
 * each succeeds, so an interrupted upgrade resumes at the step that never ran.
 */
export function botDataMigrations(): DataMigration[] {
  return [
    {
      // Layout 1 is the first stamped version. Everything released before the
      // layout existed is taken to be 1 here — the migration for those readers is
      // the registry's own v1 handling, which `loadBotRegistry` still does.
      to: 1,
      name: 'stamp the first bot data layout',
      run: () => undefined,
    },
    {
      to: 2,
      name: 'write each bot configuration into its engine own files',
      run: (context) => migrateEngineLayouts(context as BotDataContext),
    },
    {
      to: 3,
      name: 'let each engine move files an earlier Morse put in the wrong place',
      run: (context) => repairEngineFiles(context as BotDataContext),
    },
    {
      // A second pass because each release learns more about where an engine
      // actually reads things: OpenCode's persona moved from an instruction file
      // into the agent's `system`. `repair` is idempotent by contract, so running
      // it again is safe for bots the previous step already fixed.
      to: 4,
      name: 're-check every engine layout after the agent-based persona move',
      run: (context) => repairEngineFiles(context as BotDataContext),
    },
  ];
}

/**
 * Asks every bot's engine layout to move files an earlier Morse wrote where that
 * engine does not read them — pi's persona from `AGENTS.md` to `SYSTEM.md`,
 * OpenCode's subagents from the deprecated `agent` key to `agents`.
 *
 * The knowledge is the layout's, not this module's: a migration step can only
 * say "run your repair", which is what keeps a new engine from needing a change
 * here. The files each repair may touch are backed up first, because these are
 * the reader's own engine config — a migration that damaged one would be worse
 * than the bug it fixes.
 */
function repairEngineFiles(context: BotDataContext): void {
  const botDir = join(context.root, BOT_DIR);
  const registry = readRegistry(botDir);
  if (registry === undefined) {
    return;
  }
  context.backup(
    registry.bots.flatMap((bot) =>
      engineFiles(join(BOT_DIR, bot.username)).filter((file) =>
        existsSync(join(context.root, file)),
      ),
    ),
    'engine-repair',
  );
  for (const bot of registry.bots) {
    const adapter = context.adapters[bot.engineKind];
    if (adapter?.layout.repair === undefined) {
      continue;
    }
    const botRoot = join(botDir, bot.username);
    try {
      adapter.layout.repair(botRoot);
    } catch (error: unknown) {
      // One bot's unreadable config must not stop the others being repaired.
      context.logger.warn(
        `Could not repair the ${bot.engineKind} configuration of bot "${bot.name}": ${(error as Error).message}`,
      );
    }
  }
}

/**
 * The engine-configuration files under one bot, relative to the data directory:
 * its `config/` tree without resources, plus the workspace document. Bounded on
 * purpose — sessions and workspaces are neither small nor part of a migration.
 */
function engineFiles(botRelative: string, depth = 0): string[] {
  const root = botRelative;
  const configDir = join(root, 'config');
  const files: string[] = [join(configDir, 'SYSTEM.md'), join(root, 'workspace', 'AGENTS.md')];
  const walk = (relative: string, level: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = join(relative, entry.name);
      if (entry.isDirectory()) {
        // Resources an engine manages itself: large, and not configuration a
        // migration rewrites.
        if (
          level >= 2 ||
          ['extensions', 'skills', 'prompts', 'themes', 'bin'].includes(entry.name)
        ) {
          continue;
        }
        walk(next, level + 1);
        continue;
      }
      if (/\.(json|md)$/i.test(entry.name)) {
        files.push(next);
      }
    }
  };
  walk(configDir, depth);
  return files;
}

/**
 * Moves a bot whose configuration lived in `engine.json` onto the engine's own
 * files — `opencode.json`, pi's `auth.json`/`models.json`/`settings.json` — and
 * drops the copy Morse used to keep.
 *
 * This is the step that makes an upgrade free for anyone who created bots with
 * an earlier release: their model, persona and subagents move into the layout
 * their engine actually reads, and the record goes back to being an index entry.
 */
function migrateEngineLayouts(context: BotDataContext): void {
  const botDir = join(context.root, BOT_DIR);
  const registry = readRegistry(botDir);
  if (registry === undefined) {
    return;
  }
  context.backup(ownedFiles(registry), 'engine-layouts');
  let changed = false;
  for (const bot of registry.bots) {
    const legacy = bot as BotRecord & {
      persona?: string;
      model?: ModelRef;
      thinkingLevel?: ThinkingLevel;
      subagents?: Array<{ name: string; prompt: string }>;
    };
    const hasLegacy =
      legacy.persona !== undefined ||
      legacy.model !== undefined ||
      legacy.thinkingLevel !== undefined ||
      legacy.subagents !== undefined;
    if (!hasLegacy) {
      continue;
    }
    const adapter = context.adapters[bot.engineKind];
    const botRoot = join(botDir, bot.username);
    const read = readEngine(adapter, botRoot);
    if (adapter !== undefined && read.ok && !hasNativeConfig(read.state)) {
      adapter.layout.write(botRoot, {
        username: bot.username,
        name: bot.name,
        description: bot.description,
        persona: legacy.persona ?? '',
        // Credentials are not in the record: the engine's own store already holds
        // them, and an empty list is what leaves it untouched.
        credentials: [],
        providers: [],
        ...(legacy.model === undefined ? {} : { model: legacy.model }),
        ...(legacy.thinkingLevel === undefined ? {} : { thinkingLevel: legacy.thinkingLevel }),
        ...(legacy.subagents === undefined ? {} : { subagents: legacy.subagents }),
      });
    }
    // The engine files hold it now; the record keeps identity only.
    delete legacy.persona;
    delete legacy.model;
    delete legacy.thinkingLevel;
    delete legacy.subagents;
    writeBotIdentity(botRoot, bot);
    changed = true;
  }
  if (changed) {
    saveBotRegistry(botDir, registry);
  }
}

/**
 * Repairs bot state on every start, additively.
 *
 * Three drift cases, all of them recoverable without asking the reader:
 * - a bot whose engine tree has no configuration yet (created by an older
 *   release, or a tree someone removed by hand) gets its record written back;
 * - a bot whose DM conversation went missing gets one, so the sidebar can open
 *   it instead of offering a dead row;
 * - a directory that no registry entry claims is reported, never deleted: it may
 *   be a bot whose registry write was lost, and guessing wrong would destroy a
 *   workspace.
 */
export function reconcileBotData(context: BotDataContext): void {
  const botDir = join(context.root, BOT_DIR);
  const registry = readRegistry(botDir);
  if (registry === undefined) {
    return;
  }
  let changed = false;

  for (const bot of registry.bots) {
    const adapter = context.adapters[bot.engineKind];
    const botRoot = join(botDir, bot.username);
    if (adapter?.layout.repair !== undefined) {
      // Conservative by contract — it only moves files an earlier Morse wrote to
      // a place the engine does not read — so it heals on any start, not only on
      // the release that introduced the fix.
      try {
        adapter.layout.repair(botRoot);
      } catch (error: unknown) {
        context.logger.warn(
          `Could not repair the ${bot.engineKind} configuration of bot "${bot.name}": ${(error as Error).message}`,
        );
      }
    }
    const read = readEngine(adapter, botRoot);
    // Never write over a configuration that could not be read: a malformed
    // opencode.json is a reader's file to fix, and writing "nothing" over it would
    // be the worst outcome of a repair.
    if (read.ok && !hasNativeConfig(read.state)) {
      const state = read.state;
      const derived = {
        persona: state.persona ?? '',
        ...(state.agentsMd === undefined ? {} : { agentsMd: state.agentsMd }),
        ...(state.model === undefined ? {} : { model: state.model }),
        ...(state.thinkingLevel === undefined ? {} : { thinkingLevel: state.thinkingLevel }),
        ...(state.tools === undefined ? {} : { tools: state.tools }),
        ...(state.subagents === undefined ? {} : { subagents: state.subagents }),
      };
      // Nothing to write means nothing is known — an empty write would clear the
      // engine's own settings, which is exactly the data loss a reconcile must not
      // cause. The reader's Edit form is where a blank bot gets configured.
      if (derived.persona.trim().length > 0 || state.model !== undefined) {
        adapter?.layout.write(botRoot, {
          username: bot.username,
          name: bot.name,
          description: bot.description,
          credentials: [],
          providers: [],
          ...derived,
        });
        context.logger.info(`Repaired the engine configuration for bot "${bot.name}".`);
      } else {
        context.logger.warn(
          `Bot "${bot.name}" has no engine configuration and nothing recorded to write: set it up from Edit bot.`,
        );
      }
    }

    const dmId = dmConversationId(bot.username);
    if (!registry.conversations.some((conversation) => conversation.id === dmId)) {
      registry.conversations.push({
        id: dmId,
        kind: 'dm',
        title: bot.name,
        members: [bot.username],
        chainCap: registry.conversations[0]?.chainCap ?? 8,
        sessions: {},
        updatedAt: context.now().getTime(),
      });
      changed = true;
      context.logger.info(`Restored the missing conversation for bot "${bot.name}".`);
    }
  }

  for (const entry of readdirSync(botDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'backups') {
      continue;
    }
    if (!registry.bots.some((bot) => bot.username === entry.name)) {
      context.logger.warn(
        `Bot directory "${join(botDir, entry.name)}" belongs to no bot in the registry: left untouched, it may be a bot whose record was lost.`,
      );
    }
  }

  if (changed) {
    saveBotRegistry(botDir, registry);
  }
}

/** Whether a read state says the engine tree already carries a configuration. */
function hasNativeConfig(state: ReturnType<BotEngineAdapter['layout']['read']>): boolean {
  return Object.keys(state).length > 0;
}

/** A layout's read, keeping "nothing there" and "could not read it" apart. */
function readEngine(
  adapter: BotEngineAdapter | undefined,
  botRoot: string,
): { ok: true; state: ReturnType<BotEngineAdapter['layout']['read']> } | { ok: false } {
  if (adapter === undefined) {
    return { ok: false };
  }
  try {
    return { ok: true, state: adapter.layout.read(botRoot) };
  } catch {
    return { ok: false };
  }
}

/** The identity files a future migration would want to back up, for tests. */
export function botIdentityFile(botDir: string, username: string): string {
  return join(botDir, username, IDENTITY_FILE);
}

/** The raw registry text, for a test that pins what a migration wrote. */
export function readBotRegistryText(botDir: string): string {
  return readFileSync(join(botDir, REGISTRY_FILE), 'utf8');
}
