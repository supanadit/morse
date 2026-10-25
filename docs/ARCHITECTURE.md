# Morse architecture

Morse follows Clean Architecture v4 (`clean-architecture-init` / `clean-architecture-verify` conventions),
adapted to a TypeScript monorepo with **two composition roots**. The rules are language-agnostic; the mapping
below is explicit so the structure can be audited rather than trusted.

## Overview

```
                    ┌───────────────────────────────┐
                    │  @morse/ui-angular (frontend) │   one frontend,
                    └───────────────┬───────────────┘   swappable
              webview postMessage   │   WebSocket
        ┌───────────────────────────┴─────────────────────────────┐
        │                                                          │
┌───────▼────────────────┐                          ┌──────────────▼─────────────┐
│ morse (VS Code ext.)   │                          │ @morse/server (NestJS)     │
│ composition root #1    │                          │ composition root #2        │
└───────┬────────────────┘                          └──────────────┬─────────────┘
        │        both wire the same packages                       │
        └───────────────────────────┬──────────────────────────────┘
                                    │
                     ┌──────────────▼───────────────┐
                     │ @morse/agent                 │  the harness contract
                     │ @morse/system                │  domain + index + use cases + host glue
                     │ @morse/integration-pi        │  spawns `pi --mode rpc`
                     │ @morse/integration-opencode  │  drives an OpenCode server
                     └──────────────────────────────┘
```

A host only supplies a transport, its capabilities and the two optional adapters it can offer. The session
controller, the transcript projector and the agent adapter are shared, so both hosts render the same
conversation. See [`FRONTENDS.md`](FRONTENDS.md) for swapping Angular for React, Svelte or something else.

## Packages

| Package | Role | Notes |
|---|---|---|
| `packages/agent` | The harness contract | Pure TypeScript with **no dependencies**: what any agent engine must expose. Must never import `@morse/system` |
| `packages/system` | Morse's domain, session index, use cases **and host glue** | Pure TypeScript: no `vscode`, no NestJS, no `child_process`. Hosts mount `HostSessionController` from here |
| `packages/protocol` | Wire contract between hosts and frontends | Versioned, framework-free, includes the view reducer |
| `packages/integration-pi` | Driven adapter for pi | Spawns `pi --mode rpc`, JSONL client, event mapping, session catalog |
| `packages/integration-opencode` | Driven adapter for OpenCode | HTTP client (no SDK), one SSE stream per engine, event/message mapping. Attaches to a server or spawns a private one |
| `packages/ui-runtime` | Frontend core (framework-free) | VS Code / WebSocket / mock transports + the Morse client |
| `packages/ui-angular` | Angular frontend | Emits a static bundle + `webview.manifest.json` |
| `packages/extension` | VS Code host + manifest | Composition root #1 |
| `packages/server` | NestJS host | Composition root #2 |
| `packages/morse-web` | npm delivery (`morse` CLI) | Bundles the server + frontend; `npm i -g @supanadit/morse-web` |

## Layers and dependency direction

```
packages/agent            the harness contract                (imports nothing, no dependencies)
packages/protocol         wire contract + view reducer        (imports nothing)
packages/system           domain, index, use cases, host glue (imports agent, protocol)
packages/integration-pi   driven adapter for pi               (imports agent, system)
packages/integration-opencode driven adapter for OpenCode     (imports agent, system)
packages/ui-runtime       frontend core                       (imports protocol)
packages/ui-angular       frontend presentation               (imports protocol, ui-runtime)
packages/extension        composition root #1 + VS Code delivery
packages/server           composition root #2 + WebSocket delivery
```

Arrows point inward only:

```
extension / server ──> integration-pi ─────┐
                  └──> integration-opencode ─┤
                                             ▼
                              system ──> agent
                                │
                                └──> protocol <── ui-runtime <── ui-angular
```

## Inside a frontend

R1 stops at the package boundary, so `packages/ui-angular` carries its own map. Its layers, inner → outer:

```
routing → shell → features → ui → services → state → host
```

An arrow means *depends on*: a layer may depend only on layers to its right, and may skip the ones in
between. `host` is the seam to a host — the `MORSE_TRANSPORT` port and the client binding over it — and it
sits *below* `state` so that a store can read host state without a cycle (state stores do need the client).

- **R-U1** — an import points only to the right.
- **R-U2** — a panel may render the panels it is made of, but no panel may depend on itself, directly or
  through another.
- **R-U3** — `ui/` imports nothing from `features/`, `shell/` or `routing/`.
- **R-U4** — `services/` imports nothing from `ui/`.
- **R-U5** — `state/` imports nothing from `services/`.
- **R-U6** — `host/` imports no other layer and, of the Morse packages, only `@morse/protocol` and
  `@morse/ui-runtime`. A framework is not a Morse package: every service injects `@angular/core`.
