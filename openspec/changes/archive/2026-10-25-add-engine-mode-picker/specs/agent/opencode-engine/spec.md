# Spec Delta

## ADDED Requirements

### Requirement: OpenCode's primary agents are its modes

OpenCode's primary agents SHALL be the modes Morse offers, with hidden and subagent-only agents left out. The default SHALL be the agent OpenCode resolves from the user's configuration — its `default_agent`, otherwise the primary agent OpenCode orders first — never an id Morse fixes.

#### Scenario: Only selectable agents are offered

- **WHEN** OpenCode lists primary, hidden and subagent agents
- **THEN** the session reports the primary, non-hidden agents as its modes
- **AND** hidden and subagent-only agents are not selectable

#### Scenario: The configured default is the default

- **WHEN** the user's OpenCode configuration names `default_agent` among the offered agents
- **THEN** that agent is reported as the default and as the current mode before one is chosen
- **AND** Morse does not substitute a built-in default of its own

#### Scenario: OpenCode's ordering is the fallback

- **WHEN** no `default_agent` is configured
- **THEN** the primary agent OpenCode reports first is the default
- **AND** a configured default is not assumed from a hardcoded agent id

#### Scenario: A user-defined primary agent appears

- **WHEN** the user adds a primary agent to the OpenCode configuration
- **THEN** it appears in the offered modes
- **AND** selecting it behaves like selecting a built-in mode

#### Scenario: Configuration changes are reflected

- **WHEN** a primary agent is added, renamed, removed or disabled in the OpenCode configuration
- **THEN** re-reading the agent catalog reflects the change
- **AND** a removed agent is no longer offered
- **AND** the picker can be re-read without restarting Morse

### Requirement: A session starts and runs in the chosen OpenCode agent

Creating a session SHALL send the chosen agent to OpenCode, and SHALL omit the field when the user made no choice so OpenCode applies its own default. Changing the mode of a running session SHALL change the agent OpenCode uses without disturbing the conversation, and a change made by another OpenCode client SHALL be reported rather than overwritten.

#### Scenario: Creation applies the chosen agent

- **WHEN** Morse creates a session naming a selected agent
- **THEN** OpenCode records that agent on the session
- **AND** the first prompt runs under it

#### Scenario: Creation without a choice uses OpenCode's default

- **WHEN** Morse creates a session without naming an agent
- **THEN** OpenCode applies the agent its configuration resolves as the default
- **AND** the session reports that agent once the server reports it

#### Scenario: A running session changes agent

- **WHEN** Morse switches a running session to another offered agent
- **THEN** OpenCode applies that agent to the session
- **AND** the session reports it, with its history and model unchanged

#### Scenario: Another client's change is observed

- **WHEN** another OpenCode client changes the session's agent
- **THEN** the next state refresh reports that agent
- **AND** Morse does not force the previous one back

#### Scenario: An agent OpenCode does not offer is refused

- **WHEN** Morse asks for an agent the server does not offer
- **THEN** the failure is reported
- **AND** the session keeps the agent it had

### Requirement: A fresh OpenCode draft reports the model a new session would use

Before any session exists, the draft state SHALL report OpenCode's default model and thinking levels for the workspace, so the composer shows a usable model rather than "no model".

#### Scenario: The default model fills the draft pickers

- **WHEN** the empty composer is shown for an OpenCode engine
- **THEN** the draft reports OpenCode's default model for that workspace
- **AND** the thinking levels shown are that model's variants

#### Scenario: An unavailable default does not break the draft

- **WHEN** OpenCode cannot report a default model
- **THEN** the draft still lists the models it could read
- **AND** the composer remains usable instead of failing to open
