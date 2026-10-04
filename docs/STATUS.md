# Status

Morse **v0.4.0**. This page is the honest inventory of what ships. Everything else points here:
[`README.md`](../README.md) for the pitch, [`ARCHITECTURE.md`](ARCHITECTURE.md) for how it is built,
[`CONFIGURATION.md`](CONFIGURATION.md) for the knobs, [`FRONTENDS.md`](FRONTENDS.md) for the frontend contract.

## Shipped

### The conversation

- Markdown transcript with highlighted, copyable code blocks.
- A process timeline that interleaves tool calls and thinking, with per-step status and expandable details.
- Paged history for long sessions; a resumed session is seeded from the agent, never from a blank panel.

### While the agent works

- `steer`, follow-up and abort — steering lands in the running turn, while a follow-up is queued above the
  composer (`Queued messages`: edit, send now, remove) and runs once the current turn settles; a prompt sent
  mid-run with no mode is queued as a follow-up rather than refused.
- Compaction behind an explicit confirmation, optionally with custom instructions (`session/compact`).
- pi's interaction requests: native QuickPick/InputBox in VS Code, rendered inline in the browser.
- Failures surface as notices (`error` message) instead of a dead panel.

### Model and thinking level

- Pickers for both, applied to the running session through pi's `set_model` / `set_thinking_level`.
- This **is** the per-session model override. A session records its own model and thinking-level changes, and
  resuming it restores them, so the choice follows that session across eviction, resume and host restart
  without touching pi's defaults for new sessions.
- A brand-new, empty panel probes an untouched pi spawn (pi `--no-session`) for the real model and command
  catalog, so the first picker is populated before any session exists.

### Sessions and projects

- One `pi` process per session, kept warm LRU-style (`MORSE_HOT_SESSIONS`, default 4), so switching projects or
  reloading the page reattaches instead of respawning. A live session is a whole pi process (275–450 MB);
  the cap is the number to size a box by.
- Project browser with a searchable filter, session search, activate, close (retire the process) and delete
  (remove the session file, behind the host's own confirmation).
- The browser host allows any directory; the VS Code host advertises `capabilities.scope: 'workspace'` and
  filters projects and sessions to the workspace roots.

### Context you attach

- VS Code: editor selection plus a live selection chip that follows the caret while the user drags.
- Everywhere: drag/drop/paste images; browser uploads land next to the session and ride as `@mentions`.
- The `@mention` picker lists files **and** directories (`@docs/` drills in) and honours `.gitignore`.

### Editing what was sent

Forking — pi's `fork` primitive — is behind both:

- **Edit and resend** (`chat/edit`): fork before a past user message, discard that turn and everything after,
  then send the edited text as a fresh prompt. Attachment chips on the original ride along.
- **Fork** (`chat/fork`): the same fork without sending anything. The old branch stays resumable, the
  transcript re-homes onto the new (shorter) branch, and the forked prompt goes back to the composer.

Both are advertised as `capabilities.editMessage` / `capabilities.forkMessage`, so a backend without fork
support simply never shows the affordance.

### Keyboard, templates, updates, install

- One shortcut catalog (`packages/ui-angular/src/app/core/shortcuts.ts`) with a `?` list that prints exactly
  what is bound; an owner that is not mounted is shown as unavailable rather than promised.
- Prompt templates run from a generated form with a live preview; a template file added or edited shows up
  without restarting pi (`commands/refresh`).
- A newer released Morse is read once from the npm registry when the host advertises
  `capabilities.updateCheck` (`MORSE_UPDATE_CHECK=0` turns it off).
- The `@supanadit/morse-web` npm package ships the browser host as a daemon CLI
  (`morse start|status|logs|stop|restart`).

## Not built yet

- **Session rename** — sessions are named by pi and only by pi; Morse has no rename path on the wire.
- **A dedicated diff / review view** — tool-call diffs render inline in the timeline (`ToolDiff`), but there is
  no surface for reviewing, approving or rejecting a set of changes as a whole.
