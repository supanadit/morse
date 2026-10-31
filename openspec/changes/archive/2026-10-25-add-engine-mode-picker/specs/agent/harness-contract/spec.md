# Spec Delta

## MODIFIED Requirements

### Requirement: A session is driven through one uniform port

Every harness SHALL implement the same session port, covering prompting with a mode, aborting, history paging, forking, model and thinking-level selection, compaction, and interaction replies — including a reply that answers more than one question at once for an interaction that asked for one. When the harness offers named modes, the port SHALL also cover selecting one.

#### Scenario: The same prompt reaches different harnesses the same way

- **WHEN** the application sends a prompt with a mode to a session of any harness
- **THEN** the harness receives the text, the mode and any attachments
- **AND** it answers with the disposition of that prompt

#### Scenario: An optional capability is absent rather than faked

- **WHEN** a harness cannot re-read its command catalog
- **THEN** the session omits the corresponding operation instead of answering with a stale value
- **AND** callers that check for the operation fall back to the last reported state

#### Scenario: A reply carries a structured answer when the question needed one

- **WHEN** a harness asks an interaction that one single value cannot answer
- **THEN** the port is able to carry the answer as a keyed set of values
- **AND** a harness that never asks such a question is unaffected by the added shape

## ADDED Requirements

### Requirement: A harness can name the modes it offers

A harness that distinguishes named ways of working SHALL report the modes it offers, the mode it treats as its default when it has one, and the one the session is in. It SHALL accept a mode when a session is created and be able to move a running session to another offered mode. A harness without that distinction SHALL report no modes and omit switching rather than inventing one.

#### Scenario: A session reports its mode and the modes available

- **WHEN** a session of a harness that offers modes is opened
- **THEN** its state names the current mode
- **AND** it lists the modes the harness offers, in the harness's own order
- **AND** it marks the harness's default mode when the harness names one

#### Scenario: A new session starts in the chosen mode

- **WHEN** a session is created naming one of the offered modes
- **THEN** the harness applies that mode before the first prompt
- **AND** the session reports it as the current mode

#### Scenario: A running session changes mode

- **WHEN** a session is asked to switch to another offered mode
- **THEN** the session reports that mode from then on
- **AND** its prompt, model and thinking-level behaviour follows the new mode
- **AND** the conversation and its history are untouched

#### Scenario: A harness without modes is unaffected

- **WHEN** a session belongs to a harness that has no named modes
- **THEN** its state carries no mode and no mode list
- **AND** the application offers no mode choice for that session
- **AND** prompting it works exactly as before

#### Scenario: A mode the harness does not offer is refused

- **WHEN** a session is asked for a mode it does not list
- **THEN** the request is refused with a reason
- **AND** the session stays in the mode it was in
