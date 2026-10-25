# system/session-index Specification

## Purpose
Defines Morse's ownership of a session: the record it keeps, the identity it derives, and the
reconcile policy that merges a harness's own storage into Morse's index so a session started
outside Morse still appears in the sidebar.

## Requirements

### Requirement: A session record is owned by Morse and carries no transcript

Morse SHALL persist one record per session holding the metadata the sidebar, the tabs and a
resume need, and SHALL NOT store the conversation itself.

#### Scenario: A record holds only metadata

- **WHEN** a session record is written
- **THEN** it holds an id, a title, a working directory, the harness reference, timestamps and a
  message count
- **AND** it holds no conversation content

#### Scenario: The harness keeps the conversation

- **WHEN** a session is resumed
- **THEN** the record supplies what is needed to reach the conversation
- **AND** the conversation itself is read from the harness that recorded it

#### Scenario: Losing the harness's storage loses the conversation, not the row

- **WHEN** a harness's own session storage is deleted while Morse's index survives
- **THEN** the session row is still listed with its title and project
- **AND** reopening it fails with a reported reason instead of silently showing an empty panel

### Requirement: A session's id is derived from the harness's own identifier, and only Morse derives it

Morse SHALL derive a session's id from the harness kind and the harness's own session id, so that
two hosts that discover the same session produce the same id. The derivation SHALL be the only
place that knows the id scheme.

#### Scenario: The same harness session yields the same id on both hosts

- **WHEN** the VS Code host and the browser host each discover the same harness session
- **THEN** both derive the same id
- **AND** the session is listed once, not twice

#### Scenario: Different harnesses do not collide

- **WHEN** two harnesses report the same session id
- **THEN** the derived ids differ

#### Scenario: The derived id is usable as a file name

- **WHEN** a harness's session id contains characters a filesystem rejects
- **THEN** the derived id contains only characters safe for a path segment

#### Scenario: A harness never computes the id

- **WHEN** a harness reports a session for the index
- **THEN** it supplies only its own session id
- **AND** the application, not the harness, derives the id and the parent link from it

### Requirement: The index is written through a port, not a file format

Morse SHALL read and write session records through a store port, so a host supplies the storage
and no use case learns the layout.

#### Scenario: A store can be replaced without touching a use case

- **WHEN** a host supplies its own store implementation
- **THEN** listing, reading, writing and removing records work through it
- **AND** no use case imports a storage path or a file format

#### Scenario: A store that cannot delete says so rather than pretending

- **WHEN** a store does not implement removal
- **THEN** a delete request reports that it is unsupported
- **AND** the session is not removed from the listing

### Requirement: Morse translates a harness's report into its own record

Morse SHALL turn what a harness reports about its sessions into its own session records, owning
the id, the parent link, the title fallback and the record version.

#### Scenario: A report becomes a record

- **WHEN** the application receives a harness's session report for a workspace
- **THEN** it produces a session record whose id is derived from the harness kind and the reported
  session id
- **AND** whose parent link, when the harness reports one, is derived the same way

#### Scenario: A missing title does not produce an empty row

- **WHEN** a harness reports a session without a title
- **THEN** the record carries the shared untitled placeholder
- **AND** the row is still listed

#### Scenario: A missing creation time falls back to the last update

- **WHEN** a harness reports a session with no creation time
- **THEN** the record's creation time equals its last update time

#### Scenario: The translation is testable without a harness

- **WHEN** the translation is exercised in a test
- **THEN** it accepts a plain description of a harness session
- **AND** produces a record without instantiating an adapter or touching storage

### Requirement: Reconciling merges a harness's storage without destroying what it did not read

Merging a harness's reported sessions into the index SHALL update what changed, add what is new,
and remove only what that same harness no longer holds.

#### Scenario: An unchanged session is not rewritten

- **WHEN** a harness reports a session whose token matches the stored one
- **THEN** the record is left untouched

#### Scenario: A changed session replaces its record

- **WHEN** a harness reports a session with a new token
- **THEN** the stored record is replaced with the record translated from that report

#### Scenario: A session the harness no longer holds is removed

- **WHEN** a stored record belongs to the harness being reconciled and that harness does not
  report it
- **THEN** the record is removed from the index

#### Scenario: Another harness's records are never touched

- **WHEN** one harness is reconciled
- **THEN** records belonging to any other harness are left exactly as they were

#### Scenario: A partial read is never treated as a complete one

- **WHEN** a harness can only report a page of what it holds
- **THEN** reconciling with that page SHALL NOT remove the sessions outside it
- **AND** a caller that cannot obtain a complete report must not reconcile against a partial one

### Requirement: Reconciling a harness that cannot report changes nothing

A harness that does not report its sessions SHALL leave the index untouched, and that outcome
SHALL be distinguishable from reconciling a harness that reported nothing.

#### Scenario: A non-reporting harness is skipped

- **WHEN** reconcile runs for a harness that does not implement reporting
- **THEN** no record is written and no record is removed
- **AND** the result reports that nothing was reconciled

#### Scenario: An empty report is not the same as no report

- **WHEN** a harness reports that it holds no sessions
- **THEN** every record of that harness is removed from the index
- **AND** this is distinguishable from the non-reporting case above

### Requirement: A long reconcile reports progress

Merging a large catalog SHALL be able to report how many records it has processed, so a host can
show the work instead of appearing frozen.

#### Scenario: Progress is reported per record

- **WHEN** reconcile writes or removes a record and a progress callback was supplied
- **THEN** the callback is called with the number processed so far and the total

#### Scenario: Progress is optional

- **WHEN** no progress callback was supplied
- **THEN** reconcile completes with the same result and reports nothing
