# Spec Delta

## MODIFIED Requirements

### Requirement: A session is driven through one uniform port

Every harness SHALL implement the same session port, covering prompting with a mode, aborting,
history paging, forking, model and thinking-level selection, compaction, and interaction replies
— including a reply that answers more than one question at once for an interaction that asked
for one.

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
