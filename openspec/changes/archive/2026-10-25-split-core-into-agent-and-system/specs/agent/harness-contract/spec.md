# Spec Delta

## Purpose

Defines what a coding-agent harness must expose so that any harness — pi today, OpenCode or
another tomorrow — can drive a Morse session without the layers above knowing which one it is.
The vocabulary here is the contract at the boundary; it carries no application logic.

## ADDED Requirements

### Requirement: The contract depends on no application logic

The harness contract SHALL be importable without pulling in any of Morse's application concerns:
no session index, no session record, no use case, no logger port.

#### Scenario: A harness adapter depends only on the contract

- **WHEN** an adapter declares a dependency on the harness contract package
- **THEN** its dependency list contains that package and no Morse application package
- **AND** it can implement a session without importing a session record or a store

#### Scenario: The contract names no application symbol

- **WHEN** the contract package's public exports are inspected
- **THEN** none of them is a session record, a session store, a reconcile policy, a registry or a
  use case

### Requirement: A session reports its state and streams events

A running session SHALL expose its current observable state and SHALL deliver every subsequent
change as an event to each subscriber until that subscriber unsubscribes.

#### Scenario: State is readable before any event

- **WHEN** a session has been created but has not yet started working
- **THEN** reading its state returns the state it was created with, not an error

#### Scenario: Every subscriber receives every event

- **WHEN** two subscribers are attached and the session emits one event
- **THEN** both subscribers receive it

#### Scenario: A failing subscriber does not stop the session

- **WHEN** one subscriber's handler throws while an event is delivered
- **THEN** the failure is reported to the session's logger
- **AND** the remaining subscribers still receive that event
- **AND** the session keeps streaming later events

#### Scenario: State handed to a caller cannot corrupt the session

- **WHEN** a caller reads the session state and mutates a collection it contains
- **THEN** the session's own state is unchanged
- **AND** the next read returns the unmutated values

### Requirement: A session is driven through one uniform port

Every harness SHALL implement the same session port, covering prompting with a mode, aborting,
history paging, forking, model and thinking-level selection, compaction, and interaction replies.

#### Scenario: The same prompt reaches different harnesses the same way

- **WHEN** the application sends a prompt with a mode to a session of any harness
- **THEN** the harness receives the text, the mode and any attachments
- **AND** it answers with the disposition of that prompt

#### Scenario: An optional capability is absent rather than faked

- **WHEN** a harness cannot re-read its command catalog
- **THEN** the session omits the corresponding operation instead of answering with a stale value
- **AND** callers that check for the operation fall back to the last reported state

### Requirement: A harness can be discovered and instantiated without naming it

The application SHALL create sessions and reach a harness's catalog through a factory port, so
that adding a harness is adding an implementation rather than editing a caller.

#### Scenario: Sessions are created through the factory

- **WHEN** the application opens a new or resumed session for a workspace
- **THEN** it asks the factory, passing the workspace and optionally a persisted session
- **AND** it receives a session without knowing which harness produced it

#### Scenario: A harness without a session-less probe still works

- **WHEN** a harness cannot produce a session that records nothing
- **THEN** the factory omits that capability
- **AND** the application presents its empty state without a catalog rather than failing

### Requirement: A harness can report the sessions it already holds, in its own terms

A harness SHALL be able to report the sessions present in its own storage, each with an opaque
token that changes only when that session changed, and SHALL be able to decline to report at all.
The report SHALL describe the harness's sessions, not Morse's records.

#### Scenario: An unchanged session is reported without being re-read

- **WHEN** a harness reports a session whose token equals the one last seen
- **THEN** a caller can skip reading that session's content

#### Scenario: Declining is distinguishable from holding nothing

- **WHEN** a harness does not implement the reporting operation
- **THEN** a caller can tell "this harness cannot report" from "this harness holds no sessions"

#### Scenario: The report carries the harness's own identifiers

- **WHEN** a harness reports a session
- **THEN** it names the session by the id its own storage uses
- **AND** it does not compute, guess or reuse an identifier owned by the application

#### Scenario: A report needs no application type to be described

- **WHEN** the shape a harness reports is inspected
- **THEN** it references only harness vocabulary — no session record, no store, no index
- **AND** a test can build one as a plain literal

### Requirement: The contract declares only what the contract owns

The harness contract SHALL NOT declare a member whose type belongs to the application — no session
catalog, no session store, no session record. A member the application needs is declared on an
application-side composite instead.

#### Scenario: An engine declares no application-owned port

- **WHEN** the harness contract's engine type is inspected
- **THEN** it declares the harness kind, the factory that creates sessions, and the optional
  session report
- **AND** it declares no catalog, store or record

#### Scenario: A host still reaches what it needs

- **WHEN** a host wires a session registry
- **THEN** it obtains the session factory and the session catalog from the adapter it constructed
- **AND** the composite it holds exposes the engine alongside them

#### Scenario: An application import is rejected by a check, not by an empty dependency list

- **WHEN** a file under the contract's source names `@morse/system`, an adapter or host package, a
  `node:` built-in, or a host framework
- **THEN** the project's boundary check fails and names the file and the specifier
- **AND** it fails on a type-only import too, not only a value import

#### Scenario: Prose that names a forbidden package is not an import

- **WHEN** a comment or doc block mentions a forbidden package without importing it
- **THEN** the boundary check passes

#### Scenario: The contract declares no dependency of its own

- **WHEN** the contract package's manifest is read
- **THEN** its dependency list is empty
- **AND** that list is treated as a statement of intent, since a workspace install would resolve a
  hoisted package regardless

### Requirement: The contract's shape vocabulary is transport-neutral

The event, state and history shapes SHALL describe the agent's behavior only, with no field that
exists for the benefit of a particular transport, storage format or user interface.

#### Scenario: History is expressible without a storage format

- **WHEN** a harness reports a past conversation
- **THEN** it describes messages, tool calls and compaction boundaries in terms the application
  can render, without exposing its own file format or identifiers

#### Scenario: A harness-specific field is optional and inert

- **WHEN** a shape carries a piece of information only one harness can supply
- **THEN** the field is optional
- **AND** a consumer that does not understand it can ignore it without misrendering the rest
