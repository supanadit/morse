# Morse architecture

Morse follows Clean Architecture v4 (`clean-architecture-init` / `clean-architecture-verify` conventions),
adapted to a TypeScript monorepo with **two composition roots**. The rules are language-agnostic; the mapping
below is explicit so the structure can be audited rather than trusted.

## Overview

```
                    ┌───────────────────────────────┐
                    │  @morse/ui-angular (frontend) │   the only frontend
                    └───────────────┬───────────────┘
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
conversation. See [`FRONTEND.md`](FRONTEND.md) for the Angular frontend and its wire contract.

## Packages

| Package | Role | Notes |
|---|---|---|
| `packages/agent` | The harness contract | Pure TypeScript with **no dependencies**: what any agent engine must expose. Must never import `@morse/system` |
| `packages/system` | Morse's domain, session index, use cases **and host glue** | Pure TypeScript: no `vscode`, no NestJS, no `child_process`. Hosts mount `HostSessionController` from here |
| `packages/protocol` | Wire contract between hosts and frontends | Versioned, framework-free, includes the view reducer |
| `packages/engine-config` | Engine-generic configuration foundation | Files, sections and resource stores every engine integration extends: JSON/JSONC, atomic writes, issues and Fix. Imports `@morse/protocol` only |
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
packages/engine-config    engine config files, stores, Fix    (imports protocol)
packages/system           domain, index, use cases, host glue (imports agent, protocol)
packages/integration-pi   driven adapter for pi               (imports agent, system, engine-config)
packages/integration-opencode driven adapter for OpenCode     (imports agent, system, engine-config)
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

The integrations also extend `@morse/engine-config`, which imports `@morse/protocol` only.

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
- **R3 adapter isolation** — the integration packages are the only ones that spawn processes or hold a server connection;
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
frontend ──client/ready, chat/prompt, chat/edit, chat/fork, chat/branch, chat/abort, session/*, model/set, interaction/respond──▶ controller
       ◀──host/ready, session/state, session/activity, transcript/*, session/list, interaction/*, notice, error── controller
```

Inside the controller: `ChatService` validates prompts and picks run vs steer vs follow-up, `SessionService`
owns the `pi` subprocess, `ContextService` builds the editor preamble, and `TranscriptProjector` turns
`AgentEvent`s into the transcript the frontend renders. A host therefore only supplies:

1. a transport (postMessage or WebSocket),
2. capabilities (`hostKind`, `nativeDialogs`, `editorContext`, ...),
3. the two optional adapters it can offer (`NativeDialogs`, `EditorContextProvider`),
4. a host-command handler (`openSettings`, `insertIntoEditor`, `revealFile`, `copyToClipboard`).

### The parity contract: neither host can be forgotten

A feature "for both hosts" is one of three things, and each has a compile-time
never-forget guard — forgetting a host is a build failure, not a bug report:

1. **A capability row** — add it to `DeclaredHostCapabilities`
   (`@morse/protocol/dto/host`). Both hosts' builders return that type, so both
   builds fail until each declares the row (`false` where the feature does not
   apply). The wire shape `HostCapabilities` is derived from the table with
   every row optional, so old frontends and test fixtures are unaffected.
2. **A host command** — add it to `SharedHostCommand` in
   `@morse/protocol/wire/host` when every host must answer it. Both hosts'
   command switches are exhaustive over `HostHandlerCommand`, so each build
   fails until the command is implemented or explicitly refused. A command only
   one host can serve goes in `ServerHostCommand` or `VsCodeHostCommand`; the
   other host's switch reaches it only in a refusal default that names the
   owning group. `ControllerHostCommand` is answered by the shared controller
   before any host handler runs, and the two switches on either side of that
   boundary are both exhaustive.
3. **A client-to-host message** — add a variant to `ClientToHostMessage`. The
   controller's dispatch is exhaustive (`never`-checked): a variant without a
   case fails the `@morse/system` build, and since both hosts mount that same
   controller, both get the behaviour at once. `bot/*` requests are one group
   (`BotClientMessage`) routed by a guard ahead of the switch.

Session-level state that must be the same everywhere is also one store: the
session index lives under `<MORSE_HOME>/sessions` and both hosts reload records
the other wrote (`SessionStore.refreshExternal`), so a Morse-side change such as
a session rename is one truth on the machine.

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
5. keeps a running session's row protected from a stale report while its engine is mid-write;
6. reports the engines it can start (kind, label, default) and accepts the empty session's chosen engine and
   mode when creating a new session — the new record and its derived id are stamped with the engine that created
   it, never the default, and an existing session keeps the engine its record names.

