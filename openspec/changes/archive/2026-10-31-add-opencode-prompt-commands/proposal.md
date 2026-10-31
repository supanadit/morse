# Proposal: add-opencode-prompt-commands

## Why

Morse's prompt-template editor only works for pi. OpenCode has the same feature under the name
**commands** — markdown templates the user invokes with `/name` — but Morse shows an empty editor
for OpenCode sessions, so users maintain their OpenCode templates outside Morse even though the
editor already exists.

## What Changes

- New `OpenCodePrompts` administration on the OpenCode integration, wired as `AgentExtras.prompts`,
  so the existing prompt-template editor works for OpenCode sessions.
- OpenCode command files live in `~/.config/opencode/commands/` (global) and
  `.opencode/commands/` (project). Same editor fields: name, description, body.
  pi's `argument-hint` field is hidden for OpenCode (OpenCode has no such field).
- OpenCode also defines commands in `opencode.json`'s `command` key
  (`{ template, description, agent?, model?, subtask? }`). These are listed alongside file
  commands, labeled by source, and are fully editable: Morse writes them back to the JSON key,
  preserving the rest of the file (the same preserve-everything writes as the MCP change).
- The editor's argument-hint and preview rendering stay engine-aware: OpenCode templates use
  `$ARGUMENTS` and `$1`–`$9` (pi's `${2:-none}` default syntax is pi-only and hidden for OpenCode).
- The engine-scoped command payloads from add-opencode-mcp-management are reused: prompt commands
  gain the same optional engine kind so a pi session never lists OpenCode commands and vice versa.

## Capabilities

- **New Capabilities:** `agent/opencode-prompts` — reading and editing OpenCode's command
  templates (markdown files and `opencode.json` entries) through Morse's prompt editor, scoped per
  engine.

## Impact

- `packages/integration-opencode`: new `opencode-prompts.ts` + `internal/opencode-prompts-config.ts`
  (file and `opencode.json` `command`-key handling), extras wiring in `opencode-engine.ts`.
- `packages/protocol`: prompt DTOs gain `source` (`file` | `config`), `raw` becomes optional for
  config-sourced commands, prompt host commands gain an optional `engine` kind.
- `packages/server` + `packages/system`: per-request extras resolution for prompt commands
  (same `resolveMcpExtras` pattern), OpenCode registration passes the new extras.
- `packages/ui-angular`: prompt editor/panel hide pi-only fields for OpenCode, label command
  source, send engine on every command.
- No breaking changes: pi behavior unchanged; older clients without `engine` keep working against
  the default engine.
