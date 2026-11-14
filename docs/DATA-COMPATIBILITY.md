# Data compatibility and upgrades

Upgrading Morse must never cost the reader anything. There is no "delete your old config" step and no
manual migration: `morse start` brings `~/.morse/` — or whatever `MORSE_DATA_DIR` points at — to the
layout this build understands, before any service reads it.

Two mechanisms, deliberately separate:

| | Runs | Purpose | May overwrite? |
|---|---|---|---|
| **Migration** | once per version step | a one-way shape change | no — it moves data into a new shape |
| **Reconcile** | every start | additive repair of drift | never — it only fills gaps |

## The version file

`.morse/version.json` records the layout of the directory:

```json
{ "layout": 2, "updatedAt": "2026-01-02T03:04:05.000Z", "morse": "0.27.2" }
```

- No file at all means layout **0**: a fresh install, or a directory written before versioning existed.
  Both are fine — the first step tolerates an empty directory, so a fresh install simply walks the chain.
- `layout` is bumped **after each step succeeds**, never at the end of the chain. An upgrade interrupted
  halfway resumes at the step that did not run instead of replaying the ones that did.
- A directory whose `layout` is **newer** than this build refuses to open, with an explicit message. An
  older Morse cannot understand a newer shape and would overwrite it. Upgrading Morse is the answer, not
  downgrading.
- An unreadable `version.json` is an error, not a guess: migrating the wrong layout is worse than stopping.

## Steps

Steps live where their data lives, and are ordered by the version they produce (`to`). A step must be
idempotent, must tolerate missing files, and must never delete something a later step needs.

- `@morse/system` — `bot/data.ts` (`botDataMigrations()`) holds bot mode's steps: the registry's
  `username` split, and the move of a bot's model/persona/subagents out of `engine.json` into the engine's
  own configuration files.
- A future store adds its own module next to its data and registers its steps in the host's maintenance
  call. The runner (`@morse/system` — `data/layout.ts`, `maintainData`) knows nothing about bots.

The chain must have no gaps: a directory at 1 with steps for 2 and 4 is an error, not a best effort.

## Reconcile

Runs after the migrations, on every start, and is allowed to fail without stopping the host (a warning is
logged; bot mode is one capability, not a precondition for code sessions).

- A bot whose engine tree has **no** configuration (an engine directory removed by hand, a bot created by
  an older release) gets it written back from the record.
- An existing engine configuration is **never** overwritten: a hand-edited `opencode.json` or pi
  `settings.json` is exactly what the reader wants, so the reconcile only fills gaps.
- A bot missing its DM conversation gets one, so the sidebar cannot offer a dead row.
- A bot directory no registry entry claims is **reported, never deleted** — it may be a bot whose registry
  write was lost.

## Engine layouts may need repair, not just rewriting

An engine's configuration files are not interchangeable: the *same* content in the wrong file is silently
wrong. `SYSTEM.md` and `AGENTS.md` in pi is the example that bit us — `SYSTEM.md` replaces pi's system
prompt, while `AGENTS.md` is appended context. Writing a bot's persona to the second one made it
instructions rather than character, and no amount of rewriting fixes it, because the old file still exists.

That is what `BotEngineLayout.repair?(botRoot)` is for: an engine moves files an earlier Morse wrote in the
wrong place, and it is the only part of the contract that exists purely for upgrades. It runs once, from a
migration step, never on a normal start. Today:

- **pi** — `config/AGENTS.md` → `config/SYSTEM.md` (the character becomes the system prompt), removed after
  the move so it is not said twice.
- **opencode** — a persona left in `config/opencode/instructions/persona.md` is folded into the bot agent's
  `system` and the file removed; the deprecated singular `agent` key → `agents` with `system`.

`repair` runs from the upgrade step *and* from the every-start reconcile, because it is conservative by
contract: it only moves a file that an earlier Morse wrote, and only when the place it belongs is empty.

## Backups

Before the first step that changes anything, the JSON Morse owns (`registry.json`, each bot's
`engine.json`) is copied to `.morse/backups/<label>-<timestamp>/` with its relative path. Sessions,
workspaces and engine session databases are not copied: they are large and untouched by migrations.

## Where it runs

The composition root, before anything reads the data directory:
`packages/server/src/internal/registry.ts` → `runDataMaintenance()` → `maintainData()` with
`botDataMigrations()` and `reconcileBotData()`. The VS Code extension has no bot service and therefore
nothing to migrate.

## Adding a step

1. Bump `CURRENT_DATA_LAYOUT` in `packages/system/src/data/layout.ts`.
2. Add the step to the owning module (`{ to: CURRENT_DATA_LAYOUT, name, run }`), keeping `to` contiguous.
3. Call `context.backup([...])` with the files it is about to rewrite.
4. Test it against a directory at the previous version, and test that running it twice is a no-op
   (`data/layout.spec.ts` and `bot/data.spec.ts` are the patterns).
