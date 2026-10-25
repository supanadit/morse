# Proposal

## Why

Morse can now run pi or OpenCode, but the engine is fixed by host configuration, so a user with
both installed cannot choose which one a new conversation starts in. OpenCode also exposes
primary agents — `build`, `plan`, and any the user defines — and Morse offers no way to see or
choose them, even though OpenCode's own interface treats switching them as a core part of working
(the Tab key). The set and the default are the user's OpenCode configuration, not a list Morse
should own.

## What Changes

- The empty session composer offers an engine picker when more than one engine is installed.
  Choosing an engine re-reads that engine's model/mode catalogs before the first prompt, and the
  session is created in the chosen engine.
- An OpenCode session offers a mode picker listing OpenCode's primary, non-hidden agents. The
  default is whatever OpenCode resolves from the user's configuration (`default_agent`, otherwise
  OpenCode's own ordering), never a mode Morse hardcodes. The choice is applied when the session
  is created and can be changed while the conversation runs.
- Modes come from OpenCode's own configuration (`opencode.json`, `.opencode/agent/*.md`, or the
  `agents` block); Morse lists them and adds no mode editor of its own. Re-reading the agent
  catalog, and creating a new session, reflect the current configuration without restarting Morse.
  Adding, renaming or removing a primary agent changes the picker.
- The host reports the engines it can start, with labels, so a frontend never hardcodes `pi` or
  `opencode`.
- A fresh OpenCode draft reports OpenCode's default model instead of "no model".
- pi keeps working unchanged: it exposes no modes, and its picker is absent rather than empty.
- **No breaking changes**: every new wire field is optional, and the new client messages are
  additive.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `agent/harness-contract`: a harness can name the modes it offers, report the current one, and
  accept a mode when a session is created or switched; a harness without modes omits both.
- `agent/opencode-engine`: OpenCode's primary, non-hidden agents are its modes; the default comes
  from its `default_agent`/ordering, creation and live switching use OpenCode's own `agent` field,
  and the draft reports its default model.
- `system/engine-routing`: the host reports the engines it can start, and a new session starts in
  the engine the draft selected, with that engine's catalogs behind the draft pickers.

## Impact

- `@morse/agent`: mode vocabulary, optional state fields, optional gateway operations, and a mode
  on session creation.
- `@morse/protocol`: engine catalog on host capabilities; draft/engine/mode fields on session
  state; `engine/set`, `mode/set` and `modes/refresh` client messages.
- `@morse/system`: engine-labelled router registrations, engine-aware probe and create, engine
  keyed draft cache, and draft engine/mode handling in the shared host controller.
- `@morse/integration-opencode`: primary-agent catalog mapping, config-driven default resolution,
  create-with-agent, live mode switching, mode refresh, and default-model discovery.
- `@morse/integration-pi`: compiles unchanged; it exposes no modes.
- `@morse/ui-runtime` and `@morse/ui-angular`: new actions, picker component and composer pills.
- Both hosts (NestJS server and VS Code extension) advertise their installed engines.
- Docs and tests for the contract, routing, adapter and composer.
