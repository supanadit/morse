# Tasks

## 1. OpenCode command config module

- [x] 1.1 `internal/opencode-prompts-config.ts`: list `commands/*.md` in both scopes (global
  `~/.config/opencode/commands/`, project `.opencode/commands/`) with strict frontmatter parsing
  and per-file error capture; reuse the XDG resolution from the MCP config module
- [x] 1.2 Same module: read/write `opencode.json`'s `command` key through the shared JSON
  preserving writer — list entries (`template`/`description`/`agent`/`model`/`subtask`), upsert,
  rename, delete; refuse entries without a string `template`
- [x] 1.3 Spec: file listing/scoping, config listing, malformed file and malformed `command` key
  reported not hidden, upsert preserves siblings and unknown fields, rename moves scope (files) or
  rekeys (config), delete by `source+name+scope`

## 2. OpenCode prompts administration

- [x] 2.1 `opencode-prompts.ts`: `OpenCodePrompts` implementing the prompt port over the config
  module — load/save/delete for both sources, `source` labeled results, `argumentHint` never set
- [x] 2.2 Wire `AgentExtras.prompts` in `opencode-engine.ts`; fix the stale "no prompt files"
  comment in `packages/system/src/session/integration.ts`
- [x] 2.3 Spec: round-trip file command (create → listed → edit → delete), round-trip config
  command (upsert → listed with agent/model/subtask → edit → delete), same-name file+config both
  listed and edited independently

## 3. Engine-scoped prompt commands

- [x] 3.1 `packages/protocol` dto/prompt.ts: `source?: 'file' | 'config'` on
  `PromptTemplateInfo`, optional `configEntry` on `PromptTemplateInput`, `engine?` on all prompt
  command payloads; document `argumentHint` as pi-only
- [x] 3.2 `packages/server` session factory: per-request extras resolution for
  `promptTemplates`/`promptTemplateSave`/`promptTemplateDelete` via the generalized resolver;
  named engine without prompts refused naming the engine, omitted engine falls back to the default;
  capability `prompts` on when any engine supplies prompts extras
- [x] 3.3 Spec: resolver tests pinning the three resolution rules and the no-cross-read refusal

## 4. Editor fit and end-to-end

- [x] 4.1 ui-angular prompt editor/rail/dialog: send `engine` on every command; hide the
  argument-hint field for OpenCode; render `$ARGUMENTS`/`$1`–`$9` in the preview with a single
  test-arguments input; source chip (`file`/`config`) in the list; "new sessions pick up edits"
  note
- [x] 4.2 Spec: OpenCode-shaped listing renders with source labels and no `undefined`/pi-only
  fields; pi rendering unchanged
- [x] 4.3 End-to-end: live host with both engines over WebSocket — each engine lists only its own
  templates, a config-command edit lands in `opencode.json` (siblings intact), a file command round
  -trips, unknown engine refused; checklist recorded here; full test suite and typechecks green

  > E2E executed 2026-10-31 against a live host (pi + OpenCode engines, isolated
  > PI_CODING_AGENT_DIR / XDG_CONFIG_HOME), driven over the WebSocket client: 12/12 checks —
  > pi lists only its templates, OpenCode lists both sources labeled; a config-command save lands
  > in `opencode.json` with `$schema`, `mcp` and sibling entries intact; a file command round-trips
  > through `.opencode/commands/`; deletes honor `source`; the codex engine is refused, never
  > cross-read. The e2e caught one real bug: `parsePromptTemplateInput` dropped `source`/`entry`/
  > `originalSource` from the payload, sending config saves down the file path — fixed in
  > `pi-prompts.ts` and covered there.

## 5. Wrap-up

- [x] 5.1 Validate the change, mark tasks done as verified, `openspec` reports all complete
