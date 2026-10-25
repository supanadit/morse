# system/engine-routing Specification

## Purpose
Defines how Morse addresses sessions with its own derived ids no matter which harness created
them: resolving a persisted session to the engine that owns it, keeping a session's id stable
through a fork, serving the sidebar from Morse's index, and reconciling every installed engine.

## Requirements

### Requirement: Morse routes a session by its own id

The id Morse uses for a session — its listing, its tabs and its resume — SHALL be the derived
one, and requesting a session by that id SHALL reach the engine whose storage holds it without
the caller naming an engine.

#### Scenario: A listed id reopens the same conversation

- **WHEN** Morse is asked to open a session by the id the listing showed
- **THEN** the session is attached to the engine session that record identifies
- **AND** events the session emits carry that same id

#### Scenario: An id no engine holds is a reported failure

- **WHEN** Morse is asked to open an id that is not in the index nor in any engine's report
- **THEN** the request fails with a reason, leaving other sessions untouched

#### Scenario: Colliding ids across engines cannot exist

- **WHEN** two engines report sessions with the same id
- **THEN** Morse's derived ids for them differ
- **AND** both remain independently openable

### Requirement: A session keeps its id while it runs, and forks get a new one

A running session SHALL keep its id for its whole lifetime, and a fork SHALL adopt the derived
id of the new engine session so the caller can re-key it.

#### Scenario: A fork is re-keyed, not duplicated

- **WHEN** a session forks before a past prompt and the engine reports a new session id
- **THEN** the session continues running under the fork's derived id
- **AND** the fork's record is written with the forked-from session as its parent

### Requirement: The sidebar lists sessions from the index, not from one engine

Listing, paging, searching and counting sessions SHALL read Morse's index, and deleting SHALL go
to the engine that owns the row and then to the index.

#### Scenario: Two engines' sessions are listed together

- **WHEN** two engines each hold sessions for the same project
- **THEN** one listing shows both, newest first, grouped by project
- **AND** neither engine's catalog has to know about the other

#### Scenario: Deleting a listed session removes it everywhere

- **WHEN** Morse deletes a listed session
- **THEN** the engine that owns it is asked to delete it
- **AND** the index stops listing it

### Requirement: The index stays current without blocking on a full scan

The index SHALL be refreshed when it is read, so sessions created or renamed outside the host
appear, and a refresh that cannot read an engine SHALL leave the index as it is rather than
erasing it.

#### Scenario: A rename outside Morse appears on the next read

- **WHEN** an engine renames or creates a session and the index is read afterwards
- **THEN** the listing reflects the change
- **AND** repeated reads that find nothing new cost no engine reads

#### Scenario: An unreadable engine cannot wipe its rows

- **WHEN** an engine's report cannot be obtained
- **THEN** the refresh serves the index unchanged
- **AND** it does not report the engine's sessions as deleted

### Requirement: Reconciling covers every installed engine

Reconciling the index SHALL run once per engine that can report, each scoped to its own kind,
and SHALL be able to state that an engine existed but could not report.

#### Scenario: Each engine is reconciled against its own records only

- **WHEN** the index is reconciled with two engines installed
- **THEN** each engine's report is merged without touching the other's rows
- **AND** one engine failing does not prevent the other from being merged
