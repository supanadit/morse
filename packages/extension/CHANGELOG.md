# Changelog

## 0.20.0 — 7 October 2026

What a model accepts is on the badge, and pi's dialogs arrive as a card.

### New

- **See what a model accepts before you pick it.** The model picker now badges each model's input
  modalities — text, vision, audio, video, PDF — with an icon and a tooltip, and typing `vision` in
  the search finds the image-capable ones. A model with no badge is one pi said nothing about, never a
  claim that it is text-only.
- **pi's dialogs open as a proper card.** A question, confirmation, text prompt or multi-line editor
  now shares one card shape: an icon per kind, a numbered option list, and a footer that puts Cancel
  before the action, with a destructive one marked. Escape cancels any of them, Enter submits the input
  and editor kinds, and the arrow keys move between options without pulling focus away while you scroll
  the transcript.

### Fixed

- **The Changes divider stays under your cursor.** Grabbing the handle between the commit box and the
  changed files used to make the divider jump down by the height of everything above it. It now measures
  from the Changes section itself and folds in the grab point, so the drag starts where you grabbed it.
- **The Explorer's header hover is a full-width row.** It matches the git panel's section headers instead
  of a small rounded patch behind the label.

## 0.19.2 — 6 October 2026

The last lines a terminal printed before `morse stop` now survive it.

### Fixed

- **A dev server's shutdown log is in the restored terminal.** The host used to write a terminal's scrollback
  before it stopped the shell, so the lines a process prints after receiving the signal — `Worker events
  consumer stopped`, `Kafka producer disconnected` — were lost. It now signals first, gives the shell a beat to
  finish, then saves, so a restart replays those lines too.

## 0.19.1 — 6 October 2026

A terminal that comes back where you left it after `morse stop` and `morse start`.

### Fixed

- **A restored terminal reopens in the directory you `cd`'d to.** The shell's own directory is read from the
  terminal's OSC 7 report and kept per pane, so after a host restart each pane — a split included — starts in
  the folder it was in, not at the session's project root. A restart also replays the scrollback the host kept
  on disk, so the old output is there with the new prompt.

## 0.19.0 — 6 October 2026

Keyboard-driven project picking, and a terminal that survives every tab switch.

### New

- **Pick a project with the keyboard.** In **New session**, the search field now takes the arrow keys to move
  through the matching projects and Enter to open the highlighted one — no mouse needed. The first match is used
  when nothing is highlighted, and the highlight follows the query.

### Fixed

- **A running terminal no longer dies when you switch tabs.** A shell belongs to the host, not to the panel:
  hiding the bottom panel (no session in front), switching sessions, or a reload/reconnect only detaches and
  replays, and a shell ends only when you close the pane, the chip, or its session tab.
- **A "New session" that holds a terminal is no longer discarded.** Picking another tab used to drop the untouched
  draft — and the shell running in it, including the directory it was in.

## 0.18.1 — 6 October 2026

MCP config edits arrive on their own, and a background session no longer strands a dialog.

### New

- **MCP changes appear without reopening anything.** Adding, removing or toggling a server — in another window, or
  with the `pi` CLI in a terminal — updates the MCP indicator and panel as soon as the `mcp.json` file changes on
  disk, for both your user-level file and the project's.

### Fixed

- **A dialog from an extension in a background session is no longer lost.** An interaction raised while you were
  looking at another tab used to be dropped, leaving that `pi` process waiting forever. Morse now tracks dialogs per
  session, answers the process that asked, shows one at a time (switching tabs swaps it), and marks a waiting
  session in the sidebar.
- **The MCP indicator follows the session.** Switching conversations re-probes that project's servers instead of
  leaving the previous project's dot, and coming back to the window re-reads it too.
- **Deleting a session that is already gone no longer errors.** When its file had been removed out of band, Delete
  failed after closing the agent; it is now idempotent.

### Improved

- **Long interaction dialogs.** Multi-line titles wrap, a tall dialog scrolls, and an empty answer can be submitted.

## 0.18.0 — 6 October 2026

Pi's own extension chrome, follow-ups that run while you look elsewhere, and a cleaner empty view.

### New

- **Pi's extension chrome, in Morse.** Extensions that set a status line or a text widget through pi's `ctx.ui` now
  show up as a strip just above the bottom panel in the browser host, and at the foot of the chat in VS Code. RPC
  forwards text only, so it is the extension's own lines — not a second terminal.
