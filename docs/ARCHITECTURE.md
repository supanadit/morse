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
                     │ @morse/core                  │  domain + use cases + ports
                     │ @morse/host-runtime          │  host glue (projector + controller)
                     │ @morse/adapter-pi-rpc        │  spawns `pi --mode rpc`
                     └──────────────────────────────┘
```

A host only supplies a transport, its capabilities and the two optional adapters it can offer. The session
controller, the transcript projector and the agent adapter are shared, so both hosts render the same
conversation. See [`FRONTENDS.md`](FRONTENDS.md) for swapping Angular for React, Svelte or something else.

## Packages

| Package | Role | Notes |
|---|---|---|
| `packages/core` | Domain, use cases, ports | Pure TypeScript: no `vscode`, no NestJS, no `child_process` |
| `packages/protocol` | Wire contract between hosts and frontends | Versioned, framework-free, includes the view reducer |
| `packages/host-runtime` | Host glue shared by both hosts | Transcript projection + the client-message session controller |
| `packages/adapter-pi-rpc` | Driven adapter for pi | Spawns `pi --mode rpc`, JSONL client, event mapping, session catalog |
| `packages/ui-runtime` | Frontend core (framework-free) | VS Code / WebSocket / mock transports + the Morse client |
| `packages/ui-angular` | Angular frontend | Emits a static bundle + `webview.manifest.json` |
| `packages/extension` | VS Code host + manifest | Composition root #1 |
| `packages/server` | NestJS host | Composition root #2 |
| `packages/morse-web` | npm delivery (`morse` CLI) | Bundles the server + frontend; `npm i -g @supanadit/morse-web` |

## Layers and dependency direction

```
packages/core             domain + use cases + ports          (imports nothing)
packages/protocol         wire contract + view reducer        (imports nothing)
packages/host-runtime     shared host glue                    (imports protocol, types from core)
packages/adapter-pi-rpc   driven adapter                      (imports core)
packages/ui-runtime       frontend core                       (imports protocol)
packages/ui-angular       frontend presentation               (imports protocol, ui-runtime)
packages/extension        composition root #1 + VS Code delivery
packages/server           composition root #2 + WebSocket delivery
```

Arrows point inward only:

```
extension / server ──> adapter-pi-rpc ──> core <── host-runtime ──> protocol <── ui-runtime <── ui-angular
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
- **R-U2** — `features/x` never imports `features/y`; share through `state/`, `services/`, `ui/` or
  `@morse/ui-runtime`.
- **R-U3** — `ui/` imports nothing from `features/`, `shell/` or `routing/`.
- **R-U4** — `services/` imports nothing from `ui/`.
- **R-U5** — `state/` imports nothing from `services/`.
- **R-U6** — `host/` imports only `@morse/protocol`, `@morse/ui-runtime` and itself.
- **R-U7** — only `shell/` and `routing/` import from more than one feature.
- **R-U8** — any layer may import `@morse/protocol` and `@morse/ui-runtime` freely.

The rules are written for review, not enforced by tooling; `packages/ui-angular/AGENTS.md` § *Layers* is the
working copy of the same list.

## Ports and who owns them (R2 / R10)

| Port | Declared in (consumer) | Implementations |
|---|---|---|
| `AgentGateway`, `AgentGatewayFactory`, `SessionCatalog` | `core/src/session/service.ts` | `adapter-pi-rpc` (subprocess); an SDK adapter could be added without touching core |
| `ChatAgent`, `ChatAgentHolder`, `ChatContextProvider` | `core/src/chat/service.ts` | satisfied structurally by `SessionService` / `ContextService` (module-to-module ports) |
| `EditorContextProvider` | `core/src/context/service.ts` | `VsCodeContextProvider` (real editor), `ClientContextProvider` (fed by `context/attach`) |
| `NativeDialogs`, `HostCommandHandler` | `host-runtime/src/native-dialogs.ts` | `VsCodeDialogs` (QuickPick/InputBox); absent in the NestJS host, which forwards to the frontend |
| `HostTransport` | `ui-runtime/src/transport/host-transport.ts` | `VsCodeHostTransport`, `WebSocketHostTransport`, `MemoryHostTransport` |
| `MORSE_TRANSPORT` (DI token) | `ui-angular/src/app/host/transport.token.ts` | resolved per runtime |

Port types never leak `vscode`, NestJS or child-process types: `pi`'s protocol records are translated into
`AgentEvent` inside the adapter, and `AgentEvent` becomes wire DTOs inside `host-runtime`.