`FileSessionStore` keeps one JSON per record under `<data dir>/sessions/records/<shard>/` plus an append-only
`index.jsonl` of `{token, record}` lines (last-wins; compacted when it outgrows the records). The token is the
last report marker, so a reconcile skips an unchanged session without reading its transcript.

`HostCapabilities` still describes the host, but the engine-specific affordances (MCP administration, prompt
templates, version) come from an engine's optional `AgentExtras`. The browser/NestJS host resolves them **per
engine** — the management commands name the engine they act on — so OpenCode supplies MCP and prompt
administration and no version notice. The VS Code window wires one fixed administration from its **default
engine's** extras and gates MCP on `extras.cli`: an OpenCode-default window shows no MCP manager, while a
pi-default window's MCP panel edits pi from either engine's sessions. `capabilities.engines` carries the
pickable engines; `SessionViewState.draft` marks the empty panel, where the engine may still change.

A harness that offers named ways of working reports `mode` and `availableModes` on its session state. The shared
controller can create a session in a named mode, switch a running one (`mode/set`), and re-read the catalog
(`modes/refresh`). These are optional contract operations: pi omits them, so the panel shows no mode picker.
OpenCode maps them to its primary agents, including user-defined ones; its default comes from the agent
configuration (`default_agent`, otherwise the server's order), never from a Morse constant.

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

## Data compatibility and upgrades

`.morse/` carries a layout version, and `morse start` brings it forward before any service reads it:
versioned migrations once per step (stamped per step, so an interrupted upgrade resumes), then an additive
reconcile on every start that repairs drift without overwriting what the reader owns. A directory written by
a newer Morse is refused rather than downgraded, and every step backs up the JSON it rewrites first. The
contract, the failure rules and how to add a step are in [DATA-COMPATIBILITY.md](DATA-COMPATIBILITY.md);
the runner is `packages/system/src/data/layout.ts`, and bot mode's steps and repair pass are
`packages/system/src/bot/data.ts`.

## Bot mode's presence line

A bot conversation is a chat, not a trace of work: while a bot answers, the chat shows one line of presence
where its message will land — "Wait, let me think…", "Reading launch-brief.md…", "Writing the answer…" — and
nothing else. Two rules follow from that, and both are easy to break by accident:

- **Presence, not a trace.** Tool activity never becomes a transcript entry. The host words each event
  (`packages/system/src/bot/activity.ts` is the only place a tool name becomes English) and pushes it as
  `BotRoutingState.activity`; the row is replaced as the bot moves on and removed when the answer arrives, so a
  reader scrolling back sees the question and the answer, never the middle.
- **The host words it, not the frontend.** Engines name tools differently and extensions invent their own, so
  the label is built where the engine's vocabulary is already translated; the frontend only animates it. An
  unknown tool still reads as a sentence ("Using memory_search …") instead of vanishing.

A turn is announced before its engine is warm (`starting`, "Getting started…"), because starting one takes
seconds and a silent chat in those seconds reads as a dropped message.

A turn belongs to its conversation, not to the window in front: `bot/routing` names the conversation on the
envelope, so turns can run in two rooms at once and a reader moving between them finds each row as the host
last reported it. A turn ending clears exactly its own room, and `bot/open` re-sends the turn in flight plus
every bot's counters for that room (`bot/routing`, one `bot/usage` per bot) — which is what makes a reloaded or
revisited chat show a bot still working instead of looking broken.

### The turn record and the trace store

A turn has two shapes, built from one record: what the room draws while the lane runs, and what the room keeps
once it settles.

- **In memory, while the lane runs.** `packages/system/src/bot/turns.ts` holds one record per bot handle —
  lanes are per bot, so a bot takes one turn at a time, and starting another replaces whatever the record held.
  It keeps the steps (newest last, `TURN_STEPS_MAX` = 8), the asks the turn handed to peers
  (`TURN_HANDOFFS_MAX` = 8) and the tail of the answer so far (`TURN_PARTIAL_MAX` = 2000 characters). There is
  no I/O in it, so the shape a row draws is testable without a service or a file. The host pushes a snapshot as
  `BotRoutingActive` on `bot/routing` — `steps`, `handoffs`, `partial`, `startedAt` — and the frontend owns
  presentation only: the newest step, the elapsed clock, the words revealed by
  `packages/ui-angular/src/app/features/bot-chat/reveal.ts`, and one chip per ask.
- **On settle, into the store.** The settle takes the record once (`take`) — so the trace is written from what
  the tracker actually saw — and one `BotTurnTrace` is built from it: the delivery's id (one turn, one trace),
  the bot's display name as the roster holds it *then* (handles are reusable, so a trace keeps the name it was
  written with), `startedAt`, `endedAt`, `status`, the steps (capped at `TURN_STEPS_MAX`), and each ask with
  how far it had got when this turn settled — read from the ask's delivery at that moment, because a peer can
  answer after the asker is done. `recordTrace` adds it to `BotTraceStore` and pushes a `transcript` event
  carrying the trace and no lines (`entries: []`, `replace: false`): the transcript does not change, and a room
  already showing the answer only learns what history it now has. A failed or cancelled turn is recorded too —
  a turn that wrote nothing still happened. The answer is handed back to its parent room first, so a relayed
  answer exists in the parent before the thread's trace does.