- **Follow-ups run in their session, even when it is not in front.** A queued follow-up now runs as soon as *its*
  session settles, instead of waiting until you switch back to that tab. The prompt is addressed to that session, so
  the panel stays where you are looking.
- **A prompt template renders on Enter.** Typing `/command` and pressing Enter expands the template (inline arguments
  included) instead of sending the bare command — the same result as picking it from the palette.

### Fixed

- **The bottom panel is folded per session.** Opening the terminal in one conversation no longer opens it in every
  other one; each session keeps its own fold, while the dragged height stays shared.
- **"Close All" on a file chip returns to its session.** It used to land on whichever session tab sat last in the
  strip, instead of the conversation the chip belonged to.
- **No stale project with no session.** The Explorer, git panel, terminal and the palette's file list stay out when no
  session is in front, and the header drops the previous session's model and project buttons. Global things stay
  usable: MCP still opens (your own `mcp.json`, project scope disabled) and prompt templates edit your user
  templates.
- **A new session's project search is focused.** Opening **New session** — from the sidebar or the command palette —
  puts the caret in the search field.

## 0.17.0 — 6 October 2026

Write and test pi's prompt templates without leaving the editor, and have a template written anywhere show up on
its own.

### New

- **A prompt-template editor.** pi turns Markdown files into `/commands`; Morse now has a proper editor for them.
  Run **Edit prompt templates** from the command palette (`Ctrl+Alt+E`) to open a tab — the browser host puts it next
  to your sessions, VS Code opens its own editor panel. Browse the user templates and the open project's, create,
  rename, move between user and project scope, or delete; the frontmatter (`description`, `argument-hint`) and the
  body are fields, not a raw text dump.
- **Test the arguments before you run it.** The editor expands the body against sample arguments with the same code
  the composer uses, so the preview is exactly what the agent receives — `$1`, `${1:-default}`, `$@` / `$ARGUMENTS`,
  `${@:2}` and `${@:2:3}`, with shell-like quoting. Fill the declared fields, or switch to **Raw** and type the whole
  argument line. The tester tracks the body: delete `$3` and its input goes with it.
- **Templates are picked up automatically.** A `.md` written or edited outside Morse — in `vim`, `nano`, or by hand —
  is noticed within a moment and offered in the palette, without opening the editor or reloading. (A project's
  `.pi/prompts` still has to be trusted, as pi requires.)

### Fixed

- **The prompt-template editor in VS Code lists your user prompts.** The panel booted before the host handshake
  finished, so it used to come up empty; it now waits for the host's capabilities and loads the list. The workspace
  folder counts as the project there, so project templates appear too.

## 0.16.1 — 6 October 2026

A quick follow-up to 0.16.0: the browser host starts again.

### Fixed

- **`morse start` works after updating to 0.16.0.** The server bundle had inlined the YAML parser as CommonJS
  code, so the daemon crashed on start with `Dynamic require of "process" is not supported` and the command only
  seemed to hang. The parser is now loaded normally, and the build refuses to emit a bundle that cannot boot.

## 0.16.0 — 6 October 2026

Check an MCP server before you add it, trust a project from the panel, and let a half-written entry survive a
reload.

### New

- **Check an MCP server before you add it.** **Add server** now opens its own editor — a tab in the browser host, an
  editor panel in VS Code — where you build the entry and press **Test connection**. Morse connects itself and shows
  the tools, resources and prompts the server offers, or exactly why it would not (it wants a sign-in, it is
  unreachable, the command is wrong), before anything is written to `mcp.json`. The manager behind the toolbar
  indicator stays the list it should be: state, enable/disable and the project/global scope.
- **Trust a project from the panel.** When pi is ignoring a project's `.pi/mcp.json` because the folder is not
  trusted, the MCP panel shows pi's note with a **Trust this project** button, so the project's servers, settings,
  skills and prompts load without running pi in a terminal.
- **A warning when pi refuses a prompt template.** A `/command` whose frontmatter pi cannot parse is dropped from the
  palette and named in a warning row above the chat, with the reason behind a **Details** click — instead of being
  offered as a command pi will not run.
- **A newer pi is announced, too.** The sidebar now shows an update notice for pi itself beside the Morse one, and
  names the command that installs it, `pi update`.

### Improved

- **A half-written MCP entry survives a reload.** The editor keeps your form and its test result across a browser
  refresh or a VS Code window reload, and the editor tab reopens where you left it.
- **URLs in the terminal are one click.** A link printed in the terminal — a dev-server banner, a docs URL — opens in
  a new tab instead of needing a copy.
