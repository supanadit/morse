# Bot mode — isolated agents that talk to each other

Date: 2026-11-13
Status: pending owner approval (builder check done; owner answered tool-access and credential questions)

## Intent and why

Morse's toolbar carries a disabled **Bot — coming soon** mode. The reference is OpenBot
(github.com/nightly-labs/openbot): a roster of *bots* — persistent, individually configured agents —
that the user chats with directly and that can talk to each other in shared group conversations.

Morse's foundations already cover the hard part: two engines (pi, OpenCode) behind one
`SessionEngine`/`AgentGateway` abstraction, routed by `AgentRouter`. What is missing is
**isolation** and **conversation routing**:

- **Isolation.** A bot is not a session in the user's code-mode workspace. It is its own agent with
  its own engine config, its own session storage and its own identity, all under
  `~/.morse/bot/<agent-name>/`. No project picker, no model picker — a bot's model, thinking level
  and persona are fixed when the bot is created.
- **Routing (the middleman illusion).** A group chat *looks* like one room. Under the hood every
  bot has its own private engine session; Morse relays messages between those sessions. Each bot's
  context holds only what was addressed to it — the routing *is* the context filter. Morse never
  shares state between bot configs.

MVP goal: the foundation working end to end — create a bot, DM it, make a group, watch bots talk
to each other — not a full-fledged product.

## Goals

- A **Bot mode** in the shell (the existing toolbar button becomes real). It swaps the sidebar to
  a bot roster (DMs) plus a groups list; code mode is untouched.
- **Bots** stored under `~/.morse/bot/<agent-name>/`:
  - `config/` — engine-native isolated config (a private `~/.pi/agent` or `~/.config/opencode`)
  - `sessions/` — the engine's own session storage for this bot
  - `workspace/` — the bot's cwd: optional user-authored `AGENTS.md` plus scratch space
  - `engine.json` — Morse-level identity: name, description, avatar, engine kind, model,
    thinking level, persona system prompt
