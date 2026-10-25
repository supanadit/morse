# agent/opencode-engine Specification

## Purpose
Defines how Morse drives OpenCode (v2 HTTP API) as one coding-agent harness among possibly
several: how Morse obtains and shares its server, how it projects OpenCode's events, messages
and catalogs into the harness contract, and which OpenCode-specific gaps it has to degrade
gracefully on.

## Requirements

### Requirement: Morse can share an already running OpenCode server

Morse SHALL connect to an OpenCode server the user configured, authenticating as the server
asks, and SHALL refuse to connect with an actionable reason when the server is unreachable or
rejects the credentials.

#### Scenario: An attached server is verified on first use

- **WHEN** Morse resolves an engine with a configured server URL and password
- **THEN** it authenticates with those credentials and confirms the server answers
- **AND** Morse never terminates that server process

#### Scenario: Unreachable or unauthorized is a setup problem, not a bug

- **WHEN** the configured server rejects the credentials or cannot be reached
- **THEN** the failure is reported as a configuration problem naming what was tried
- **AND** no session is created against a server Morse could not reach

### Requirement: Morse can own a private OpenCode server

When no server is configured, Morse SHALL spawn a private one for the host, discover its
address and credentials from the process it started, and stop it when the engine is disposed.

#### Scenario: A spawned server announces its address and password

- **WHEN** Morse starts the engine without a configured server
- **THEN** it starts the server listening on the local loopback on a free port
- **AND** it reads the address and password the process announced from its output

#### Scenario: The owned server stops with the engine

- **WHEN** the engine that owns a spawned server is disposed
- **THEN** the server process is stopped
- **AND** a server the user started is never stopped by Morse

#### Scenario: A missing binary is a setup problem

- **WHEN** the engine cannot find the OpenCode binary and no server is configured
- **THEN** the failure names what Morse looked for without spawning anything visible

### Requirement: Sessions are created eagerly and resumed by id

Opening a session for a workspace SHALL create the engine's session immediately, so the session
has a stable id before its first prompt; resuming SHALL reattach to the engine session the
caller named rather than creating another one.

#### Scenario: A new session has an id before prompting

- **WHEN** Morse opens a session for a workspace without naming a persisted one
- **THEN** the engine creates its own session in that workspace
- **AND** the session reports that id in its state

#### Scenario: Resume attaches, not re-creates

- **WHEN** Morse opens a session naming a persisted engine session
- **THEN** the engine attaches to that session
- **AND** the conversation shown is the one the caller resumed

### Requirement: One running turn is observable as it streams

While a prompt is being answered, Morse SHALL see the turn start, streaming text and thinking,
each tool call with its progress and outcome, usage as it accumulates, compaction when it runs,
and the turn ending with the reason it ended.

#### Scenario: A streaming turn reaches every subscriber

- **WHEN** OpenCode streams text, thinking and tool activity for a session
- **THEN** the session reports each as it arrives, in order
- **AND** more than one subscriber sees the same fragments

#### Scenario: A finished tool call carries its result

- **WHEN** OpenCode reports a tool call succeeded or failed
- **THEN** the session reports its status, output and any structured result
- **AND** a pending tool call that produces none of those never blocks the transcript

#### Scenario: The turn ends when OpenCode says so

- **WHEN** the execution succeeds, fails or is interrupted
- **THEN** the session reports the turn ended with that reason
- **AND** a further event of an already-ended turn does not end it twice

### Requirement: Opening a session replays its finished exchanges

Resuming a session SHALL page its past messages newest first, in the same projection the live
stream produces, so a scrolled-back conversation is indistinguishable from a live one.

#### Scenario: A resumed session shows the end of its conversation first

- **WHEN** a session with a long history is opened
- **THEN** the caller receives the newest page first, older pages on demand
- **AND** user messages, assistant answers, tool calls and compaction boundaries are all present

#### Scenario: Non-transcript rows do not masquerade as content

- **WHEN** the engine's history holds bookkeeping rows that are not messages
- **THEN** they are not reported as transcript content
- **AND** paging continues past them instead of returning an empty page

### Requirement: Past prompts can be edited by forking

The engine SHALL list every user prompt the session holds, in order, and forking before one of
them SHALL carry the conversation into a new engine session that ends before that prompt.

#### Scenario: A past prompt is listed with its engine id

- **WHEN** the caller asks which prompts can be forked
- **THEN** each user prompt is listed by its engine message id, in conversation order
- **AND** a message with only attachments is listed like one with text

#### Scenario: Forking produces a new session the application can re-key

- **WHEN** the caller forks before a listed prompt
- **THEN** the session reports a new engine session id
- **AND** the caller receives the text the fork dropped

### Requirement: Thinking level is expressed through OpenCode's model variants

Model selection SHALL use OpenCode's model catalog, and thinking levels SHALL be the declared
variants of the selected model.

#### Scenario: A model with reasoning variants offers those levels

- **WHEN** the selected model declares reasoning effort variants
- **THEN** the session reports exactly comparable levels for those variants
- **AND** choosing a level sends that variant

#### Scenario: A model without variants is not offered levels

- **WHEN** a model declares no reasoning variants
- **THEN** no thinking level is offered for it
- **AND** a level carried over from another model does not pretend to apply

#### Scenario: A model set to no explicit variant is still renderable

- **WHEN** the engine session reports a sentinel variant meaning "provider default"
- **THEN** the session reports a valid level and does not fail or hide the picker

### Requirement: Tool approval is a choice the user makes

When OpenCode asks before running a tool, Morse SHALL present the choice once / always allow /
reject, and SHALL send exactly the decision the user made.

#### Scenario: The three answers are distinguishable

- **WHEN** OpenCode requests permission for a session
- **THEN** the request presented offers once, always and reject as distinct answers
- **AND** each answer is sent back to that request and to no other

### Requirement: An engine session can be listed and deleted from Morse

The engine SHALL report the sessions it holds — including ones created outside Morse — with
enough metadata to list them, and SHALL delete a session when Morse asks.

#### Scenario: Sessions created outside Morse are visible

- **WHEN** a session was created by another OpenCode client in the same storage
- **THEN** the report lists it by its id, title, directory and timestamps
- **AND** such sessions remain listed even after that client is gone

#### Scenario: A session is removed

- **WHEN** Morse deletes a listed session
- **THEN** the engine deletes it
- **AND** the next report no longer contains it

### Requirement: Engine-only capabilities are absent, not faked

A capability OpenCode does not offer SHALL be omitted rather than simulated, and a session SHALL
keep working without it.

#### Scenario: Compaction instructions are unavailable

- **WHEN** a caller compacts with custom instructions
- **THEN** the engine compacts without them and reports that the instructions were not sent

#### Scenario: An attachment the engine cannot carry is not silently dropped from the transcript

- **WHEN** a prompt carries an attachment kind OpenCode cannot represent
- **THEN** the prompt is sent without it
- **AND** the omission is reported as a warning rather than as if it were sent
