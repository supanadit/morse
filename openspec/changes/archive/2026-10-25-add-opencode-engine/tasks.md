# Tasks

## 1. Index: file store and token persistence

- [x] 1.1 Add `tokens?()` to `SessionStore` and an optional token param to `write(record, token?)` in `@morse/system`, and make `reconcileSessions` pass the reported token — verify with the existing `session-reconcile` tests updated to cover persistence (npm test -w @morse/system)
- [x] 1.2 Implement `FileSessionStore` in `packages/system/src/session/file-store.ts`: sharded one-JSON-per-record writes (tmp + rename), a JSONL index of `{token, record}` with last-wins load, and compaction when the index exceeds a size threshold — verify by writing, reloading and compacting a store in a temp dir (npm test -w @morse/system)

## 2. Routing: engine router and Morse ids

- [x] 2.1 Add `AgentRouter` + `RoutedGateway` to `@morse/system`: resolve a Morse id through the record to the owning engine's factory, wrap state and `agent/ready`/`agent/state` events so `state.sessionId` is the derived id, upsert the record on create, and re-derive plus re-write (with `parentId`) after `fork()` — verify with a two-fake-engine routing test proving resolution, re-key and removal paths
- [x] 2.2 Serve `SessionCatalog` from the store in the router (`list`, `listPage`, `search`, `countByProject`, `remove` routed through the owning engine) and gate engine scans behind a debounced `ensureFresh()` that never wipes rows when an engine cannot report — verify with a fake-engine test showing merged listings aross kinds, delete-through-engine, and a failed-scan no-op
- [x] 2.3 Extend `SessionRegistry` to hold `engines: SessionEngine[]`, reconcile once per engine (each scoped to its own kind) and keep the registry key from `state.sessionId`; wire both hosts to build the router + `FileSessionStore` and register `pi` from the existing adapter — verify the full pi flow (list, open, stream, fork, delete, resume) against the local server with ids equal to the derived ones
- [x] 2.4 Update `HostSessionController` comments/types that assume an engine id key, and confirm persisted VS Code tabs degrade gracefully when an id no longer resolves — verify via a controller test for an unknown-id open failure

## 3. OpenCode adapter: connection and streaming

- [x] 3.1 Scaffold `@morse/integration-opencode` (package.json deps `@morse/agent` + `@morse/system`, tsconfig, root `build:libs` entry, README skeleton) — verify `npm run build:libs` includes it and `node scripts/check-agent-boundary.mjs` stays green
- [x] 3.2 Implement `internal/connection.ts`: attach with Basic auth to a configured URL, or spawn `opencode serve --hostname 127.0.0.1 --port 0` and parse the address and password lines with a timeout, plus error mapping for unreachable/unauthorized and a missing binary — verify with fixture tests over a fake server and a fake binary
- [x] 3.3 Implement `internal/event-stream.ts`: one SSE subscription per engine with per-session routing, reconnect with backoff, and death reporting as `agent/fatal` to each open session — verify with a fixture stream that reconnects and a process-exit case
- [x] 3.4 Implement `internal/event-mapping.ts` normalizing `session.*` / `session.next.*` and `data` / `properties`: run start/end (with single-end dedupe), text and thinking deltas, tool start/progress/end with derived titles, usage, retry notice, compaction, errors — verify against recorded SSE fixtures from a real 2.1.4 server

## 4. OpenCode adapter: sessions, models and history

- [x] 4.1 Implement `OpenCodeAgent` (extend `Session`) with eager session creation, resume by id, lazy state maintained from `session.updated` and execution events, `prompt` mapping (`followUp` → queue delivery, images via uploads, attachments reported when unsupported), `abort` and detach-only `dispose` — verify by prompting a disposable real session and asserting the emitted event sequence end-to-end (opt-in via `MORSE_OPENCODE_URL`)
- [x] 4.2 Implement `internal/message-mapping.ts` and `history()`/`forkMessages()`: newest-first paging with cursor, filtering out bookkeeping rows, tool/compaction/shell projections, and user-message listing for forks — verify with a fixture message list covering text, reasoning, tool, compaction and shell rows
- [x] 4.3 Implement `internal/model-mapping.ts`, `setModel` / `setThinkingLevel` via the `session/{id}/model` endpoint, with variant→level mapping that tolerates a default sentinel — verify with a fixture of a model with variants, one without, and one carrying `default`
- [x] 4.4 Implement fork (`/fork`), compact (`/compact`, instructions unsupported → warn + compact), and model/agent/command/skill catalogs feeding `availableModels` / `availableThinkingLevels` / `availableCommands` — verify each against the disposable real session

