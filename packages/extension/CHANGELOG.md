# Changelog

## 0.8.0 — 4 October 2026

A git panel and diffs arrive in the browser host, and thinking is readable while it happens.

### New

- **A git panel (browser host).** A right-hand panel — or the full width from its expand button — with the
  uncommitted changes on top and the commit graph below. Scroll the graph to keep loading older commits, back to
  the first one; drag the divider to resize the two sections, and fold either of them from its header.
- **Diff in the file preview.** A changed file opens with a **File / Unified / Split** switch: the unified diff,
  or an old-and-new side by side, syntax-highlighted like the file itself and totalled as *+N −M*. A changed file
  is badged in the Explorer, and the folder that holds one gets a dot.
- **The Explorer keeps up.** It re-reads the working tree on a timer, so a file added or deleted on disk appears
  without a server restart.
- **Thinking is readable while it streams.** A thinking note opens itself and follows its own text, then folds
  back when the answer starts; its star breathes while the note is live.

### Changed

- **Quoted files belong to their session.** A file opened from the `@` picker keeps its own row and shows only
  while that session is in front, read as small coloured chips rather than a second tab bar.

### Fixed

- No stray caret appears below a thinking note while the model reasons.

## 0.7.0 — 4 October 2026

The browser host gets an Explorer, editor tabs and quotable line ranges — the surfaces VS Code already had.

### New

- **Explorer and tabs (browser host).** The sidebar grows a file Explorer, and the chat a tab strip where
  sessions and files sit side by side. Drag the Explorer's top edge to resize it.
- **File preview.** A file opens read-only, line-numbered and highlighted. Drag across the line numbers to pin
  a range (`path:start-end`) to your next message; a range's top and bottom edges are handles you can pull,
  and ranges that touch or overlap coalesce into one chip.
- **A merge is visible.** When two highlights become one, the band throws colourful confetti from the seam and
  a rainbow border spins once around it.
- **Quoted files get their own tab row,** so opening a mentioned file never pushes a session tab aside.

### Changed

- Picking a file in the `@` picker opens it in the preview; clicking a pinned chip re-opens it there, where
  its range can be dragged.

## 0.6.0 — 4 October 2026

The sidebar shows what the agent is working on right now, and looks calmer doing it.

### New

- **An "In progress" section.** Sessions the agent is working in right now are lifted to the top of
  the sidebar — across every project — with a spinner and a line naming the step (*Reading
  about-acme.md*, *Running npm test*). A project filter narrows the section too, and a running
  session is not listed twice.
- **A cleaner sidebar.** Session rows are two lines (title, and time or status), section headings are
  quiet and uppercase, and the spacing is roomier.

### Fixed

- **A session no longer flickers into "In progress" when you open it.** Spawning the agent flipped
  `agentStarting`/`busy` for a beat, which the sidebar read as work; only an actually running turn
  counts now.

## 0.5.0 — 4 October 2026

Tool calls get a calmer default view, with every detail still one click away.

### New

- **A compact tree for tool calls, now the default.** A turn folds into a single summary line —
  *Worked for 6s · 5 actions · 2 thoughts* — with the newest step beneath it and the files that step
  changed hung off it behind a guide line. Every row opens its own input, output and thinking, so
  nothing is lost. The detailed, always-open timeline is still one click away in the toolbar, and the
  choice is remembered between sessions.

### Fixed

- **Elapsed time no longer disappears when a turn settles.** pi reports no duration with a tool
  result, so *Worked for Ns* only ever appeared while the agent was still working; the host now
  measures each tool's duration itself, and the total is shown for finished turns too.

### Improved

- **The thought count is back in the summary** — the compact view no longer drops it, and the
  expanded tree lists the thinking notes it counts.

## 0.4.1 — 4 October 2026

Three fixes surfaced by an unclean start, a restored `~/.pi`, and an honest token count.

### Fixed

- **`morse start` no longer claims a daemon is running when it is gone.** A force-kill
  leaves `~/.morse/server.json` behind, and the OS can hand that pid to an unrelated
  process; the CLI trusted the pid alone, so it reported a running server that was not
  there. It now mints a per-start `instance` token and requires `/api/health` to echo it,
  clearing the stale state instead. `morse stop` also refuses to signal a recycled pid.
- **The setup screen appears on load when `pi` is missing.** The draft probe that fills
  the empty panel's model pickers swallowed the "agent not found" error, so a machine
  with a restored `~/.pi` (old sessions in the sidebar) but no `pi` binary looked healthy
  until the first prompt failed. The missing agent is named as soon as the panel loads,
  and Retry re-probes so a later install is picked up.
- **The Context panel shows `—` for a token count the provider never reported.** pi turns
  a missing reasoning breakdown into `0`, so the panel read as "the model did not think"
  when Ollama or Anthropic simply does not count thinking tokens separately.

## 0.4.0 — 3 October 2026

Prompt templates become first-class in the composer.

### New

- **Prompt templates run from a form.** A template that declares `argument-hint` now opens a modal
  with one field per argument, an *Additional instructions* box appended below the expanded template,
  and a live preview of the exact prompt. Templates with no arguments are sent straight through.
- **Templates stay in sync with the files.** The command palette re-reads `~/.pi/agent/prompts`
  (and a trusted project's `.pi/prompts`) as it opens, so a template added, edited or deleted since
  the session started shows up without restarting pi.

### Fixed

- Clicking a row in the command palette now runs it, exactly like Enter. It used to insert the
  command text and leave it in the composer.

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
