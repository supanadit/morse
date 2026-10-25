# Roadmap — an agent-agnostic Morse

Goal: make a Morse session independent of the pi harness, so any engine (`pi`, OpenCode, …) can drive the
same session, sidebar and transcript.

## Done when

1. A session's id is Morse's, not a path into an engine's storage. ✓
2. `~/.pi` deleted: the sidebar still lists every session with its title. ✓ (the index is Morse's; the
   conversation itself still belongs to the engine, by design)
3. Two engines installed: a session reopens through the one that made it. ✓
4. A session started with `pi` in a terminal shows up in Morse by itself. ✓
5. No package above `integration-*` names an engine. ✓

## Shipped

- **`FileSessionStore`** — one JSON per record, sharded by the first two id characters, plus an append-only
  JSONL index of `{token, record}` lines (last-wins, compacted when oversized), under `<data dir>/sessions/`.
- **Derived ids become the key** — `sessionKey` is `record.id` across the registry, transcripts and the wire;
  VS Code restores its tabs through the host's own reconciliation, so an old path-shaped id is dropped once.
- **Reconcile, not crawl** — `AgentRouter.ensureFresh()` scans each engine (debounced, one burst at a time),
  token-gated so an unchanged session costs no read, and never removes an engine's rows when its report fails.
- **Two engines** — `@morse/integration-opencode` implements `SessionEngine` against OpenCode's v2 HTTP API
  (attach or spawn, one SSE stream, event/message/model mapping, forms and permissions); pi remains the
  subprocess engine.
- **Capability ports** — `AgentExtras` (`mcp`, `prompts`, `version`, `cli`) on `AgentIntegration`; hosts read
  them from the default engine, so OpenCode shows no MCP editor, prompt editor or pi update notice.
- **Forms** — `AgentFormRequest` through the harness contract, the wire protocol and the interaction panel; a
  native-dialog host still sends forms to the frontend, which is the only surface that can render them.

## What is left

Each is a coherent next change, not a gap in the foundation:

- **Session rename** — a command that writes the engine's own title through the adapter.
- **An OpenCode agent picker** — selecting `build`/`plan` is intentionally absent until the engine's agent
  catalog has a place in `AgentSessionState`.
- **MCP/prompt editors for OpenCode** — OpenCode has its own config surface; a Morse editor for it is a
  separate feature, not a capability port.
- **Restarting a crashed owned server** — the stream reports `agent/fatal`; restart is a policy decision.

## Not doing

- Morse will not own the transcript. Losing the engine's storage still loses the conversation.
- Morse will not reimplement an agent loop.
- Not designed for millions of sessions; 10 000 per host is the ceiling worth optimising.
- No manual "sync" button — reconcile is automatic.

## Check

`npm run build:libs && npm run build` and `npm run check-types --workspaces` clean; `npm test` at
85+ files. The honest test: `mv ~/.pi ~/.pi.bak`, restart, confirm the sidebar still lists and titles
everything Morse recorded, and that a pi session reopens through pi.