## Rule mapping

- **R1 inward dependencies** — `core` and `protocol` have zero project imports. `host-runtime` imports only
  `protocol` and *types* from `core`.
- **R2 ports on the consuming side** — see the table above; nothing port-shaped lives in `core/src/domain.ts`.
- **R3 adapter isolation / swappability** — `adapter-pi-rpc` is the only package that spawns processes;
  `ui-angular` is the only one that imports Angular; the VS Code API appears only under
  `extension/src/internal/vscode/`. Adapters never import each other.
- **R4 shared adapter utilities** — `host-runtime` is technology-agnostic host glue (no `vscode`, no NestJS,
  no `child_process`), which is why both hosts render byte-identical conversations.
- **R5 1:1 port → adapter** — one adapter file per port role per technology (`pi-rpc-agent.ts`,
  `pi-rpc-session-catalog.ts`).
- **R6 module = use case** — `session`, `chat`, `context`; `chat` and `context` are pure logic with no I/O of
  their own.
- **R7 single wiring point** — exactly two composition roots:
  `packages/extension/src/app/main.ts` and `packages/server/src/app.module.ts` + `src/main.ts`. NestJS's DI
  container *is* the second root; its providers only construct and connect concrete things.
- **R8 domain purity** — `core/src/domain.ts` holds anemic shapes, value objects and sentinel errors only.
- **R9 delivery does marshalling** — commands, webview HTML/CSP, QuickPick dialogs and the WebSocket framing
  live in the delivery layers, not in core.
- **R10 driving-side ports are local** — `MorseChatViewProvider` and `MorseGateway` depend on
  `HostSessionController`, never on concrete services; the controller's `HostSessionServices` is a locally
  declared shape.

## Two hosts, one behaviour

Both hosts use `HostSessionController` from `host-runtime`, which owns the client conversation:

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

Sessions live in a **registry** (`core/src/session/service.ts`): one `pi` process per session, up to
`hotLimit` (LRU), all of them alive at once across projects. Their conversations live next to it, in
`SessionTranscriptStore` (`host-runtime`), which has the same lifetime as the session — so a refresh, a second
window or a host-side reconnect keeps the transcript. `HostSessionController` is per client: it feeds agent
events into the store and forwards the updates of whichever session it is displaying, replaying another
session's transcript when the client switches.

`AgentGatewayFactory.create({ workspace })` already took a workspace per session, so per-project sessions needed
no adapter change at all — the registry was the only missing piece. `ProjectPolicy` is the driven port that
decides which directories are allowed (`ServerProjectPolicy` = `MORSE_PROJECTS` allow-list; a local VS Code
window allows any existing directory).

## Why RPC subprocesses (and not the SDK)

`@earendil-works/pi-coding-agent` is ~436 MB installed. The SDK would have to be bundled into the extension
and into the server, and any hang would stall the VS Code extension host. Instead
`@morse/adapter-pi-rpc` spawns `pi --mode rpc` and speaks the documented JSONL protocol:

- the extension bundle stays ~70 kB and the `.vsix` tiny;
- pi keeps its own process, credentials, config and session files, so a chat started in the TUI can be
  resumed in Morse (and vice versa);
- the adapter is replaceable: an in-process SDK adapter is another implementation of `AgentGateway`.

Framing details that matter (see `packages/adapter-pi-rpc/src/internal/`): split only on `LF`, strip a leading
`CR`, never use `readline` (it also splits on `U+2028`/`U+2029`), decode with `StringDecoder` so multi-byte
characters survive chunk boundaries, correlate responses by id, and treat stderr as diagnostics only.

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
| `@morse/ui-runtime` | `npm run test -w @morse/ui-runtime` | view reducer, client, mock transport |
| `@morse/ui-angular` | `npm run test -w @morse/ui-angular` | app renders host state (mock transport) |
| `morse` (extension) | `npm test -w morse` | activation, contributed commands and view, inside a real VS Code |

The extension test needs a graphical session (or `xvfb-run`); it downloads VS Code on first run.

## Known gaps

Session listing reads pi's JSONL files directly (`~/.pi/agent/sessions/--<cwd>--/*.jsonl`) because the RPC
surface has no "list sessions" command; `switch_session` takes a session *path*, so `SessionSummary.id` is the
file path. Branch/fork management and compaction controls are done; session rename, a diff/review surface and
tool approval policies are the next natural additions and belong in `core` modules plus new wire messages.
