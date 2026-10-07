<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->
<!-- Last updated: 2026-10-07 | Last verified: 2026-10-07 -->

# packages/adapter-pi-rpc — AGENTS.md

**Precedence:** the closest `AGENTS.md` wins. This file overrides the root for files under `packages/adapter-pi-rpc/`.

## Overview

The only place that talks to `pi`. It spawns `pi --mode rpc` as a subprocess, frames its JSONL, maps its events into core's domain, and reads pi's own files (sessions, prompts, MCP config, trust).

| Path | Holds |
| --- | --- |
| `src/pi-rpc-agent.ts` | one agent per session: spawn, prompt, state, commands |
| `src/event-mapping.ts` | pi event → `AgentEvent` |
| `src/pi-rpc-session-catalog.ts` | the session list on disk (size+mtime cache, row scan) |
| `src/pi-prompts.ts`, `src/pi-mcp.ts` | pi's prompt templates and MCP config |
| `src/internal/rpc-client.ts`, `jsonl-framer.ts` | the stdio JSON-RPC client and its framing |
| `src/internal/resolve-pi.ts`, `spawn-env.ts` | finding `pi` and building its environment |
| `src/internal/prompt-watch.ts`, `mcp-watch.ts` | polling pi's dirs to refresh commands |
| `src/internal/project-trust.ts`, `prompt-frontmatter.ts`, `mcp-client.ts` | trust gate, frontmatter parse, connect-before-add probe |

## Setup

`npm install` at the root; `pi` must be on `PATH` (or set by the host). Never import the `pi` package at runtime (~436 MB) — always spawn the CLI.

## Build / tests

| Task | Command |
| --- | --- |
| Build | `npm run build -w @morse/adapter-pi-rpc` |
| Type-check | `npm run check-types -w @morse/adapter-pi-rpc` |
| Tests | `npm run test -w @morse/adapter-pi-rpc` (vitest) — **not** in `npm run test:fast`, so run it explicitly whenever you touch this package |

## Code style

- **pi framing**: split on LF only, strip CR, no `readline`, use `StringDecoder`; stderr is logs only, never protocol.
- Relative imports carry the extension: `from './internal/rpc-client.js'`.
- Keep the process boundary boring: one child per session, killed in `dispose()`, and never a shell string.
- A pi file this adapter reads gets a test beside it (`.spec.ts`) — the specs are how the parsers stay honest.

## Security

This adapter reads pi's configuration and spawns a process, so treat both as trusted-but-verified: pi's `trust.json` is the gate on a project's `.pi/` resources (`internal/project-trust.ts`), `spawn-env.ts` builds the child environment explicitly instead of inheriting everything, and `resolve-pi.ts` resolves the binary rather than executing a search path. A log line may carry a session id but never an environment value or a token.

## Commit / PR

- Conventional commits, one logical change per commit.
- A change to event mapping or to a pi file format needs its `.spec.ts` in the same commit; note the pi version you verified against in the message.

## Examples

- `src/event-mapping.ts` + `event-mapping.spec.ts` — the mapping and its fixtures are the reference for any new event.
- `src/internal/project-trust.ts` — how a pi-owned JSON file is read, written and re-read.
- `src/pi-rpc-session-catalog.ts` — the cached scan: copy this shape for any new directory listing rather than walking files per call.

## Gotchas

| Symptom | Cause / fix |
| --- | --- |
| A prompt template disappeared from the palette, with a warning row above the chat | intended: Morse now parses frontmatter with the same YAML parser pi uses, so a template pi refuses is dropped and named instead of offered as a dead `/command` — fix the file's frontmatter |
| A saved template does not appear in the palette | `promptTemplateSave` already asks the host to re-read (`commands/refresh`); if it still does not, the project is untrusted, so pi ignores `.pi/prompts` until **Trust this project** |
| A template written with `vim`/`nano` is not in the palette | it should be: every hot agent polls its own prompt dirs (`packages/adapter-pi-rpc/src/internal/prompt-watch.ts`, 1.5 s) and calls `refreshCommands` on a change, and the editor re-reads `promptTemplates` every 3 s while open. If it is still missing, the file may be in a project pi has not trusted |
| A prompt costs ~1 s of host CPU, or the sidebar takes a second to refresh | `session/list` is scanning every session file again: keep the size+mtime cache and the row scan in `pi-rpc-session-catalog.ts` (measured 624 ms → 2 ms; see `docs/DEVELOPMENT.md`) |
| A model added to `models.json` does not appear without `morse stop`/`start` | pi caches its catalog per warm session, and the draft probe is cached for the host's lifetime. The model picker sends `models/refresh` when it opens: `PiRpcAgent.refreshModels` re-requests `get_available_models`, a draft clears `SessionRegistry.refreshDraftDefaults()` and re-probes. A reload also re-reads the warm session. Never re-probe on every draft reload — it spawns a `pi` process |
| A model row shows no modality icon | pi did not report `input` for it: the badge is absent rather than claiming text-only (`input` is optional end to end, and an unknown modality is dropped at the adapter). pi ships `["text"]` / `["text","image"]` today; `morse-model-inputs` renders an icon per known modality |
| `pgrep -f "pi --mode rpc"` finds nothing | pi renames `process.title`; use `pgrep -P <server-pid>` |
| The panel says the project is not trusted | that is pi's gate on project `.pi/` resources. The panel's **Trust this project** writes `<agentDir>/trust.json` through `internal/project-trust.ts` and refreshes; `pi mcp list` is a fresh process, so project servers appear immediately, while a warm session still needs a restart for prompts/skills |

## When stuck

| Need | File |
| --- | --- |
| pi event mapping | `packages/adapter-pi-rpc/src/event-mapping.ts` |
| a prompt template pi refuses (its "Prompt conflicts") | `packages/adapter-pi-rpc/src/internal/prompt-frontmatter.ts` ← `buildCommandList` in `pi-rpc-agent.ts`, reported via `AgentSessionState.diagnostics` |
| project trust (pi's `trust.json`) | `packages/adapter-pi-rpc/src/internal/project-trust.ts` ← `PiMcp.trustProject`, host command `trustProject`, the panel's “Trust this project” button |
| MCP servers list/enable/disable + indicator | `packages/ui-angular/src/app/chat/mcp-panel/` ← `core/mcp-state.ts`, `packages/adapter-pi-rpc/src/pi-mcp.ts` (reads `~/.pi/agent/mcp.json` + `.pi/mcp.json`, status from `pi mcp list --json`) |
| MCP add editor + connect-before-add probe | `packages/ui-angular/src/app/chat/mcp-editor/` ← `core/mcp-state.ts` (`mcpInspect`), `packages/adapter-pi-rpc/src/internal/mcp-client.ts`; VS Code opens it as a `WebviewPanel` routed `#/mcp` (`chat-view-provider.ts` → `openMcpEditor`) |
| why a subprocess and not the SDK | `docs/ARCHITECTURE.md` §Why RPC subprocesses (and not the SDK) |
