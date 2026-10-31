# agent/opencode-mcp Specification

## Purpose
Defines how Morse manages OpenCode's MCP servers from its MCP panel: reading their configured
state from OpenCode's `opencode.json`, and adding, removing, enabling and disabling them at global
or project scope, so OpenCode users get the same server administration pi users already have.

## Requirements

### Requirement: Morse reports OpenCode's configured MCP servers

Morse SHALL report every MCP server in OpenCode's config — global `~/.config/opencode/opencode.json`
and the workspace's `opencode.json` — with its name, scope, source file, transport (`local` command
or `remote` url), and enabled state. Because OpenCode exposes no live MCP status, configured state
SHALL be the whole report: no server claims a connected state or tool list it cannot have.

#### Scenario: Servers from both files are listed

- **WHEN** the MCP status of an OpenCode workspace is read
- **THEN** every entry of both the global and the project config's `mcp` key appears exactly once,
  with the project entry winning over a same-named global entry
- **AND** each entry names the file it comes from

#### Scenario: Status stays honest about what OpenCode does not report

- **WHEN** a configured OpenCode MCP server is reported
- **THEN** its state reflects only the configured `enabled` flag
- **AND** no connected state, tool names, or per-tool exposure is invented for it

#### Scenario: A malformed config is an error, not a silent empty list

- **WHEN** an `opencode.json` that defines `mcp` cannot be parsed, or its `mcp` key is not an object
- **THEN** the failure is reported with the file path and reason
- **AND** servers from the other scope are still reported

### Requirement: Morse can add, remove, enable and disable OpenCode MCP servers

Morse SHALL add a server (local: command array with optional env and cwd; remote: url with optional
headers), remove one, and toggle its `enabled` flag, writing to the global or the workspace
`opencode.json` as the caller scopes the edit. Every write SHALL preserve the rest of
`opencode.json` — agents, providers, and models live in the same file — and SHALL preserve unknown
fields on existing server entries.

#### Scenario: A local server is added at global scope

- **WHEN** a server with a command array is added without naming a project scope
- **THEN** it is written to the global config's `mcp` key with type `local`
- **AND** the rest of the global config is unchanged

#### Scenario: A remote server is added to the project config

- **WHEN** a server with a url is added at project scope
- **THEN** it is written to the workspace's `opencode.json` with type `remote`
- **AND** other keys of that file are unchanged

#### Scenario: Disabling keeps the entry

- **WHEN** a configured server is disabled
- **THEN** its entry stays in place with `enabled: false`
- **AND** enabling it again restores `enabled: true`

#### Scenario: Refusals name the reason

- **WHEN** an edit is invalid — a duplicate name, an empty name, a local server without a command,
  or a remote server without a url
- **THEN** the edit is refused with a message naming the reason
- **AND** no file is written

#### Scenario: OpenCode has no project trust gate

- **WHEN** the panel asks Morse to trust an OpenCode workspace
- **THEN** the request succeeds without writing a trust file, because OpenCode reads project
  configs without one

### Requirement: The MCP modal shows exactly the selected engine's servers

Morse's MCP commands SHALL name the engine they address, and the host SHALL resolve them against
that engine's administration — not a host-wide default. Switching the engine a session or draft
uses SHALL switch the modal's servers immediately, so a pi session never lists OpenCode's servers
and an OpenCode session never lists pi's.

#### Scenario: Each engine sees only its own servers

- **WHEN** the MCP status of a pi session and of an OpenCode session in the same workspace are read
- **THEN** the pi modal lists only servers from pi's `mcp.json` files
- **AND** the OpenCode modal lists only servers from `opencode.json`

#### Scenario: Switching the draft's engine updates the modal

- **WHEN** the engine of an empty (draft) session is switched from pi to OpenCode or back
- **THEN** the modal re-reads status for the newly selected engine
- **AND** a mutation always lands in the config of the engine the modal is showing

#### Scenario: An engine without MCP administration hides the panel

- **WHEN** the selected engine supplies no MCP administration
- **THEN** the modal's affordance is hidden for that engine alone
- **AND** it stays available for sessions of an engine that has one

### Requirement: MCP edits affect new sessions, and the panel says so

Because both engines read their MCP config when a session starts, an edit SHALL reach new sessions
of that engine, and the panel SHALL state that already-running sessions keep their servers until
reopened, so a warm session not picking up an edit is not mistaken for a failure.

#### Scenario: A running session keeps its servers across an edit

- **WHEN** a server is added or disabled while a session of that engine is open
- **THEN** the running session is unchanged
- **AND** the panel's note says new sessions pick the change up
