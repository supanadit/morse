# Morse — the Pi coding agent, as a chat panel in VS Code

[![VS Marketplace](https://img.shields.io/badge/VS%20Marketplace-Install-0e639c)](https://marketplace.visualstudio.com/items?itemName=supanadit.morse)
[![Open VSX](https://img.shields.io/badge/Open%20VSX-Install-9a5cd0)](https://open-vsx.org/extension/supanadit/morse)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/supanadit/morse/blob/master/LICENSE)
[![CI](https://github.com/supanadit/morse/actions/workflows/ci.yml/badge.svg)](https://github.com/supanadit/morse/actions/workflows/ci.yml)

Your [Pi](https://github.com/earendil-works/pi) agent already has the models, credentials, tools, sessions and
context files you set up. **Morse gives all of it a real interface** — a chat panel beside your code, not a
terminal TUI. It drives your existing `pi` installation over RPC: nothing is re-implemented, no API key is ever
stored by the extension, and a session started in the terminal shows up here (and vice versa).

![Morse in VS Code](https://raw.githubusercontent.com/supanadit/morse/master/docs/assets/demo-vscode.gif)

## Why Morse

- **It is your Pi, not a walled garden.** Morse spawns `pi --mode rpc` in your workspace and reads/writes the
  same `~/.pi` sessions. Switch to the terminal and back and it is the same conversation.
- **No keys, no telemetry.** Prompts go wherever *your* pi configuration sends them. The extension itself talks
  only to the local `pi` process.
- **Two hosts, one behaviour.** The same chat runs in a browser served by a small NestJS host — the same core,
  protocol and frontend, maintained once. (See **Without VS Code** below.)
- **Free, and it stays free.** No account, no paid tier, no plan for one.

## Features

- **A chat panel that streams** — answers, thinking blocks and tool calls as they arrive. Tool calls render as a
  compact, expandable tree by default (one summary line per turn, steps and files nested under it); the legacy
  timeline is one toggle away. Long sessions page their history.
- **Many sessions, many projects, kept warm** — one `pi` process per session, LRU-capped
  (`morse.sessions.hotLimit`, default 4). Switching projects or reloading the window reattaches instead of
  respawning, and an **In progress** section lifts the sessions working right now.
- **Steer while it works** — send a `steer` or queue a follow-up (`Queued messages`: edit, send now, remove)
  instead of being refused mid-run. Stop it with one click.
- **Edit or fork what was sent** — edit-and-resend forks before a past prompt and sends the rewrite; fork
  branches there and hands the prompt back to the composer. The old branch stays resumable.
- **Model & thinking control that follows Pi** — pick from the models your pi is configured with; the thinking
  picker mirrors exactly the levels the *current model* supports in Pi's TUI, and re-reads them when you switch
  models. A model added to `models.json` shows up when you open the picker — no reload, no restart.
- **Manage your MCP servers** — the MCP indicator in the chat toolbar lists every server pi sees for the
  workspace, with its connection state, tools and errors, and lets you add, remove, enable or disable one. In
  project scope, disabling a user-level server writes a project override, exactly like Pi's own `/mcp`.
- **Context the way VS Code has it** — the active file, selection and open editors are attached to the prompt.
  Selecting text shows a live chip whose line numbers follow your drag; click it to lock (new selections then
  make new chips), or run **Morse: Attach Selection to Next Prompt**. Drag, drop and paste images too.
- **`@mention` anything** — a gitignore-aware picker for files *and* directories (`@docs/` drills in), opened
  with `+` or by typing `@`.
- **Prompt templates with a form** — a `/<template>` opens a generated form with a live preview; a template file
  added or edited shows up without restarting pi.
- **Native questions** — when pi (or one of its extensions) asks for input, Morse shows a QuickPick, InputBox or
  confirmation instead of a wall of text.
- **Keyboard first** — `Ctrl+Alt+…` (`⌘⌥…` on macOS) starts a session, searches sessions, changes the model or
  thinking level, and compacts context; `?` prints the whole list, and the command palette runs everything from
  one field.
- **Context compaction** — shrink the conversation from the panel, with a confirmation before Pi replaces what
  it remembers.

## Requirements

- The `pi` CLI, installed and authenticated (`pi --version`). If it is not on `PATH`, set `morse.pi.path`.
- VS Code 1.138 or newer.

## Getting started

1. Install this extension.
2. Open the **Morse** icon in the activity bar, or run **Morse: Open Chat**.
3. Ask a question — the first run starts a `pi` process in the current workspace.

If the panel reports the agent is unavailable, run **Morse: Show Log** for the exact reason — usually a missing
`pi` binary or an unauthenticated provider.

## Settings

| Setting | Default | Description |
|---|---|---|
| `morse.pi.path` | `""` | Path to the `pi` executable. Empty uses `pi` from `PATH`. |
| `morse.pi.entry` | `""` | Run a pi RPC entry (`dist/bundle/rpc-entry.js`) with node instead of the binary. |
| `morse.pi.sessionDir` | `""` | Override the session directory (`pi --session-dir`). |
| `morse.pi.noSession` | `false` | Run without persisting a session. |
| `morse.pi.extraArgs` | `[]` | Extra arguments passed to pi. |
| `morse.pi.requestTimeoutMs` | `30000` | Per-request RPC timeout. |
| `morse.sessions.hotLimit` | `4` | How many sessions stay alive at once (LRU); the rest stay resumable from their session files. |

## Commands

| Command | Description |
|---|---|
| `Morse: Open Chat` | Focus the chat panel. |
| `Morse: New Session` | Start a fresh pi session. |
| `Morse: Attach Selection to Next Prompt` | Lock the current selection (same as clicking its live chip). |
| `Morse: Show Log` | Open the Morse output channel. |

## Privacy

Morse talks to your local `pi` process. Prompts and responses go wherever your pi configuration sends them
(your configured provider, or a local model). The extension itself sends nothing anywhere and stores no
credentials. Anything you attach as context — the current file name, the selected text, a dragged image — is
included in the prompt, so review it before sending.

## Without VS Code

The same chat UI and the same agent are available as a browser app served by a small NestJS host, for people who
do not want an editor open:

```bash
npm install -g @supanadit/morse-web
morse start
```

See [`@supanadit/morse-web`](https://www.npmjs.com/package/@supanadit/morse-web).

## Learn more

- [Repository and full README](https://github.com/supanadit/morse)
- [Install guide](https://github.com/supanadit/morse/blob/master/docs/INSTALL.md)
- [Configuration](https://github.com/supanadit/morse/blob/master/docs/CONFIGURATION.md)
- [What is implemented, and what is not](https://github.com/supanadit/morse/blob/master/docs/STATUS.md)

## License

[MIT](https://github.com/supanadit/morse/blob/master/LICENSE) © 2026 Supan Adit Pratama