- **R-U7** — only `shell/` and `routing/` import from more than one feature.
- **R-U8** — any layer may import `@morse/protocol` and `@morse/ui-runtime` freely.

Two things every panel is built out of, so that a panel is a panel wherever it sits: `ui/pane/` is the frame
(title bar, count, fold chevron, body) and `ui/splitter/` is the one resize handle. A handle declares which size
it drags; the size lives in `state/layout-state.ts` with every other dragged size, and the *shell* applies it as
a CSS variable. Binding a size in the panel's own template would re-render the rows inside it on every frame of
a drag — which is the difference between a resize that follows the pointer and one that stutters.

`packages/ui-angular/src/app/shell/conventions.spec.ts` is this list as a test: it applies R-U1, R-U2, R-U6
and R-U7 — plus the rule that a component's styles and template live in a sibling `.css`/`.html` — to every
production file of that package, so a broken arrow or a buried stylesheet fails there instead of waiting for a
reviewer. `packages/ui-angular/AGENTS.md` § *Layers* is the working copy of the same list.

## Ports and who owns them (R2 / R10)

| Port | Declared in (consumer) | Implementations |
|---|---|---|
| `AgentGateway`, `AgentGatewayFactory`, `AgentHistoryPage`, `SessionEngine` | `agent/src/ports.ts`, `agent/src/engine.ts` | `integration-pi` (one subprocess per session), `integration-opencode` (one server, one stream) |
| `SessionCatalog`, `SessionStore` | `system/src/session/ports.ts` | `PiRpcSessionCatalog` / `OpenCodeSessionCatalog` (for deletes and reconcile); `FileSessionStore` (Morse's index). The sidebar reads the index through `AgentRouter` |
| `AgentExtras` (`mcp`, `prompts`, `version`, `cli`) | `system/src/session/integration.ts` | Supplied by pi; absent for OpenCode, which hides those host affordances |
| `ChatAgent`, `ChatAgentHolder` | `morse/src/chat/ports.ts` | satisfied structurally by `SessionRegistry` (module-to-module ports) |
| `EditorContextProvider` | `morse/src/context/ports.ts` | `VsCodeContextProvider` (real editor), `ClientContextProvider` (fed by `context/attach`) |
| `NativeDialogs`, `HostCommandHandler` | `system/src/host/native-dialogs.ts` | `VsCodeDialogs` (QuickPick/InputBox); absent in the NestJS host, which forwards to the frontend |
| `HostTransport` | `ui-runtime/src/transport/host-transport.ts` | `VsCodeHostTransport`, `WebSocketHostTransport`, `MemoryHostTransport` |
| `MORSE_TRANSPORT` (DI token) | `ui-angular/src/app/host/transport.token.ts` | resolved per runtime |

Port types never leak `vscode`, NestJS or child-process types: `pi`'s protocol records are translated into
`AgentEvent` inside the adapter, and `AgentEvent` becomes wire DTOs inside `system/src/host/`.

## Rule mapping

- **R1 inward dependencies** — `agent` has zero dependencies at all (an empty `dependencies` is the
  enforcement), and `protocol` has zero project imports. `system` imports `agent` and `protocol`.
  A harness adapter depends on `agent` alone; only Morse's own code sees `morse`.
- **R2 ports on the consuming side** — see the table above; nothing port-shaped lives in a `domain.ts`.
- **R3 adapter isolation / swappability** — the integration packages are the only ones that spawn processes or hold a server connection;
  `ui-angular` is the only one that imports Angular; the VS Code API appears only under
  `extension/src/internal/vscode/`. Adapters never import each other.
- **R4 shared adapter utilities** — `system/src/host/` is technology-agnostic host glue (no `vscode`, no NestJS,
  no `child_process`), which is why both hosts render byte-identical conversations.
- **R5 1:1 port → adapter** — one adapter file per port role per technology (`pi-rpc-agent.ts`,
  `pi-rpc-session-catalog.ts`).
- **R6 module = use case + its ports** — `session`, `chat`, `context`; a module's ports live in its own `ports.ts`, its use case in `service.ts`. `chat` and `context` are pure logic with no I/O of
  their own.
- **R7 single wiring point** — exactly two composition roots:
  `packages/extension/src/app/main.ts` and `packages/server/src/app.module.ts` + `src/main.ts`. NestJS's DI
  container *is* the second root; its providers only construct and connect concrete things.
- **R8 domain purity** — `agent/src/domain/` and `morse/src/domain/` hold anemic shapes, value objects and
  sentinel errors only.
- **R9 delivery does marshalling** — commands, webview HTML/CSP, QuickPick dialogs and the WebSocket framing
  live in the delivery layers, not in `morse`.
- **R10 driving-side ports are local** — `MorseChatViewProvider` and `MorseGateway` depend on
  `HostSessionController`, never on concrete services; the controller's `HostSessionServices` is a locally
  declared shape.

## Two hosts, one behaviour

Both hosts use `HostSessionController` from `@morse/system`, which owns the client conversation:

```
frontend ──client/ready, chat/prompt, chat/edit, session/*, model/set, interaction/respond──▶ controller
       ◀──host/ready, session/state, session/activity, transcript/*, session/list, interaction/*, notice, error── controller
```

Inside the controller: `ChatService` validates prompts and picks run vs steer vs follow-up, `SessionService`
owns the `pi` subprocess, `ContextService` builds the editor preamble, and `TranscriptProjector` turns
`AgentEvent`s into the transcript the frontend renders. A host therefore only supplies:

1. a transport (postMessage or WebSocket),
2. capabilities (`hostKind`, `nativeDialogs`, `editorContext`, ...),
3. the two optional adapters it can offer (`NativeDialogs`, `EditorContextProvider`),
4. a host-command handler (`openSettings`, `insertIntoEditor`, `revealFile`, `copyToClipboard`).

### Handshake and session lifetime

The host answers `client/ready` **immediately** with a truthful state (`agentStarting: true` while `pi` spawns),
because a client that only knows its own defaults would render "agent unavailable" for the whole spawn time.
`connection` therefore means "a host answered the handshake", not "a socket is open".

UI state rules that follow from this (**do not regress them**):

- The **badge carries the whole happy path** (`connecting` → `starting` → `ready`); the healthy path renders **no
  banner at any moment**, so a load never flashes an error.
- Banners are reserved for real problems: a refused handshake (`lastError`), `error`/`closed`, a `pi` start
  failure *after* a successful handshake (`connection === 'ready' && !agentReady`), or a handshake that has been
  pending for more than 6 s (`slowConnection` in `MorseService`).
- A frontend that judged the agent before the handshake made a stalled host look like a broken `pi` binary.

Sessions live in a **registry** (`morse/src/session/service.ts`): one gateway per session, up to `hotLimit`
(LRU), all of them alive at once across projects. A gateway is a pi process or a view onto an OpenCode session,
depending on the engine that owns it. Conversations stay with the engine; `SessionTranscriptStore`
(`@morse/system`) keeps the *live* rendering next to the registry, so a refresh, a second window or a host-side
reconnect keeps the transcript. `HostSessionController` is per client: it feeds agent events into the store and
forwards the updates of whichever session it is displaying, replaying another session's transcript when the
client switches.

`ProjectPolicy` is the driven port that decides which directories are allowed (`ServerProjectPolicy` =
`MORSE_PROJECTS` allow-list; a local VS Code window allows any existing directory).

### Two engines, one id space

The registry is handed an **`AgentRouter`** (`system/src/session/agent-router.ts`), not one adapter. The router:

1. derives Morse's id from `(engine kind, engine session id)` and writes a `MorseSessionRecord` into
   `FileSessionStore` when a session starts or forks;
2. wraps every gateway so `state().sessionId` — and the states carried by `agent/ready` / `agent/state` — name
   the *derived* id, which is what the registry, the tabs and the wire key on;
3. resolves an id back to the engine that owns it, using the record's `engineRef`, so resuming never guesses;
4. serves the sidebar `SessionCatalog` from the index, refreshing it on demand (`ensureFresh()`: debounced,
   one scan per engine, and a scan that cannot report never removes that engine's rows);
5. keeps a running session's row protected from a stale report while its engine is mid-write.

`FileSessionStore` keeps one JSON per record under `<data dir>/sessions/records/<shard>/` plus an append-only
`index.jsonl` of `{token, record}` lines (last-wins; compacted when it outgrows the records). The token is the
last report marker, so a reconcile skips an unchanged session without reading its transcript.

`HostCapabilities` still describes the host, but the engine-specific affordances (MCP administration, prompt
templates, version) now come from the **default engine's** optional `AgentExtras`; an engine that has none —
OpenCode — leaves the host showing no MCP editor, no prompt editor and no update notice.

## Why RPC subprocesses (and not the SDK)

`@earendil-works/pi-coding-agent` is ~436 MB installed. The SDK would have to be bundled into the extension
and into the server, and any hang would stall the VS Code extension host. Instead
`@morse/integration-pi` spawns `pi --mode rpc` and speaks the documented JSONL protocol:

- the extension bundle stays ~70 kB and the `.vsix` tiny;
- pi keeps its own process, credentials, config and session files, so a chat started in the TUI can be
  resumed in Morse (and vice versa);
- the adapter is replaceable: an in-process SDK adapter is another implementation of `AgentGateway`.

Framing details that matter (see `packages/integration-pi/src/internal/`): split only on `LF`, strip a leading
`CR`, never use `readline` (it also splits on `U+2028`/`U+2029`), decode with `StringDecoder` so multi-byte
characters survive chunk boundaries, correlate responses by id, and treat stderr as diagnostics only.

### Why OpenCode is a server, not a subprocess

OpenCode's model is different: one long-lived local server, Basic auth, and one SSE stream carrying every
session's events. `integration-opencode` therefore keeps **one connection and one stream per engine**, routes
events to sessions by `data.sessionID`, and exposes each session as an ordinary `Session`/`AgentGateway`. It
attaches to a configured server (`MORSE_OPENCODE_URL` + password) or spawns a private one and reads the address
and password it announces; only the spawned one is stopped on shutdown. It deliberately speaks the installed
server's v2 HTTP API instead of the pre-release `@opencode-ai/sdk`, whose generated types already disagree with
it.

## Protocol versioning and the frontend manifest

`PROTOCOL_VERSION` lives in `packages/protocol/src/version.ts`. Every frontend build writes
`webview.manifest.json` next to its `index.html`; hosts read it, compare the protocol version, and refuse to
talk to a mismatched build instead of failing mysteriously. The wire messages are validated by
`parseClientMessage` / `parseHostMessage`, so malformed frames are ignored rather than crashing a host.

## NestJS host specifics

Two things about the NestJS host are easy to get wrong:

- **Always use explicit `@Inject(...)` on constructor parameters.** NestJS resolves parameters either
  explicitly or from `design:paramtypes` metadata, and that metadata only exists when the compiler emits
  `emitDecoratorMetadata`. `tsc` does; esbuild-based runners (`tsx`, `vite-node`) do not, so a parameter
  without `@Inject` resolves to `undefined` there and Nest reports
  "can't resolve dependencies of X (?, ...)". This is also why `npm run dev:server` builds with `tsc --watch`
  and runs the compiled output with `node --watch`, so development uses exactly the same compiler settings as
  production.
- **Shutdown is explicit.** `main.ts` calls `app.enableShutdownHooks()` and `MorseGateway` implements
  `onModuleDestroy` to dispose every live session. Without that, a restart leaks the spawned `pi`
  subprocesses and the new process fails with `EADDRINUSE`. Note that `node --watch` restarts on file change;
  after a crash it waits for the next change before restarting.

### UI shape follows the host scope

`HostCapabilities.scope` is what keeps the frontend honest about what each host can see:

- `global` (browser host): projects → sessions. Every project pi knows about is listed.
- `workspace` (VS Code): one group for the folders the window has open.
  `HostSessionController` filters projects **and** sessions to those roots and refuses to open an agent outside
  them.

The layout follows the surface, not the host: at ≥760px the navigation is a second column (browser host), below
that it becomes a drawer behind the ☰ button (VS Code sidebar). One bundle, both shapes.

## Testing

| Suite | Command | Covers |
|---|---|---|
| `@morse/system` | `npm run test -w @morse/system` | index/store/reconcile, router, controller, projector |
| `@morse/integration-pi` | `npm run test -w @morse/integration-pi` | RPC framing, event mapping, catalog |
| `@morse/integration-opencode` | `npm run test -w @morse/integration-opencode` | connection, SSE stream, event/message/model mapping, agent, catalog |
| `@morse/ui-runtime` | `npm run test -w @morse/ui-runtime` | view reducer, client, mock transport |
| `@morse/ui-angular` | `npm run test -w @morse/ui-angular` | app renders host state (mock transport) |
| `morse` (extension) | `npm test -w morse` | activation, contributed commands and view, inside a real VS Code |

The extension test needs a graphical session (or `xvfb-run`); it downloads VS Code on first run.

## Known gaps

Session listing is Morse's index, fed by each engine's optional `scan()`; pi's catalog still reads its JSONL
files (`~/.pi/agent/sessions/--<cwd>--/*.jsonl`) because the RPC surface has no "list sessions" command, but the
id Morse exposes is the derived one. Session rename lives with the engine (neither adapter exposes one yet), and
a diff/review surface remains the next natural addition. OpenCode supplies no MCP or prompt-template
administration, so those host editors are absent when it is the default engine.
