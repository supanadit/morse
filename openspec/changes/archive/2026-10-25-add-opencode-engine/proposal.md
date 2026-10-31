# Proposal

## Why

Morse's agent-agnostic refactor left every layer engine-free except one: the only harness Morse
can drive is still pi. OpenCode is a different shape (a long-lived HTTP server with one event
stream instead of one subprocess per session), and the existing `Session`/`SessionEngine`
foundation makes it addable without touching the session use cases — but nothing in Morse can
address, list or reopen a session across two engines yet, so an OpenCode adapter alone would be
a dead end: sessions would have no stable Morse-owned id and the sidebar could not serve
sessions from more than one harness.

## What Changes

- **BREAKING**: session ids stop being the engine's own id. Every session is keyed, listed and
  resumed by a Morse-derived id (`deriveSessionId(engine, engineSessionId)`). Persisted host
  state that stored an engine id (VS Code's open tabs) is reset once for existing sessions.
- New `@morse/integration-opencode` package: a full `SessionEngine` for OpenCode's HTTP API —
  attach to `MORSE_OPENCODE_URL` or spawn a private `opencode serve`, one SSE stream shared by
  every session, event and message projection into `AgentEvent`/`AgentHistoryEntry`.
- An engine router in `@morse/system`: resolves a Morse id to the engine that owns it, wraps
  every gateway so the session's id stays Morse's, and serves the sidebar catalog from Morse's
  own index rather than from a single engine's files.
- A file-backed `SessionStore`, so the sidebar survives an engine's storage going away and two
  hosts derive the same row.
- Multi-field agent forms: a new `form` interaction kind through the harness contract, the wire
  protocol and the Angular interaction panel, so OpenCode's forms round-trip (permissions stay
  a `select` with once/always/reject).
- Optional per-engine capability ports (`extras`): MCP administration, prompt templates,
  version and CLI become ports the hosts read from the composite instead of concrete pi
  dependencies. OpenCode reports none of these for now.
- Both hosts select engines by config (`MORSE_ENGINE(S)` / `morse.engine`); the OpenCode
  engine registers itself when the binary is on PATH or a URL is configured.

Out of scope: custom compaction instructions, pins as prompt context, an OpenCode agent picker,
an MCP editor for OpenCode, a prompt-template editor for OpenCode, auto-restarting a crashed
owned server.

## Capabilities

### New Capabilities

- `agent/opencode-engine`: what Morse does when OpenCode is the harness — server ownership and
  auth, session creation and resume, event streaming, history and message projection, model and
  thinking-level selection via variants, fork/compact semantics, tool approval, and the
  engine-specific contract gaps it must degrade gracefully on.
- `system/engine-routing`: Morse ids as the routing key; resolving a persisted session to the
  engine that owns it; the sidebar catalog served from Morse's index; re-keying on fork;
  reconciling every installed engine.
- `system/interaction-forms`: an agent asking the user a question with several fields, from the
  harness contract through the wire protocol to a rendered, validated, conditionally-visible
  form — including hosts that would otherwise answer interactions natively.

### Modified Capabilities

- `agent/harness-contract`: interaction requests gain the `form` kind and answers gain a
  structured `values` map; the shapes stay transport-neutral so any harness can express a form.
  (The engine contract itself — factory, port, report — is unchanged.)

## Impact

- `packages/integration-opencode/**` (new), `@morse/system` (router, file store, extras ports,
  registry changes), `@morse/agent` (form interaction shapes), `@morse/protocol`
  (interaction DTOs), `@morse/ui-angular` (interaction panel).
- Hosts (`@morse/server`, the VS Code extension) re-wire composition roots, replace the
  pi-typed token, gate MCP/prompt capabilities off `extras`, and add engine selection config.
- Every session the sidebar lists changes id once; the transcript and registry keys follow it,
  and engine storage is untouched, so no conversation is lost or re-read.
- Events and message shapes are taken from OpenCode's installed v2 HTTP API, deliberately not
  from the pre-release generated SDK (its types already disagree with the installed server).