- **Wizard bot creation**: identity → engine (pi/OpenCode) → credentials (paste keys, stored
  engine-natively in the bot's config; advanced alternative: name env vars to pass through) →
  model + thinking level from that engine's live catalog → explicit persona system prompt →
  optional MCP servers in the bot's own engine config → optional `AGENTS.md` → (OpenCode) named
  subagents with per-subagent system prompts. Advanced
  escape hatch in the same dialog: point at an existing config dir. **No cloning** of `~/.pi` /
  `~/.config/opencode`; nothing is copied silently.
- **Bots run autonomously with a minimal-UI transcript** (owner decision): tool activity stays
  collapsed/hidden — the conversation shows the bot's final replies; when an engine pauses mid-turn
  for a confirmation/selection, Morse auto-answers with the engine default and logs the request and
  answer as a transcript note. A human-approval flow (OpenBot's Approve/Deny) is deferred.
- **Conversations**: DMs (user ↔ one bot) and groups (user + N bots, or bot-only membership is not
  required — the user is always a member). Group creation picks members and optionally crowns a
  **lead** bot.
- **Routing** (see Approaches for the decided model):
  - DMs: straight to the bot, no routing.
  - Groups: `@name` targets that bot; `@all` / `@everyone` targets everyone **sequentially, each
    answering after (and seeing) the previous bots' replies this round**; an unaddressed message in
    a facilitated group goes to the **lead bot** first, which answers and/or mentions teammates;
    with no lead, the message waits for a mention.
  - **Chains**: a bot reply that mentions another bot is relayed automatically. A per-message
    depth cap (default 8, per-group setting) bounds bot-to-bot rallies.
- **Engine lifecycle on demand**: a bot's engine runs only while a conversation needs it
  (pi: process-per-session, exactly like code mode; OpenCode: the bot's own server bound to its
  config dir), idling out after inactivity.
- **Transcript attribution**: every message shows its author — user, or bot with avatar and name.

## Non-goals (deferred, not rejected)

- A memory/fact layer (OpenBot-style compact memories injected per turn).
- Proactive or scheduled bot-initiated messages; bots speak only when spoken to (user message or
  relayed mention).
- The hidden-router facilitator (Approach A below) — revisitable after the lead bot ships.
- External chat platforms (Slack/Discord/Telegram/WhatsApp bridges).
- "Promote this session into a bot" import.
- Sharing bots or groups between hosts; bot state is per-host data dir.

## Anti-goals

- Morse silently copying the user's global engine config or credentials into bot dirs.
- A shared transcript file that bots read from directly — the illusion must stay sessions-only.
- Bot conversations appearing in the code-mode session list, or code sessions appearing in Bot mode.
- Untbounded autonomous loops: no relay may proceed without a mention, and no user message may
  trigger more than the chain cap.
- A second model-selection surface in Bot mode.

## Constraints

- **Engine abstraction holds.** Bot sessions go through the same `SessionEngine`/`AgentGateway`
  ports as code mode, but the bot layer adds no engine-specific logic of its own. Engine-specific
  isolation (env vars, config writing) lives in the integration packages (`@morse/integration-pi`,
  `@morse/integration-opencode`) as new exports; the system layer must stay engine-agnostic (repo
  rule: agent boundary check).
- **`AgentRouter` does not fit bots as-is** (checked against the code): it keys engines by kind in a
  `Map`, so two bots on the same engine kind cannot coexist, and every gateway it hands out writes a
  row into the code-mode session store. Bots therefore bypass the router: one engine factory
  instance per bot (their spawn env/config is fixed at construction anyway), with the engine session
  id kept in the bot registry instead of a Morse session-store index.
- **Isolation plumbing is partly missing and must be built** (checked against the code):
  - pi: `--session-dir` is a first-class `resolvePi` option, but the agent dir is not — isolation
    means handing a per-bot `PiRpcAgentFactory` a fully merged `env` that sets
    `PI_CODING_AGENT_DIR`. That `env` also resolves `MORSE_PI_PATH`/`PATH`, so it is a complete
    environment, not a fragment.
  - OpenCode: the connection accepts spawn `env`, but `OpenCodeMcp`/`OpenCodePrompts` resolve their
    config dir from `process.env.XDG_CONFIG_HOME` and no caller threads a config dir through — a
    bot would read/write the user's global `~/.config/opencode`. The integration must plumb an
    explicit config/data dir end to end, not just spawn env.
  - `openOpenCodeEngine` returns `undefined` on failure; the wizard path needs the failure reason,
    so the isolated factory surfaces errors instead of swallowing them.
- **Credential storage is in scope for MVP** (owner decision): each integration gains a
  credential writer that persists pasted keys in its engine's own auth format inside the bot's
  `config/` (pi: its agent-dir auth; OpenCode: its auth store in the bot's data dir). The system
  layer stays engine-agnostic — the wizard learns the credential style from each engine's
  capability descriptor. Env-var passthrough remains the advanced alternative in the same step.
- **Composer/transcript reuse is a refactor, not a composition** (checked): both inject the
  singleton `MorseService` and assume one conversation in front. Bot mode needs N conversations, so
  the MVP extracts the pieces Bot mode needs without reshaping code mode's surfaces.
- **Bot mode is a web-host capability.** The toolbar's mode row already renders only when
  `capabilities.hostKind === 'server'`; `HostCapabilities` gains an explicit `bot` flag rather than
  the UI inferring one. The bot root follows the server's data root (`MORSE_HOME ?? ~/.morse` →
  `bot/`), not a hard-coded `~/.morse`.
- **Two hosts, one implementation.** The bot layer lives in the shared system package, so the VS
  Code extension can adopt it later; MVP ships it on the server/browser host only (the owner's
  screenshots and the existing mode gate both point there).
- **Existing engines keep working.** Code mode's engine registry, sessions and pickers are not
  reshaped; Bot mode adds a parallel registry and its own UI surfaces.
- **Session economics** (decided with the owner after studying OpenBot — see Session strategy).

## Approaches

### How unaddressed group messages route

1. **Hidden router (Morse-owned model call).** Morse itself asks a cheap model who should answer.
   Rejected for MVP: it gives Morse its own credential/config surface (a new subsystem), adds a
   latency hop per turn, and makes Morse a participant instead of a middleman.
2. **Designated lead bot (chosen).** One member is the group's lead; unaddressed messages hit the
   lead's session first with a routing brief; the lead answers and/or `@mentions` teammates whose
   replies Morse relays. Zero new config, matches OpenBot's validated orchestrator pattern (their
   Slack/Discord/Telegram Orchestrator is exactly this), and degrades gracefully: facilitated group
   without a lead behaves as mentions-only.

### Session strategy (the owner's cache concern)

The owner worried that persistent sessions are expensive: leave for a day, and the provider's
prompt cache has expired, so the next message re-sends the whole context at full input price — and
asked whether bots should instead get *fresh* sessions per message, carrying only relevant context.

**OpenBot's actual answer** (from their README and `docs/messaging.md`): they do **not** do
fresh-per-message. They keep persistent threads ("Each conversation is its own thread of that
agent") and manage tokens with four tools:

1. **Routing as the context filter** — the host "keeps only the messages that address OpenBot or
   continue a conversation it has"; everything else never enters any agent's context.
2. **Bounded context injection** — a new Discord conversation gets "the channel's last 10 messages
   from the 15 minutes before it"; thread-scoped context on Slack; a `messaging_history` tool
   (30 messages default, 100 max) lets the agent *pull* more only when it needs to.
3. **A compact fact store** — workspace memories: at most 32 facts × 500 characters, injected into
   every prompt as data, not instructions.
4. **Automatic compaction** — "Per-agent context monitoring with automatic compaction before long
   threads exhaust the model window."

**Decision — persistent engine-native sessions, with the economy coming from routing, not
ephemeral sessions.** Fresh-per-message pays the full-price context resend on *every* message
(persona + facts + window, re-sent each turn); a persistent session pays it once after each cache
gap and re-warms. pi and OpenCode both already persist sessions and compact long threads natively,
so Morse adds no session subsystem. Morse's routing gives the OpenBot filter for free: a bot's
session only ever holds relays addressed to it plus its own replies. Relays are compact — a short
header (conversation, author) plus message text, never a transcript dump.

Owner control over the cost knob: a **New discussion** action on any DM or group starts fresh
sessions for that conversation (old ones stay on disk in the bot's `sessions/`). That is the
user-controlled version of the fresh-session instinct, without losing continuity by default.

### Bot creation

1. **Wizard (chosen)** — explicit persona, model, thinking level; credentials pasted or referenced
   per bot; nothing inherited silently. OpenCode bots may define subagents with their own prompts.
2. Clone from the user's global config — rejected by the owner outright.
3. Bring-your-own config dir — kept as an advanced toggle inside the wizard, not a separate path.

### Provider management (added 2026-11-14, owner-directed)

The wizard is a **full-page view** (never a modal): step rail at top, live summary panel right,
large content area. It replaces the modal entirely for bot creation.

The Connect step is a **provider manager over the bot's isolated config** — the UI equivalent of
hand-editing `~/.config/opencode/opencode.json` or `~/.pi/agent/models.json`, scoped to
`~/.morse/bot/<name>/`:

- **Provider record** (Morse's abstraction): `{ id, label, api, baseUrl?, credential, models }`
  where `api` is one of `openai-completions | openai-responses | anthropic-messages |
  google-generative-ai` and `credential` is a stored key or an `$ENV` reference.
- **Engine mapping**: OpenCode bots get a `providers.<id>` block in the bot's `opencode.json`
  (`package` chosen by `api`: openai-completions → `@opencode/ai/providers/openai-compatible`,
  anthropic-messages → `@opencode/ai/providers/anthropic-compatible`, google-generative-ai →
  `@opencode/ai/providers/google`; `settings.baseURL`; key via `settings.apiKey` or `env`), with
  `models` written as a map. pi bots get a `providers.<id>` block in the bot's `models.json`
  (`baseUrl`, `apiKey` (or `$ENV`), `api`, `models` array with `id`/`contextWindow`/`maxTokens`).
- **Discovery**: OpenAI-compatible providers — Morse calls `GET {baseUrl}/models` with the key and
  fills the list (covers proxies, Ollama/vLLM/LM Studio, OpenRouter-style gateways). Known catalog
  providers — key only; the engine probe discovers. anthropic-messages / google-generative-ai /
  openai-responses — inline manual model-id rows (no standard listing endpoint), with presets for
  well-known families. The user can always add model ids manually.
- **Add-model rows** are always available regardless of discovery, so a provider whose API cannot be
  listed still works.

The engine model probe (existing `bot/probeModels`) remains for catalog providers; the provider
manager is the general mechanism and the probe becomes one of its discovery strategies.

## The decided design

### On-disk layout

```
~/.morse/bot/
  registry.json                     # bots, groups, conversations (Morse's own records)
  <agent-name>/
    engine.json                     # identity: name, description, avatar, engine kind,
                                    #   model, thinking level, persona prompt
    config/                         # engine-native isolated config + credentials
    sessions/                       # engine's own session storage (pi --session-dir,
                                    #   or OpenCode's storage when XDG_DATA_HOME points here)
    workspace/                      # bot cwd: optional AGENTS.md, scratch space
```

- Bot names are directory-safe and unique; the registry is the source of truth, `engine.json` the
  portable identity.
- One conversation maps to one engine session per participating bot: a DM is one pair; a group with
  three bots is three sessions. "New discussion" starts new sessions for every participant; the old
  ones remain in `sessions/` as the engine keeps them.

### The bot layer's shape (system layer, engine-agnostic)

- **Per-bot engine factories, bypassing `AgentRouter`.** Each bot owns a factory instance (created
  from the integration's isolated-engine export with the bot's config dirs and env) and the
  conversation→engine-session-id mapping lives in the bot registry. `registry.json` is the index;
  there is no second Morse session store for bots, and nothing writes into the code-mode one.
- **Model and thinking level are stored in `engine.json` and applied on each session open**
  (`setModel`/`setThinkingLevel`, the same runtime path code mode uses) — not written into
  engine-native config at wizard time, which would require Morse to model engine settings schemas
  that are version-fragile and per-model (pi reports thinking levels per current model).
- **Persona is delivered engine-natively by the integration package.** Each integration exports a
  bot-identity writer that persists the persona prompt into the bot's `config/` using that engine's
  own mechanism; if an engine has no native slot, its integration prepends it on the session's
  first turn. The user-authored `AGENTS.md` in `workspace/` is never merged with the persona.
- **Each bot carries its own MCP servers, written engine-natively.** The wizard's optional MCP step
  collects one engine-neutral list; the integration writes it where that engine keeps servers —
  pi's `mcpServers` in `<bot>/config/mcp.json` (its `PI_CODING_AGENT_DIR`), OpenCode's `mcp` block
  in `<bot>/config/opencode/opencode.json` — and reads it back from the same file, so the form shows
  what the engine really holds and the bot inherits nothing from the user's global config. No
  `pi`/`opencode` CLI runs for this. A malformed entry is skipped on read — and one that declares a
  transport without its command/url is dropped on the next save — while a pi entry that only
  overrides a user-level server is preserved.
- **Round state lives host-side, shared across connections** (the `SessionRegistry` pattern, not
  the per-connection controller): a browser reload or second tab observes the round instead of
  losing or forking it. MVP assumes one active client; the broadcast path is the transcript/routing
  events below.
- **A turn's reply is the final assistant message before `run-end`.** Intermediate prose between
  tool calls is not relayed. Interaction requests (confirm/select) are auto-answered with the
  engine default and recorded as transcript notes — no human approval in MVP; the policy is a
  single bot-level setting in `engine.json` so a stricter mode can land later without protocol
  changes.
- **The wizard asks each engine what it supports.** Integrations export a small capability
  descriptor (supports subagents, thinking levels, credential style, catalog probe) so neither the
  system layer nor the UI branches on engine kind.
- **Wizard order: identity → engine → credentials → model → thinking → persona → MCP servers →
  AGENTS.md → (OpenCode) subagents.** Credentials come before the model step because the catalog is
  probed *with the bot's own env/config*, so the bot's credential story must exist before it can list
  models.

### Routing rules

- Mentions parse against member bot names (`@forge`), plus `@all` / `@everyone`.
- Ordered resolution per user message: explicit mentions in mention order; `@all` = every member in
  member order; nothing addressed → lead (if crowned) with a routing brief; else no bot speaks.
- Sequential answering within a round: each target answers before the next is prompted, and every
  earlier answer in the round is relayed to the next target's session first.
- Bot→bot mentions relay automatically; hops count against the per-message chain cap (default 8,
  per-group). A relay dropped by the cap is recorded in the transcript as a capped note, not
  silently lost.
- The user can stop an in-flight round; stopping aborts the in-flight bot's turn, drops queued relays,
  and records a `system` note — a stalled turn is settled by the stop itself, so the conversation is
  never left locked. (Any partial reply the engine managed to emit before the abort is discarded by
  design in the MVP: nothing of it reached the transcript.)

### Isolation mechanics (per engine, implemented in the integration packages)

- **pi**: spawn with `PI_CODING_AGENT_DIR=<bot>/config`, `--session-dir <bot>/sessions`, cwd
  `<bot>/workspace`; model/thinking written engine-natively into the bot's config at wizard time.
- **OpenCode**: spawn the bot's own server with `XDG_CONFIG_HOME`/`XDG_DATA_HOME` (or the
  equivalent explicit config env) pointing into the bot's dirs, cwd `<bot>/workspace`; `opencode.json`
  in the bot's config carries model, thinking and any wizard-defined subagents.

### Host/UI wiring

- System layer gains a bot registry + conversation store + router (engine-agnostic; engines
  reached through the same factory ports code mode uses).
- Protocol gains bot-mode messages: roster, conversations, transcript events (author = user|bot),
  routing state (who is being asked), chain-cap notices.
- UI: toolbar Bot mode → roster sidebar (bots, groups, New bot / New group) → conversation view
  reusing the composer and transcript components with the pickers removed and attribution added;
  group dialog picks members and optional lead; New discussion and Stop controls on every
  conversation; presence = "engine warm" indicator (best effort).

## What's left to the builder

- Exact package seams for the registry/router module within the engine-agnostic rule, and the
  protocol DTO shapes (roster, conversations, transcript events with author attribution, routing
  state, chain-cap notices).
- `engine.json`'s exact schema and validation; avatar storage (file in the bot dir vs embedded).
- Per-engine persona mechanisms in the integration packages, and the isolated OpenCode config-dir
  plumbing end to end.
- Idle timeout values; the OpenCode bot server is one per bot (default assumption).
- Prompt/brief wording for lead routing and relay headers.
- Deleting a bot removes its directory (confirm-first); groups it joined show the member gap in
  the roster UI.
- Per-engine credential writer details: which providers the MVP covers (start with the providers
  each engine's own auth supports out of the box), and each engine's auto-answer mechanics for
  interaction requests (pi's RPC answer/select paths; OpenCode's permission responses).
