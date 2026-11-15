# Session rename and project deletion

Date: 2026-11-15
Status: proposed

## Intent

A session is named by its engine: pi derives a name from the first prompt, OpenCode generates a title,
and Morse changes it again whenever the engine reports a new one. The reader has no say, so a
conversation they would call "release prep" stays "Reply with exactly: pi-host" forever.

Nor can a project be removed as a unit. Its sessions can be deleted one at a time through the
existing `session/delete`, but a project with forty sessions takes forty confirmations, and the
engine files behind them are only reachable one by one.

Goal: a session's name is Morse's to set — stored in Morse's own record under
`~/.morse/sessions/records/`, never written into pi's `.jsonl` or OpenCode's server data — and a
project can be deleted as a unit, which removes every session it holds from that engine's storage
while the directory itself stays on disk.

## Non-goals

- Renaming a session inside the engine (pi has no such call; OpenCode's title API is not used, so
  the same action means the same thing on every engine).
- **Renaming a project.** A project is a derived group of session `cwd`s with no record of its own,
  so the only project operation this adds is deletion — its row gains no rename control.
- Any user-editable session field other than the title.
- Deleting or moving the project directory itself.
- Editing a transcript's messages (fork-and-edit already exists and is unchanged).
- A stored project record: projects stay derived from session `cwd` groups.

## Constraints

- `MorseSessionRecord` is the sidebar's source of truth for titles (`~/.morse/sessions/records/`).
- Two paths overwrite a title today: `planReconcile` re-upserts a record from the engine's report
  whenever that report's token changes, and the live row writer takes `agent/state.sessionTitle`
  when the engine renames itself. A user title must survive both.
- `session/delete` already ships: registry close → engine catalog `remove` (pi unlinks only a
  `.jsonl` inside its session directory; OpenCode calls `DELETE /session/:id`) → index row removed.
  Project deletion reuses that path per session.
- Hosts restrict what they may touch (`withinScope`); deletion outside the scope must be refused
  with the existing wording, never attempted.
- Destructive actions confirm: VS Code uses its own modal (`confirmDeleteSession`), the browser
  renders the question in its menu. A new project delete needs the same treatment.

## Approaches considered

1. **Pin the title on Morse's session record (chosen).** An additive optional flag marks the title
   as the reader's; reconcile carries it forward and the live writer stops overwriting it. One
   source of truth, and list, paging, search and counts need no change.
2. **A sidecar title map** (`titles.json`, id → title) overlaid on summaries. It survives reconcile
   without touching the record, but every projection has to apply it, deletion has to prune it, and
   the map and the record can disagree after a crash.
3. **Rename through the engine** where one offers it, Morse-side only as a fallback. Rejected: it
   would write engine state the task says must not change, and produce two behaviors behind one
   action.

The owner picked 1.

## Design

**Record.** `MorseSessionRecord` gains optional `titlePinned?: true`. It is additive, so hosts that
predate it read the record exactly as before; no shape-version bump or migration is needed. A record
written by reconcile keeps its pin by merging from the stored record for the same id.

**Wire.** Two client messages:

- `session/rename` with `{ sessionId, title }` — the title trimmed, non-empty, capped at 120
  characters; the host answers with the usual error notice when the record is gone or the value is
  refused, and otherwise republishes the session list.
- `project/delete` with `{ path }` — the host refuses outside its scope, then removes every session
  whose `cwd` is that path.

And one host command, `confirmDeleteProject`, mirroring `confirmDeleteSession` (VS Code modal; the
browser asks in its own menu).

**Host behavior.**

- Rename: read the record, write it back with `title` and `titlePinned: true` and no engine token,
  then `publishSessions()`. A live session keeps running; its engine may report another title and
  the pin makes Morse ignore it.
- Reconcile: `planReconcile` copies `titlePinned` and the stored title onto an upserted record for
  the same id, so an engine token change cannot rename a pinned session.
- Project delete: collect the records for that `cwd`; for each, close the live process and remove it
  through its own engine's catalog, clearing its transcript and paging cursor; then republish
  projects and sessions with a notice naming how many went. A session that fails to delete is
  reported, and the rest still go — the notice says "Deleted N of M", never that the project is
  gone when a row survived. The directory is never touched.

**Frontend.** `renameSession` and `deleteProject` join the client; the session row's existing
context menu gains **Rename** (inline edit in the row: Enter saves, Escape cancels, empty is
refused), and a project row's context menu gains **Delete project…** showing its session count.
The project row gets no rename and no other editable field — deletion is the whole project
operation. Both confirm through the host when it has native dialogs, otherwise in-app. Deleting a
project drops every removed id from the tabs and forgets any remembered active session; a draft tab
is left alone, since it holds no stored conversation.

## What is left to the builder

- Exact menu copy and the inline editor's styling.
- Whether the browser's project confirmation is a row-level question or a small dialog; both
  surfaces already exist for the session delete.
- How "Deleted N of M" reads when N equals M (the normal case).