- **Same-named files are told apart.** When two open files share a name, the whole chip row adds each file's
  directory on a second line, clipped at the front so the folder nearest the file stays visible.
- **`pi` is found even when VS Code was launched from the Dock.** A `pi` installed through nvm, asdf or volta is
  found through the login shell's `PATH`, instead of the setup screen claiming it is missing.

### Fixed

- **Closing the file chip in front returns to its session.** It used to jump to whichever file sat beside it — often
  another session's — instead of the conversation the chip belonged to.
- **A terminal no longer inherits Morse's own settings.** The shell starts with your environment only, so running
  Morse from inside Morse no longer picks up the host's port or workspace and fails with `EADDRINUSE`.

## 0.15.0 — 6 October 2026

A new session starts from a project you already have, the Explorer follows the file you open, and a terminal
survives a host restart.

### New

- **New session: pick the project first.** In the browser host, **New session** now lists the projects pi already
  knows — the same ones the sidebar groups sessions by — so a session starts in one of them without navigating the
  filesystem. **Choose a folder…** opens the folder browser for a project pi has never seen, and Escape steps back to
  the list.
- **The Explorer follows the file you open.** A file opened from the Explorer, the git panel or a `@` mention expands
  the folders down to it, highlights its row and scrolls it into view. Switching chips moves the Explorer's focus
  with it.

### Improved

- **The file chip in front reads at a glance.** The active chip below the tabs expands to its full filename and
  carries the accent tint plus a focus ring, instead of truncating at a fixed width.

### Fixed

- **A terminal keeps working after the host restarts.** After `morse stop` and `morse start`, the pane re-attaches to
  the new host when the connection returns; before, it kept showing the old screen while every keystroke was dropped
  by the fresh host, which had never seen the terminal.

## 0.14.1 — 5 October 2026

A model change and its thinking levels now arrive together, so the thinking picker never shows the previous
model's list.

### Fixed

- **No more stale thinking levels when you switch models.** A model change used to update the model first and its
  thinking levels a moment later, so the picker could briefly show the levels of the model you just left. Both now
  arrive as one update.
- **A failed level read no longer invents a list.** If pi did not answer, the picker fell back to every level pi
  knows, including ones the model does not support; it now keeps the levels it already had instead.
- **The open picker keeps its row.** If the level list changes while the panel is open, the highlighted row is
  clamped to the list rather than pointing past its end.

## 0.14.0 — 5 October 2026

Manage your MCP servers from the panel, and a thinking picker that follows the model you actually picked.

### New

- **Manage MCP servers.** The chat toolbar now has an MCP indicator that opens a manager for the servers pi sees for
  the session's directory: their connection state, tools and errors, plus add, remove, enable and disable. Edits land
  where you choose — **This project** writes `.pi/mcp.json`, disabling a user-level server with a project override the
  way pi's own `/mcp` does, or **Global** for the user file. Signing in stays pi's job.
- **Thinking that follows the model.** pi scopes its thinking levels to the current model, and the picker now mirrors
  them per provider and per model instead of keeping the first model's list: switching models re-reads the levels, and
  a model chosen on an empty draft re-probes its catalog.
- **Models appear without a restart.** A model added to `models.json` shows up when you open the model picker — and a
  reload re-reads the warm session — so neither the host nor the session has to be restarted.

### Fixed

- **A file chip's right-click menu no longer closes your session.** Close, Close Others, Close to the Right and Close
  All now act on the chip's own row; a session tab's menu still spans the whole strip.
- **`pi mcp` no longer dies under `node --watch`.** An inherited IPC channel (`NODE_CHANNEL_FD`) made the spawned `pi`
  exit with `write EINVAL` before it could answer; both the MCP call and the RPC session now spawn with a clean
  environment.

## 0.13.0 — 5 October 2026

One field to drive everything, a terminal that survives a reload, and a quiet ping when a session is done.

### New

- **The command palette.** One field over the whole app: run a command, switch a tab, open a session, file or project,
  or pick the model and thinking level. It lists everything by default and a leading `>` `#` `@` `:` narrows it to that
  source. Open it with `⌘⌥K` / `Ctrl+Alt+K` — or straight from the prompt.
- **A terminal that outlives the page.** The shell now runs in the host, not the tab, so a refresh reattaches to the same
  process and replays what streamed while you were away. The scrollback is written to `<MORSE_HOME>/terminals/` too, so
  even after the host restarts you get the old output back under a fresh prompt. An idle shell is reclaimed after 30
  minutes (`MORSE_TERMINAL_IDLE_MS`).