- **The store, on disk.** `packages/system/src/bot/traces.ts`, one JSON array per conversation at
  `<dataDir>/bot/traces/<conversationId>.json`, rewritten whole and atomically — the file plumbing is shared
  with the delivery store (`ConversationFiles`). A conversation's page carries the turns that ended in its
  window (its `traces`, filled by `tracesIn`), which is what lets the chat draw a finished turn above the
  answer it produced. The hourly sweep drops turns older than `TRACE_TTL_MS` (seven days) and keeps a room's
  newest `TRACE_LIMIT` (100); clearing a conversation, or deleting its bot or group, forgets the file with it.
- **History, never context.** Nothing in the store is put into a prompt, and nothing in it is read by a bot. A
  trace is the person's record of the turn; a bot's memory stays the transcript slice and
  `BotSessionRef.toldUpTo`. That is also why the store only stores and serves: there is no status to move and
  no queue to drain.

### What a turn cost

Each bot answers from its own engine session, so usage is kept per `(conversation, bot)`: a room with two
members holds two windows, and neither overwrites the other. The host reads the engine's own counters at the
turn's end (and again after a compaction) and pushes them as `bot/usage`, naming the bot by handle and by
display name — a warm gateway is retired when a bot goes idle, and a ring must not go blank with a process it
never named. A bot that reported most recently is what the composer's single ring draws; each running bot's
presence row draws its own. Clearing a conversation pushes one payload per member with no counters, which is
how the frontend knows whose rings to drop. The same indicator — and the same popup on click — draws a bot's
ring in its `context` variant: spent and remaining tokens, not a code session's message counts, cache, speed
and cost, which would be one bot's half-known numbers claiming more than they can.

### What a bot message can carry

A bot conversation has no workspace picker and no upload route, so a message carries its attachments: `bot/send`
takes `images` (base64, the same `PromptImage` a code session sends) and `files`. Images become prompt content for
the engine; files are decoded by `packages/system/src/bot/attachments.ts` into that bot's own
`workspace/uploads/`, and the prompt names the relative path — each bot's cwd is its own workspace, so the bot
opens it with the tools it already has. A bot's attachments are its own by placement, not by isolation: a bot
with `external_directory` and a shell can read a sibling's uploads. Attachments ride along with
every prompt in the turn, because they are part of the human message; a teammate asked with `bot_send`, which
only ever sees relay text, is told what came with it (`[attached: 1 image, 1 file]`).

### What a bot can reach

A bot runs as the reader, from its own workspace: it is not a container. Its file tools reach the home
directory and its shell runs any command the reader can, so the boundary that matters is **state, not
access**. Morse keeps the engine's state out of the reader's tree — OpenCode's config in `<bot>/config`;
auth, database, sessions and logs in `<bot>/sessions` — by pointing both XDG roots into the bot, though an
`OPENCODE_*` path override inherited from the host is not scrubbed. Each bot's tree is its own by
placement, not by isolation: a bot with `external_directory` and a shell can read a sibling's files.

That split is one environment decision, and the variables are in
[CONFIGURATION.md](CONFIGURATION.md): the bot's server runs with its XDG roots redirected into the bot, and a
generated shell plugin (`<bot>/config/opencode/plugins/morse-user-space.ts`) hands the reader's real roots to
shell commands only. File access beyond the workspace needs no plugin — it is OpenCode's own
`external_directory` permission, allowed exactly when a file tool is. Nothing here is an OS-level sandbox,
and no per-path list is offered as one.

### What a bot knows, and when it learns it

