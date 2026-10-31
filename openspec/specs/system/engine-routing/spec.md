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
