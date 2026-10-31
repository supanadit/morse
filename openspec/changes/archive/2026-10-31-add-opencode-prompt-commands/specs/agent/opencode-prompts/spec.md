# Spec Delta

## Purpose
Defines how Morse's prompt editor reads and edits OpenCode's command templates — markdown files in
`commands/` directories and entries in `opencode.json`'s `command` key — so OpenCode users manage
their `/commands` in Morse, engine-scoped like everything else in the panel.

## ADDED Requirements

### Requirement: Morse lists OpenCode's commands from both sources

Morse SHALL list every OpenCode command: each markdown file in the global
`~/.config/opencode/commands/` and the project `.opencode/commands/` directories, and each entry of
`opencode.json`'s `command` key. Each command SHALL carry its name, scope, source (`file` or
`config`), description, and template body. A file name without `.md` is the command name; a JSON
key is its name.

#### Scenario: File commands are listed with their fields

- **WHEN** the command list of an OpenCode workspace is read
- **THEN** every `commands/*.md` file from both scopes appears with its frontmatter description and
  body (frontmatter stripped), and the file path it comes from

#### Scenario: Config commands are listed next to file commands

- **WHEN** `opencode.json` defines entries under its `command` key
- **THEN** each entry is listed with its `template` as the body and labeled as source `config`
- **AND** its `description`, `agent`, `model`, and `subtask` fields, when present, are carried
  through

#### Scenario: A malformed file or config is reported, not hidden

- **WHEN** a command file has unparseable frontmatter, or `opencode.json`'s `command` key is not an
  object of objects with a string `template`
- **THEN** the broken item is still listed with the reason it would not load
- **AND** other commands remain listed

### Requirement: Morse edits OpenCode commands in place

Morse SHALL create, rename (move between scopes), and delete file commands, and SHALL save config
commands back into `opencode.json`'s `command` key — writing only the edited entry and preserving
the rest of the file, including other keys and unknown fields, exactly as its MCP editing does.
An agent/model/subtask field set on a config command SHALL survive edits.

#### Scenario: A new file command is written to the chosen scope

- **WHEN** a command is created at global or project scope
- **THEN** a markdown file with the command name and a frontmatter `description` is written to that
  scope's `commands/` directory

#### Scenario: Saving a config command touches only that entry

- **WHEN** a `config`-sourced command is edited
- **THEN** the same-named key of `opencode.json`'s `command` object is replaced
- **AND** sibling keys, other config keys, and unknown fields inside the entry survive

#### Scenario: A file command and a config command may share a name

- **WHEN** a file command and a `command`-key entry have the same name
- **THEN** both are listed, each under its own source, and editing one never writes the other

### Requirement: The editor stays engine-aware

The prompt commands SHALL name the engine they address and the host SHALL resolve them against that
engine's administration, so a pi session never lists OpenCode commands and an OpenCode session
never lists pi's templates. Editor affordances that only one engine has SHALL be shown only for
that engine: pi's `argument-hint` field and `${n:-default}` placeholder syntax for pi, OpenCode's
`$ARGUMENTS` and `$1`–`$9` placeholders for OpenCode.

#### Scenario: Each engine sees only its own templates

- **WHEN** the template list of a pi session and of an OpenCode session in the same workspace are
  read
- **THEN** pi lists only pi's prompt files and OpenCode lists only OpenCode commands
- **AND** an engine without prompt administration hides the editor for that engine alone

#### Scenario: pi-only fields disappear for OpenCode

- **WHEN** the editor is open on an OpenCode session
- **THEN** the argument-hint field is absent
- **AND** the preview renders `$ARGUMENTS` and positional `$1`–`$9` placeholders, not pi's default
  syntax

### Requirement: Command edits reach new sessions, and the editor says so

OpenCode reads commands when a session starts, so an edit SHALL be reflected in new sessions, and
the editor SHALL state that already-running sessions keep their loaded commands, so a warm session
not picking up an edit is not mistaken for a failure.

#### Scenario: A running session keeps its commands across an edit

- **WHEN** a command is added or deleted while an OpenCode session is open
- **THEN** the running session is unchanged
- **AND** the editor's note says new sessions pick the change up