Each bot of a conversation has its **own engine session for that conversation** (`ConversationRecord.sessions`
holds it per member), so a group and a direct message never share one, and two groups never share one. That is
what makes a bot's memory its own — and it is also why Morse cannot rely on it being complete.

Engines do not offer "append these messages to this session without running you": pi owns its session files and
has no such call, and OpenCode's message API differs by version. So Morse does the honest equivalent, at the
moment a bot is asked: it hands that bot **everything said since its last turn**, read from the conversation
transcript, framed as a chat log (`[Launch] Sable: …`). `BotSessionRef.toldUpTo` records the last entry a bot was
given, which is what makes this exact rather than approximate:

- a bot that was not addressed is caught up when it is finally called — including replies that were relayed to
  someone else;
- a bot is never handed its own words back, because those are already its assistant turns in its own session;
- nothing is sent twice, so a long conversation does not grow its prompts quadratically;
- a **new discussion** clears each member's engine session and marks the divider as the boundary, so the fresh
  session starts from there instead of being re-fed the history the reader walked away from;
- an **edit** drops the session (the persona and model are in the engine's files) and therefore starts a fresh
  one, which *is* handed the conversation so far — a new session continuing an old chat has to know it.

The slice is capped (`CONTEXT_MAX_ENTRIES`, `CONTEXT_MAX_CHARS`) and says so when it trims: a bot's window is the
engine's to decide, and an over-long prompt is an overflow waiting to happen.

### `@` in a bot conversation

The composer's `@` is one key with two meanings: in a code session it lists workspace files, in a bot
conversation it lists the members of the room. Same trigger, same keyboard ownership (the caret never leaves the
prompt), different list — `features/mention-picker/` is presentational and the composer owns the query, the
highlight and Enter.

- Rows carry both the handle the host parses (`@job-hunter`) and the name the reader knows (`Job Hunter`), because
  a bot's display name is free text and deliberately never parsed.
- `@all` / `@everyone` sit in a `Special mentions` section in a group, and are hidden in a direct message where
  they would mean what a plain line already does. The host already expanded them in `parseMentions`, so the list
  is the only new part.
- A bot's reply is routed the same way (`replyAddressedBots` in `packages/system/src/bot/bus.ts`): a group
  reply that names a member by handle **asks** it, so the room reads as one line from the asker and then the
  teammate's answer — never a relay line *and* a summary from the same bot. Only a reply that settled normally
  asks (a stopped or failed turn asks nobody); the asker is never woken by an answer to its own ask; `@all` is
  left to people; and the ask spends the sender's bus budget exactly as a `bot_send` would, with a note in the
  room when it is dropped. `bot_send` is for a bot **not** in the room: in a group it refuses and points at the
  mention, so the bot learns the habit inside the turn.

### Model limits are the reader's to state

Auto-discovery is a convenience, never an authority. `GET {baseUrl}/models` is not a spec: a listing often says
nothing about a model's context window, its response cap or its modalities, and when it does say something it can
be wrong. A too-small window makes an engine compact early, a too-large one overflows the model, and a
custom-provider model is text-only in pi unless `input` says otherwise (`ModelDefinitionSchema` in pi's
`model-config.js` defaults it) — so every one of those fields is editable in the wizard, on **create** and on
**edit**.

- Discovery fills in what it can find (`context_length`, `max_context_length`, `max_model_len`,
  `top_provider.context_length`, `max_output_tokens`/`max_completion_tokens`/`max_tokens`,
  `architecture.input_modalities`, `capabilities.vision`) and leaves everything else absent. Absent is a
  decision: nothing is written, and the engine applies its own default.
- The wizard shows a context box, a max-output box and an `image` toggle per model. An emptied box drops the
  field rather than writing `0`.
- Edit bot reads the bot's own providers back out of the engine's config (`BotEngineState.providers`) — without
  any credential, which is why a corrected window never asks for the key again: each layout merges the models
  into the entry the file already has. pi gets `contextWindow`/`maxTokens`/`input`, OpenCode gets
  `limit.context`/`limit.output`/`capabilities.input`.

Pasting an image is gated by the model, not by the mode: a bot whose model reports an `image` modality takes a
screenshot exactly as a code session does, a model that reported itself text-only is refused with the reason, and
one whose engine never said gets the benefit of the doubt — the same rule as the model picker showing no badge
rather than claiming text-only.

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
a diff/review surface remains the next natural addition. OpenCode supplies MCP and prompt-template
administration to the browser host (configured state only, and no version notice); the remaining gap is the VS
Code window's fixed default-engine extras wiring, not OpenCode's integrations.
