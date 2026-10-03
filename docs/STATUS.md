# Status

## Implemented

The responsive two-pane shell (drawer on narrow surfaces), markdown transcripts with a process timeline that
interleaves tool calls and thinking, resumed history (paged for long sessions), steering / follow-up / abort,
model and thinking-level pickers, context compaction, **multiple sessions across multiple projects** (project
browser, activate/close, LRU-hot `pi` processes), native interaction handling in VS Code and inline handling in
the browser, editor selection as prompt context (live chips), drag/drop/paste attachments, the `@mention`
picker for files **and** directories, protocol version handshake, and error surfacing when `pi` cannot be
started.

The browser host also ships as a single installable npm package (`@supanadit/morse-web`) with a daemon CLI.

## Not built yet

- Diff / review views.
- Session rename and fork.
- Per-session model overrides.
