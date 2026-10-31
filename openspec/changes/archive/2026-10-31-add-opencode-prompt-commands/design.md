# Design

## Context

The MCP change (add-opencode-mcp-management, archived 2026-10-31) built the machinery this reuses:
`AgentExtras` per-engine administration, `resolveMcpExtras`-style per-request resolution in the
session factory, engine kind on protocol payloads, and the JSON-preserving `opencode.json` writer
(`internal/opencode-mcp-config.ts`). The prompt editor exists for pi: `pi-prompts.ts` (file
read/write), `PromptTemplateInfo/Input/Mutation` DTOs, and prompt components in ui-angular
(`prompt-editor`, `prompt-rail`, `prompt-template-dialog`). OpenCode commands are markdown files
(`commands/` dirs, frontmatter `description` + optional `agent`/`model`/`subtask`) plus a
`command` key in `opencode.json` whose entries carry `template`/`description`/`agent`/`model`/
`subtask`.

## Goals / Non-Goals

**Goals:**
- One editor, two engines: the existing prompt editor drives OpenCode commands with no separate UI.
- Both sources editable: `commands/*.md` files and `opencode.json` `command` entries.
- Zero cross-engine leakage: prompt commands carry the engine kind, like mcp* already do.
- Reuse the JSON writer so `opencode.json` keeps every unrelated byte.

**Non-Goals:**
- No live "does this command run" probing (OpenCode resolves commands at session start).
- No renaming a config command via a JSON-key rewrite in v1? — No: renaming IS supported, it is a
  key delete + key add, same transaction as the file move case.
- No shell-injection (`` !`cmd` ``) or `@file` execution in Morse's preview: the preview renders
  placeholders only; OpenCode does the injection at run time.

## Decisions

### D1: One port, two backends behind `AgentPromptExtras`

`OpenCodePrompts` implements the same `load/save/delete` port `pi-prompts.ts` already satisfies.
DTOs extend, not fork: `PromptTemplateInfo` gains `source?: 'file' | 'config'` and `argumentHint`
stays pi-only (undefined for OpenCode); `PromptTemplateInput` keeps `raw` for files and gains an
optional structured `configEntry` for JSON commands. Rationale: the frontend already switches on
what is undefined; adding one optional field beats a parallel DTO set.

### D2: `raw` composition differs per source

For files, the frontend composes `raw` (frontmatter + body) exactly as it does for pi — one
renderer per engine: pi writes `argument-hint`, OpenCode writes `description` only. For config
commands the host ignores `raw` and rebuilds the JSON entry from structured fields, so JSON
formatting (indent, key order of untouched entries) is owned by the writer, not the browser.

### D3: Engine scoping mirrors mcp*

`promptTemplates` / `promptTemplateSave` / `promptTemplateDelete` payloads gain an optional
`engine` string. The session factory resolves extras per request through `AgentRouter.extrasFor`,
with the same rule set as `resolveMcpExtras`: named engine → its extras; omitted → default engine
(compat); engine without prompts → error naming the engine, never a cross-read. The existing pure
function is generalized (same shape, one more extras key) rather than duplicated.

### D4: Name collisions across sources are real, distinct rows

A `commands/test.md` and a `command: { test: … }` both exist in OpenCode and both run. Morse lists
both, labeled `file` / `config`. Save/delete address `source + name + scope`, so they can never
write the wrong surface.

### D5: OpenCode's placeholder dialect in the preview

The preview renderer switches on engine: pi keeps `$1` / `${2:-none}`; OpenCode renders
`$ARGUMENTS` and `$1`–`$9` (positional, no defaults), and passes shell/`@file` lines through
verbatim with a hint that OpenCode expands them at run time. Test-argument UI shows a single
`arguments` string for OpenCode instead of pi's per-field inputs.

### D6: Registration

`registry.ts` passes `extras: { prompts: openCodePrompts, mcp: openCodeMcp, … }`. The stale
"opencode has no prompt files" comment in `session/integration.ts` is corrected.

## Risks / Trade-offs

- `opencode.json` edits share the file with MCP edits; both go through one writer module, so a
  concurrent MCP + command edit is serialized by the host's per-workspace command handling — same
  assumption the MCP change made.
- OpenCode may rename `commands/` → `command/` across versions; the directory list is data
  (both scopes' paths live in one `openCodeCommandDirs` helper), so a rename is a one-line fix.
- Older clients omitting `engine` address the default engine — the known compat path, pinned by
  tests as in the MCP change.

## Migration Plan

Not needed: additive DTO fields, optional engine kind, no persisted state.

## Open Questions

- None. Format verified against OpenCode's docs (commands/ directories, frontmatter and
  `command` JSON key).
