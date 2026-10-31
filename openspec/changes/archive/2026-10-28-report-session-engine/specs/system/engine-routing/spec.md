# Spec Delta

## Purpose

Makes a session's view state name the engine that actually owns it, so a reader can tell an
OpenCode conversation from a pi one even when pi is the default engine for new sessions.

## ADDED Requirements

### Requirement: A running session reports the engine that owns it

A session's view state SHALL name the kind of the agent engine that owns it, matching the engine its
record carries. The reported kind SHALL NOT be inferred from the host's default engine and SHALL be
the same before and after a reload, a resume, or a fork. A host that cannot name the engine SHALL
omit the field rather than report a wrong one.

#### Scenario: OpenCode runs while pi is the default

- **WHEN** a session created in OpenCode is open while pi is the default engine for new sessions
- **THEN** its view state reports the OpenCode engine kind
- **AND** the composer's session facts name OpenCode rather than pi
- **AND** the engine session id and model provider remain those of the OpenCode session

#### Scenario: A resumed session reports its owning engine

- **WHEN** a persisted OpenCode session is reopened from the index
- **THEN** its view state reports the OpenCode engine kind
- **AND** the engine reported is the one its record names, not the draft's current choice

#### Scenario: A new non-default session is named correctly from the first report

- **WHEN** the reader picks OpenCode in an empty session and sends the first prompt
- **THEN** the new session's view state reports the OpenCode engine kind
- **AND** its record names OpenCode as its engine
- **AND** the derived session id is the one OpenCode's kind produces

#### Scenario: A draft still shows the engine it chose

- **WHEN** the empty composer has pi selected as its engine
- **THEN** the draft view reports pi, as before
- **AND** a running session in another engine keeps reporting its own engine

#### Scenario: Switching the draft does not relabel a running session

- **WHEN** the reader changes the draft's engine while an existing session is open
- **THEN** the open session's view state keeps reporting its owning engine
- **AND** the draft choice only affects the next new session

#### Scenario: A fork stays in the engine it forked from

- **WHEN** a running OpenCode session forks and continues under a new derived id
- **THEN** the continued session still reports the OpenCode engine kind

#### Scenario: An older host omits the engine

- **WHEN** a frontend talks to a host that does not report an engine for a running session
- **THEN** the frontend falls back to the default engine it was told about
- **AND** the composer renders the session facts without an error