- **Files belong to the session in front.** A file opened from the Explorer, the git panel or a quote becomes a chip of
  the session you are in rather than a tab beside it, and that session is marked as the chip's owner — so it is never a
  guess which conversation a file belongs to. Click the chip again while it is in front to go back to the chat.
- **A ping when a session finishes.** A run that ends while you are elsewhere can say so. It is off by default, with a
  one-time nudge that offers to turn it on; choose **only when the window is not focused** or **always**, from the banner
  or the command palette. VS Code raises its own notification; the browser uses the desktop one, asking for permission on
  the click.

### Improved

- **No session is a clear state.** With nothing open, the panel now says so and offers to start a session instead of
  showing a hero and letting a stray prompt quietly create one — and it no longer names the previous project as if this
  empty panel belonged to it.

## 0.12.0 — 5 October 2026

Pick up where you left off — and a terminal that finally runs.

### New

- **Reopen where you left off.** The browser host now restores your workspace when you come back: the tabs you had
  open and the one in front, the bottom panel and every terminal, and it resumes the session you were on — so a
  `morse stop`, a refresh or a closed laptop is no longer a fresh start. A "New session" draft keeps its own tab too.
- **Drafts that outlive the tab.** The half-written message of each tab — text, pinned ranges, `@` mentions and
  attached images — is saved per tab and comes back with it, so a long prompt survives a restart. It stays isolated:
  switching tabs never carries one session's words into another.
- **Reorder the queue.** Drag a queued follow-up by its grip to change which one runs first.
- **Collapse Staged and Unstaged.** Each change group folds from its own header, the way VS Code's Source Control does.

### Fixed

- **The terminal works in the packaged build.** The pane never opened a shell outside development — a CommonJS import
  left `Terminal` undefined — so the terminal now starts as it should, GPU renderer included.
- **Committing with nothing staged says so.** Instead of `Command failed: git commit -m …`, the panel answers
  "Nothing is staged to commit. Stage a change first.", and pressing Enter on an empty index no longer asks git at
  all. A refused checkout shows git's own line rather than the wrapper.
- **The Staged group stays put.** It is always visible while Changes is open, with "No staged files. Stage a change to
  commit it." when empty, and its +/− buttons line up with the per-file ones.

## 0.11.0 — 5 October 2026

A terminal in the panel, and a panel that gets out of its way.

### New

- **A terminal in the panel.** A VS Code-style panel below the composer opens a real terminal — one per session, started in
  that session's own directory, so each conversation keeps its own shells. It starts folded to its chip; the chip opens it,
  the top edge drags it taller, the chevron folds it back without killing the shell, and the expand button hands it the whole
  conversation column.
- **Split terminals.** A terminal can be split into panes side by side, each with its own shell and its own scrollback. The
  chip shows the count (`Terminal 1 (2)`), a tab row under the panes names each one, and the seam between two panes drags to
  size them.
- **Terminals name themselves — and rename.** A terminal follows the shell's title, so a running `npm run dev` names its own
  tab; double-click a chip to name it yourself, and the shell's title stops replacing it.
- **Reorder tabs, browse folders, inspect commits.** Tabs drag to reorder; the New session path field live-loads its
  subfolders as you type; a commit row's tooltip shows its full subject, refs, author, exact time and hash.

### Fixed

- **A failed background command no longer writes into the transcript.** A folder browse, file preview or git poll that fails
  is reported to its caller instead of painting a red notice into the conversation.
- **Queued follow-ups stay in their session.** The queued-messages list now belongs to the tab in front, so a follow-up
  scheduled in one session no longer appears in another.

## 0.10.0 — 5 October 2026

Drafts that stay yours, and a git panel that does the everyday work.

### New

- **A draft per new session.** Every **New session** opens its own draft tab, and the half-typed message, its images,
  pins and `@` mentions are kept per tab — switching tabs shows that tab's words and never carries them into another
  session. An untouched draft is dropped when you open a real session; one you have written in stays until you close it.