## 5. OpenCode adapter: catalog, scan and engine wiring

- [x] 5.1 Implement `OpenCodeSessionCatalog` (`list`, `listPage`, `search`, `countByProject`, `remove`) with `location.directory` grouping and archived filtering — verify against a fake client and, once live, against a real server
- [x] 5.2 Implement `OpenCodeEngine` (`kind`, `factory`, `scan()` paging the full session list into `AgentSessionInfo`, `dispose()` that closes its own spawned server but never an attached one) and `OpenCodeAgentFactory.probeDefaults()` reading model/agent/command/skill catalogs without creating a session — verify with a fake client and a disposable live session
- [x] 5.3 Wire engine auto-detection in both hosts and expose `MORSE_ENGINE(S)` / `morse.engine` and `MORSE_OPENCODE_*` options; a host with neither OpenCode binary nor URL behaves exactly as today — verify by running the browser host against a disposable server (`npm run build:libs && npm run build && npm run build:server` then launch)

## 6. Interaction forms

- [x] 6.1 Add `AgentFormRequest` (+ field types, `when` visibility) and `values` on `AgentInteractionResponse` to `@morse/agent/src/domain/agent/interaction.ts`, keeping shapes import-clean — verify with the boundary check and typecheck (npm run check-types -w @morse/agent)
- [x] 6.2 Mirror the shapes in `@morse/protocol/src/dto/interaction.ts`, map them in `view-state.ts`, and forward `values` through `HostSessionController.respondToInteraction`, routing `form` to the webview even when native dialogs exist — verify against a fake-engine controller test
- [x] 6.3 Render forms in `packages/ui-angular/src/app/features/interaction`: one control per field, required/min/max/pattern validation, `when` visibility, submit → `values`, cancel → `cancelled`, visible in both hosts and unchanged for existing kinds — verify by driving OpenCode's form surface through both hosts
- [x] 6.4 Mafreep OpenCode `Form.Info` → `AgentFormRequest` and reply/cancel in the adapter, discovering forms via SSE with a connect-and-execution polling fallback — verify against a disposable real session that creates one (opt-in via `MORSE_OPENCODE_URL`)

## 7. Capability ports and composition-root cleanup

- [x] 7.1 Introduce optional `AgentExtras` (`mcp`, `prompts`, `version`, `cli`) on `AgentIntegration`, re-point both hosts' MCP/prompt/version handling at it, and move pi's parsers behind it; OpenCode supplies none — verify by launching each host with OpenCode selected and confirming the MCP editor, prompt editor and pi update check are absent while nothing else regresses
- [x] 7.2 Add `dispose?()` to `SessionEngine` and call it from both hosts' shutdown paths — verify by disposing the server host with an owned OpenCode server running and confirming the process stops

## 8. Final integration

- [x] 8.1 Update `docs/ARCHITECTURE.md`, `docs/STATUS.md`, `docs/ROADMAP.md` ticked items, `docs/NOTES-AGENT-AGNOSTIC.md` decisions, and README package tables — verify by reading through for a pi-only reader and an OpenCode reader
- [x] 8.2 Add an OpenCode access guide (server, auth, options) to `docs/CONFIGURATION.md` and verify each documented option maps to a real env/setting name
- [x] 8.3 Run the monorepo checks end to end and record the result: `npm run build && npm run test -w @morse/agent && npm run test -w @morse/system && npm run test -w @morse/integration-opencode && node scripts/check-agent-boundary.mjs`
- [x] 8.4 Exercise the full dual-engine flow by hand: create a pi session and an OpenCode session in the same workspace, switch between them, fork each, approve a tool from OpenCode, restart the host and reopen both — verify by the observed transcript and sidebar behavior
