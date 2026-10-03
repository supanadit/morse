# Morse — Pi coding agent for VS Code

Morse brings the [Pi](https://github.com/earendil-works/pi) coding agent into VS Code as a chat panel, instead
of a terminal TUI. It drives your existing pi installation: the same models, credentials, tools, sessions and
context files you already use on the command line.

## Features

- **Chat sidebar** — streaming answers, thinking blocks and tool calls rendered as cards with input/output.
- **Scoped to your window** — the navigation lists the sessions of the folders this window has open.
  (The browser host is the global variant: every project pi knows about.)
- **Sessions stay warm** — switch between sessions without respawning the agent, and resume any pi session with
  its history replayed (`morse.sessions.hotLimit`, default 4).
- **Context compaction** — shrink the conversation context from the panel.
- **Bring your own agent** — Morse starts `pi --mode rpc` in your workspace; nothing is re-implemented and no
  API keys are stored by the extension.
- **Same sessions** — sessions are read from and written to your pi session directory, so a conversation
  started with `pi` in the terminal can be listed and resumed here.
- **Steering** — keep typing while the agent works: send a steer or a follow-up, or stop it.
- **Model & thinking control** — pick from the models pi has configured, and set the thinking level.
- **Editor context** — the active file, selection and open editors are attached to the prompt. Selecting text
  shows a live chip in the composer whose line numbers follow the drag in real time; clicking it locks the
  selection (new selections then make new chips), and `Morse: Attach Selection to Next Prompt` still pins the
  current selection in one command.
- **Agent questions answered natively** — when pi (or one of its extensions) asks for input, Morse shows a
  QuickPick, InputBox or confirmation instead of a wall of text.

## Requirements

- The `pi` CLI, installed and authenticated (`pi --version`). If it is not on `PATH`, set `morse.pi.path`.
- VS Code 1.138 or newer.

## Getting started

1. Install the extension.
2. Open the Morse icon in the activity bar (or run **Morse: Open Chat**).
3. Ask a question. The first run starts a pi process in the current workspace.

If the panel reports that the agent is unavailable, open **Morse: Show Log** for the exact reason — usually a
missing `pi` binary or an unauthenticated provider.

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
credentials. Anything you attach as context — the current file name, the selected text — is included in the
prompt, so review it before sending.

## Without VS Code

The same chat UI and the same agent are available as a browser app served by a small NestJS host, for people
who do not want an editor open. See the repository README.

## Source

The extension is one of two hosts in the Morse monorepo; `@morse/core`, `@morse/protocol` and
`@morse/adapter-pi-rpc` are shared with the NestJS host, and the frontend is a swappable package.