- **The git panel does the everyday work.** Stage or unstage a file or a whole group, write a commit message and commit
  what is staged, and read how far HEAD is from its upstream with **Pull**/**Push** buttons (**Push** carries release
  tags with it). Expanding a commit in the graph lists the files it touched and opens one as its own diff, and the
  branch chip opens a picker with local, remote and tag checkouts, **Create new branch…** and **Checkout detached…**.

### Fixed

- **A bare URL in a transcript is a link again.** `github.com/owner/repo` now opens when clicked, without turning
  filenames or version numbers into links.
- **An abandoned draft no longer leaves two tabs.** Promoting a session that already owns a tab replaces the old one
  instead of leaving a duplicate.

## 0.9.5 — 4 October 2026

Two Morse windows no longer double the conversation.

### Fixed

- **Two connected clients no longer duplicate the transcript.** The transcript is shared by every connection, but each
  connection projected the agent's events into it again — so with a second window (or another device) every thought was
  repeated word by word, a finished message appeared twice, and a tool whose call id was re-bound stayed on the spinner
  forever, leaving the turn stuck on **Working for …**. Each event is now projected once, whichever client receives it.

## 0.9.4 — 4 October 2026

The file picker stops waving a badge at you every few seconds.

### Fixed

- **The “File picker: N workspace files.” toast no longer reappears forever.** The chat re-reads the workspace
  file list on a timer, and the VS Code host raised a notification for every one of those answers — so the toast
  flashed back about every four seconds. The count is still written to the **Morse** output log, where it is there
  when a picker looks empty; the browser host was already this quiet.

## 0.9.3 — 4 October 2026

The VS Code chat stops repeating a host error it cannot fix.

### Fixed

- **The transcript no longer fills with “VS Code does not implement \"gitStatus\"”.** VS Code has native Source
  Control and does not implement the `gitStatus` host command, but the background file poll asked for it anyway —
  so a red row was appended every few seconds, forever. The working tree is now only read from a host that
  advertises git (the browser host), exactly as the git panel already was; the `@` file picker in VS Code is
  unchanged.

## 0.9.2 — 4 October 2026

A long line in the diff stays on its own side of the split.

### Fixed

- **A wide line no longer runs under the other column.** In the **Split** diff, a line longer than its half painted
  past the divider and crossed into the new side; it now wraps onto the next visual line, and both halves grow
  together so the old/new pairing stays one row. The **Unified** diff wraps the same way.

## 0.9.1 — 4 October 2026

A mention is a reference again, not an editor tab.

### Fixed

- **Choosing a file with `@` no longer forces its preview open.** Pressing Enter on a picker row now just inserts
  the `@path` mention, so tagging a file for the agent never steals the view from the conversation. To mention a
  file **and** quote a line range, press **Shift+Enter** or click the row's **`⧉`** — the file opens so a range can
  be dragged into the prompt.

## 0.9.0 — 4 October 2026

Follow-ups you can see, and changes you can quote straight from the diff.

### New

- **Queued follow-ups.** While the agent is working, a follow-up waits in a **Queued messages** card above
  the composer instead of disappearing into pi's invisible queue: edit one back into the composer, send it now
  (as a steer), or remove it. They run one per finished turn, and steer still lands in the turn immediately.
- **Quote a change from the diff.** In the **Unified** and **Split** diff, click a changed block to pin its line
  range to the next message — the same chip a dragged range in the **File** view makes — and click it again to
  unpin. Only changes are clickable; context and hunk headers are not.

### Fixed

- **Clicking *New session* no longer starts a fake `pi` session named “draft”.** The draft tab was activated as
  a real session, which made `pi` exit and showed a misleading “the pi coding agent is not installed” screen.

### Changed

- **The Explorer no longer repeats the project name** above the file tree; the tree already is that project.

## 0.8.2 — 4 October 2026

The git panel bends to the window, and a crowded commit reads clearly.

### New

- **Resize the git panel.** Drag its left edge to widen it toward the conversation, so the graph gets the room
  instead of only the full-screen toggle. The width is remembered, and a double-click on the edge goes back to
  the default.

### Fixed

- **A commit several branches point at no longer crowds its row.** It shows one branch chip and a `+N` (three
  in the expanded view); hovering the `+N` names the rest, and a long branch is ellipsised instead of pushing
  the hash and the age out.

## 0.8.1 — 4 October 2026

Motion, so a busy graph and a running session read at a glance.

### Improved

- **The git graph flows.** A light pulse travels down each lane, so history reads as movement rather than a
  static diagram.
- **Empty git sections animate.** *No uncommitted changes* and *No commits yet* are centred marks that breathe
  instead of a line of plain text.
- **A streaming session is visible from its tab.** An open session whose agent is producing a turn shows a
  spinner on its tab even when another session or a file is in front — and it stops the moment the turn ends.

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
