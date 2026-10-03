# Changelog

## 0.3.1 — 3 October 2026

### Fixed

- **A sidebar shortcut now reveals the sidebar.** `/` (session search) and `Ctrl+Alt+P` (`⌘⌥P`, project filter)
  opened their field or panel without opening the sidebar that holds it, so on a narrow host they stayed off
  screen until the sidebar was opened by hand.
- **The empty state only promises the ⧉ pin button where it exists.** The pin button needs an editor selection,
  which the browser host does not have, so the startup hint no longer mentions it there.

## 0.3.0 — 3 October 2026

Shortcuts, project filtering, an update notice, and a lighter host. The wire protocol moved to 17, so update both
hosts together: the panel and the host must be the same version.

### New

- **Keyboard shortcuts, with a list that cannot lie.** `Ctrl+Alt+…` (`⌘⌥…` on macOS) starts a session, narrows the
  sidebar to one project, changes the model or the thinking level, and opens the compaction question. `/` jumps to
  the session search, `?` prints every key Morse understands.
- **It says when a newer Morse is out.** The sidebar reads the published version once per load and shows an update
  notice beside the version it beats, with the command that installs it for your host. Turn it off with
  `MORSE_UPDATE_CHECK=0`.
- **Projects get their own control.** A full-width button above the session search opens a searchable project
  filter, so narrowing the sidebar to a project no longer means typing a project name into a box that searches
  session titles.
- **Compaction asks first.** `/compact` and the header button open a confirmation that names what pi will replace,
  with the safe choice focused.
- **A screen for "pi is not installed".** Instead of a spawn error, the panel names the install command and the
  setting or environment variable your host reads. The offline screen names the commands that start and stop the
  host.
- **The sidebar folds away** on a wide layout, and remembers that across reloads.
- **About Morse**, from the sidebar colophon or `/about`: the build and protocol talking to you, and every
  technology the project stands on with its licence.
- **JetBrains Mono ships with the panel** (SIL OFL 1.1), so code and prose look the same on a machine with no
  fonts installed. VS Code still uses your editor font.

### Improved

- **A lighter host, by measurement.** Refreshing the session list went from 624 ms of CPU to 2 ms; one prompt in a
  warm session, from 49% of a core to 2.3%; and streamed prose no longer re-renders the whole answer on every
  token. `docs/DEVELOPMENT.md` has the numbers and the method.
- **One "New session"**, in the sidebar, where the sessions are.
- **Which bundle is talking is visible**, in the panel and in the host log.

### Fixed

- The two pane headers line up again.
- The setup screen names the command a production install actually has.

### Under the hood

- **Both hosts must be updated together** — protocol 17. A mismatched panel is refused with a message instead of
  rendering half a conversation.
- `pi` is still spawned (`pi --mode rpc`) and never imported: what a live session costs is pi's, and
  `MORSE_HOT_SESSIONS` (default 4) caps how many stay alive.

## 0.2.1

- Live selection chip: what you highlight in the editor appears in the composer immediately, with the start and
  end line numbers updating in real time while you drag or re-select. Clicking the chip locks it (it keeps its
  numbers and rides with the next message); a new selection afterwards makes a new live chip. Locked chips are
  sent as `@path:start-end` mentions, and the ⧉ shortcut locks the live preview without a round trip.

## 0.1.0

Initial release.

- Chat sidebar that drives `pi --mode rpc` in the active workspace.
- Streaming answers, thinking blocks and tool cards with input/output.
- Steer, follow-up and abort while the agent is running.
- Model and thinking-level pickers, plus context compaction.
- Project browser: several sessions in several projects at once, activate/close, LRU-hot processes.
- Session list and resume from the pi session directory.
- Pi extension dialogs (select/confirm/input/editor) mapped to VS Code UI.
- Editor selection, active file and open editors attached as prompt context.
