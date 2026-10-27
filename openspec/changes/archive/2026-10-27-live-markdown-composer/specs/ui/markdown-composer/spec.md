# Spec Delta

## Purpose

Defines how the composer shows a prompt as formatted markdown while it is typed — what is
formatted, that the editing buffer always remains the exact source text, and that editing
behavior is unaffected by the formatting.

## ADDED Requirements

### Requirement: Markdown is formatted in the composer while it is typed

The composer SHALL show the draft as formatted markdown on the editing surface itself — fenced
code blocks as distinct panels with syntax-highlighted content, and inline code, emphasis, links,
headings and lists visibly distinct from prose — updating as the user types, with no separate
preview surface.

#### Scenario: A code fence renders as a panel while it is typed

- **WHEN** the user types an opening ``` fence and continues with code
- **THEN** the fenced lines are shown as a distinct code panel with syntax-colored content
- **AND** the panel appears while typing, without leaving the composer

#### Scenario: Inline markdown reads as formatting

- **WHEN** a draft contains inline code, emphasis, links, headings or list items
- **THEN** each is visibly distinct from plain prose in the composer

### Requirement: The editing buffer stays exact source text

The draft SHALL remain the exact markdown source the user typed; formatting alters presentation
only. The text sent to the engine and the text persisted as a draft MUST be byte-for-byte the
typed source, fence markers included.

#### Scenario: Sending sends the source

- **WHEN** the user sends a draft containing formatted constructs
- **THEN** the message text is exactly the characters they typed

#### Scenario: Copying yields the source

- **WHEN** the user selects formatted text and copies it
- **THEN** the clipboard holds the markdown source, not rendered output

### Requirement: Formatting never changes editing behavior

The formatting SHALL be presentational only: caret movement, selection, undo, IME composition,
Enter/Shift+Enter, Esc, `@` mentions, `/` commands and maximize behave exactly as in the
unformatted composer.

#### Scenario: Composition and editing are untouched

- **WHEN** the user types with an IME or edits within formatted text
- **THEN** composition, caret placement and undo behave as in a plain-text input

#### Scenario: Composer commands keep working over formatted text

- **WHEN** the user invokes mentions, commands, shortcuts or sends while text is formatted
- **THEN** each behaves as it does without formatting

### Requirement: Incomplete constructs render as the user is still typing

A construct that is not yet closed SHALL be shown with its formatting to the end of the draft
rather than reverting to plain text, so the user sees the panel grow as they type and end where
they close it.

#### Scenario: An open fence formats to the end of the draft

- **WHEN** a ``` fence is opened and not yet closed
- **THEN** the lines from the fence to the end of the draft are shown as a code panel
- **AND** closing the fence ends the panel exactly at the closing line

### Requirement: Formatting keeps up with typing

Formatting SHALL NOT delay input: keystrokes, pastes and deletes apply to the draft immediately
even in a long draft, with formatting catching up without perceptible lag.

#### Scenario: Rapid typing in a large draft

- **WHEN** the user types quickly in a long draft
- **THEN** the characters appear at once and no keystroke is dropped or reordered

### Requirement: Formatting adds no runtime dependencies

Live formatting MUST rely only on what the product already ships; the change SHALL NOT add
runtime packages or grow the bundle beyond the formatting code itself.

#### Scenario: Bundle composition is unchanged

- **WHEN** the application is built after this change
- **THEN** no new runtime package appears in the bundle compared to before it
