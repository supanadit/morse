# Selection Pins Specification

## Purpose

Preserves the exact range a reader highlights in the editor — lines and columns — so the attachment
chip and the agent prompt can point at the selected words instead of the whole line.

## Requirements

### Requirement: A selection is captured as a line-and-column span

The host SHALL report a selection as a 1-based start and end line and column, where the start column
is the first selected character and the end column is the last. Columns SHALL be 1-based character
offsets matching the editor's own status bar (a tab counts as one). The host SHALL also report how
many characters are selected.

#### Scenario: Words highlighted on one line

- **WHEN** the reader selects characters 45 through 79 of line 18
- **THEN** the reported span is line 18 column 45 through line 18 column 79
- **AND** the reported selected-character count is 35

#### Scenario: A selection that crosses lines

- **WHEN** the reader selects from the middle of line 18 to the middle of line 20
- **THEN** the span keeps the start column from line 18 and the end column from line 20

#### Scenario: A selection that ends at the start of a line

- **WHEN** the reader selects through the newline that ends line 19
- **THEN** the span ends at the last character of line 19 rather than column 0 of line 20

#### Scenario: A focused file with no selection

- **WHEN** the editor has a file in front and nothing is selected
- **THEN** the host reports the file with no line or column span
- **AND** the reader still sees a whole-file preview

#### Scenario: Several carets at once

- **WHEN** the editor holds more than one non-empty selection
- **THEN** the host reports the line envelope from the earliest start to the latest end
- **AND** it reports no columns, because one column pair cannot describe disjoint selections

### Requirement: A selection chip names its exact range

The attachment chip SHALL show a partial-line selection as `L18:45-79`, a multi-line partial
selection as `L18:45-20:12`, and a whole-line selection as `L18-20`. A whole-file pin SHALL show no
range. The chip's tooltip SHALL name the path, the column range and how many characters are selected.

#### Scenario: A word range on one line

- **WHEN** a pin covers line 18 columns 45 through 79
- **THEN** its chip reads `L18:45-79`

#### Scenario: A partial range across lines

- **WHEN** a pin starts at line 18 column 45 and ends at line 20 column 12
- **THEN** its chip reads `L18:45-20:12`

#### Scenario: Whole lines keep their label

- **WHEN** a pin covers lines 18 through 20 with no partial columns
- **THEN** its chip reads `L18-20`

#### Scenario: A whole-file pin has no range

- **WHEN** a pin carries a path and no lines
- **THEN** its chip shows the file name and no line label

#### Scenario: Hovering a chip explains the range

- **WHEN** the reader hovers a column pin's chip
- **THEN** the tooltip names the path, `line 18, columns 45-79`, and `35 selected`

### Requirement: A one-line selection carries a bounded excerpt

A pin whose selection is inside one line SHALL carry an excerpt of the selected words, capped so a
long highlight cannot flood the prompt. A multi-line or whole-line pin SHALL NOT carry an excerpt.

#### Scenario: A short word range

- **WHEN** the reader pins 35 characters on one line
- **THEN** the pin carries those characters as its excerpt

#### Scenario: A very long word range

- **WHEN** the reader pins more than the excerpt limit on one line
- **THEN** the excerpt is truncated to the limit
- **AND** the pin still carries the full line and column range

#### Scenario: A multi-line selection

- **WHEN** the reader pins a range that crosses lines
- **THEN** the pin carries no excerpt

### Requirement: Column-aware pins coalesce like selections

Pins on the same line that overlap or touch SHALL merge into one pin whose columns span both. A merge
that crosses lines SHALL drop the columns and become a whole-line pin. A whole-file pin SHALL never
merge with a line pin.

#### Scenario: Two word ranges on one line touch

- **WHEN** a pin covers line 18 columns 45-79 and another covers columns 80-92
- **THEN** one pin covers line 18 columns 45-92

#### Scenario: A word range meets its whole line

- **WHEN** a pin covers line 18 columns 45-79 and a whole-line pin covers line 18
- **THEN** one pin covers line 18 with no columns

#### Scenario: Two word ranges on different lines meet

- **WHEN** a pin on line 18 touches a pin on line 19
- **THEN** one pin covers lines 18-19 with no columns

#### Scenario: A whole-file pin stays separate

- **WHEN** a whole-file pin exists for a path and a line range is pinned for the same path
- **THEN** both pins remain, because one names the file and the other a range

### Requirement: A pinned selection reaches the agent with its column range

A pin with columns SHALL reach the agent as `@path:startLine:startColumn-endLine:endColumn`, and a
pin with whole lines SHALL keep `@path:startLine-endLine`. A one-line excerpt SHALL follow its
mention as a generated `  | ` line, distinct from the reader's own `  > ` annotation lines. The
reader's prose SHALL remain exactly what they typed.

#### Scenario: A word range on one line

- **WHEN** the reader sends a message with a pin on line 18 columns 45-79
- **THEN** the prompt carries `@src/app.ts:18:45-18:79`
- **AND** the highlighted words follow on a `  | ` line

#### Scenario: A partial range across lines

- **WHEN** a pin spans line 18 column 45 to line 20 column 12
- **THEN** the prompt carries `@src/app.ts:18:45-20:12`
- **AND** no excerpt line is generated, because the range is not inside one line

#### Scenario: A whole-line pin is unchanged

- **WHEN** a pin covers lines 18 through 20 with no columns
- **THEN** the prompt carries `@src/app.ts:18-20` as it does today

#### Scenario: A generated excerpt is not a reader note

- **WHEN** a pin has both a generated excerpt and a reader annotation
- **THEN** the excerpt is on a `  | ` line and the annotation is on `  > ` lines
- **AND** the two are never confused

#### Scenario: A message with no prose

- **WHEN** the reader sends only pins
- **THEN** the prompt contains the mention and excerpt blocks and no invented prose

### Requirement: Column mentions survive a stored conversation

When a conversation is replayed, the host SHALL recover the same column ranges from the mentions it
sent and SHALL consume the generated excerpt lines. An older mention without columns SHALL keep
rendering exactly as before.

#### Scenario: A resumed session shows the same chips

- **WHEN** a stored prompt carries `@src/app.ts:18:45-18:79`
- **THEN** the transcript renders a chip labelled `L18:45-79`

#### Scenario: Generated text does not become the reader's words

- **WHEN** a stored prompt carries a `  | ` excerpt line under its mention
- **THEN** that line is not shown as the reader's prose or as their annotation

#### Scenario: An older session is untouched

- **WHEN** a stored prompt carries `@src/app.ts:18-20` with no columns
- **THEN** it renders exactly as it did before this capability existed

#### Scenario: A fork seeds the columns again

- **WHEN** a forked prompt carrying a column pin is handed back to the composer
- **THEN** the composer restores the same line and column range

### Requirement: A host without column capture keeps working

Every new selection field SHALL be optional. A host or adapter that reports only lines SHALL produce
the same chips, prompts and stored conversations as today.

#### Scenario: A line-only host

- **WHEN** a host reports a pin with lines but no columns
- **THEN** its chip reads `L18-20`
- **AND** the prompt carries `@path:18-20`

#### Scenario: A line drag in the file preview

- **WHEN** the reader drags the preview's line numbers to pin a range
- **THEN** the pin has lines and no columns, exactly as before

#### Scenario: An old stored pin

- **WHEN** a persisted draft holds a pin with lines but no columns
- **THEN** it rehydrates and renders without a migration step
