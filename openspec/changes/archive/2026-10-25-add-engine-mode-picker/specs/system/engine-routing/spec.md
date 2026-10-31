# Spec Delta

## ADDED Requirements

### Requirement: The host reports the engines it can start

The host SHALL report every agent engine it can start, each with a stable kind, a display label and whether it is the default for new sessions. An engine that could not be initialized SHALL be left out rather than offered and then fail.

#### Scenario: Every usable engine is reported

- **WHEN** a host has both pi and OpenCode available
- **THEN** it reports both with distinct kinds and labels
- **AND** exactly one is marked as the default

#### Scenario: The configured default is marked

- **WHEN** the host is configured to start new sessions in OpenCode
- **THEN** OpenCode is the one marked as the default
- **AND** pi remains available as a choice

#### Scenario: An engine that cannot start is not offered

- **WHEN** an engine fails to initialize during host startup
- **THEN** it is absent from the reported list
- **AND** the engines that did initialize remain usable

#### Scenario: One engine needs no choice

- **WHEN** only one engine is reported
- **THEN** new sessions start in it
- **AND** the frontend has nothing to choose between

### Requirement: A new session starts in the engine chosen for an empty session

The empty session SHALL be able to name the engine a new session starts in, and SHALL show that engine's model and mode catalogs before the first prompt. A resumed session SHALL ignore the empty-session choice and stay with the engine its record names.

#### Scenario: The chosen engine creates the session

- **WHEN** the user picks an engine in the empty session and sends the first prompt
- **THEN** the new session is created in that engine
- **AND** its record names that engine
- **AND** the session reports that engine's catalogs

#### Scenario: Switching engines refreshes the draft catalogs

- **WHEN** the user switches the empty session to another engine
- **THEN** the model and mode lists are re-read for that engine
- **AND** a model or mode that belonged to the previous engine is not carried over
- **AND** a slow answer for the previous choice cannot replace the new one

#### Scenario: An engine that is not installed is refused

- **WHEN** the empty session names an engine the host does not report
- **THEN** the choice is refused with a reason
- **AND** the draft keeps the engine it had

#### Scenario: Resuming keeps the owning engine

- **WHEN** the user opens a persisted session after choosing another engine in a draft
- **THEN** the session is opened in the engine its record names
- **AND** the draft choice only affects the next new session
