# Spec Delta

## Purpose

Defines how an agent asks the user a question with several fields — the contract shape, how the
host delivers it, and how it is rendered and answered — so any harness can use forms and no
frontend learns a harness-specific widget.

## ADDED Requirements

### Requirement: A form is a named set of typed fields

An agent SHALL be able to ask for a form: an ordered set of fields, each with a key the answer
is labeled by, a type the renderer chooses a control for, and optional constraints it can
validate before the answer is sent.

#### Scenario: A form field is typed and labeled

- **WHEN** a form request is delivered
- **THEN** every field carries its key, its type and the text shown for it
- **AND** a field whose type the renderer does not support cannot be mistaken for another type

#### Scenario: Constraints are checkable before sending

- **WHEN** a field carries a required flag or a range it must fall within
- **THEN** a renderer can validate the answer without asking the harness
- **AND** an answer that breaks a constraint is not sent silently

### Requirement: A field's visibility can depend on another field's value

A form field SHALL be able to declare that it is shown only when another field has a comparable
value, stated in form vocabulary rather than harness vocabulary.

#### Scenario: A conditional field follows its condition

- **WHEN** the answer to the field a condition compares against changes
- **THEN** the conditional field is shown exactly when the comparison holds
- **AND** a hidden field's value is not required for the form to be submittable

### Requirement: The answer is sent keyed by field

A form's answer SHALL be sent as a map from field key to value, values limited to what every
renderer can produce, and cancelling SHALL be distinguishable from submitting.

#### Scenario: The answer names each field it answers

- **WHEN** a renderer submits a completed form
- **THEN** the answer carries every answered field under its key
- **AND** the request it answers is the one it was asked by

#### Scenario: Cancel and submit never look alike

- **WHEN** the user cancels a form
- **THEN** that is distinguishable from submitting any set of values

### Requirement: A form is shown even where other interactions are answered natively

A host that answers other interaction kinds with its own native dialogs SHALL still deliver a
form to its frontend, which is the surface that can render it.

#### Scenario: A native-dialog host does not swallow a form

- **WHEN** a form arrives in a host that answers selects and inputs without the frontend
- **THEN** the form is still presented to the frontend for rendering
- **AND** the other interaction kinds keep their native path

#### Scenario: Dismissal follows the session in front

- **WHEN** the reader switches away from the session whose form is pending
- **THEN** the form is dismissed for that session and returns when it becomes active again
