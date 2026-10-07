# Morse

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/supanadit/morse/actions/workflows/ci.yml/badge.svg)](https://github.com/supanadit/morse/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](package.json)

**A comfortable GUI for the [Pi](https://github.com/earendil-works/pi) coding agent** — a chat panel inside
VS Code, or a browser UI served by a small NestJS host.

Pi normally lives in your terminal as a TUI. Morse gives the same agent, models, tools and sessions a real
interface without reimplementing any of it: both hosts share one core, one wire protocol and one Angular
frontend, so there are two ways to run Morse and one behaviour to maintain.

## Demo

VS Code extension:

![Morse in VS Code](docs/assets/demo-vscode.gif)

Browser host:

![Morse in the browser](docs/assets/demo-web.gif)

Both clips run the same agent, transcript and protocol; only the host differs.

## How this is built

Morse started as a **vibe-coded prototype**: unengineered on purpose, written fast with an AI to answer
one question — is a real GUI around the Pi agent actually better than the terminal? It is, by a lot. That
is why the prototype is gone and this repository exists.

It also taught me the thing I build on now. AI writes code faster than I do and it does not think — not at
the maximum thinking level, not with the best model available. It cannot hold a goal for a week, weigh a
trade-off nobody told it about, or notice that the feature being asked for is the wrong feature. It is
extremely good at the part of the job that is typing, and typing was never the job.

I have tried the memory tooling that promises to fix that: context stores, note graphs, agents that
remember you. They help at the margins. What still beats all of it is one person who knows what they are
building and why, because a goal is not a fact you retrieve — it is a judgement you keep making.

So this is what Morse is built around: **change the way developers use AI, rather than depend on it**. You
can use Morse as a vibecoder and let an agent run a whole feature while you watch. But it is built for the
engineer who wants the controls — steer a running turn, abort it, edit a prompt the agent already answered
and send it again, read the diff before it is committed, watch the branch. The fundamentals stay yours and
AI multiplies them; it does not replace them, and it never takes the wheel.

That is not a licence for slop. Every layer has an owner and a contract, the purity rules are enforced
rather than aspirational, a wire change is a `protocolVersion` bump, and nothing lands without `build`,
`check-types` and `test:fast`. It stays free, and it will: no price, no paid tier, no plan for one.

## Highlights

- **Multiple sessions across multiple projects** — one `pi` process per session, kept warm (LRU), alive while
  you switch projects or reload the page. An **In progress** section lifts the sessions working right now, and
  a refresh reattaches and replays the transcript.
- **A real transcript** — markdown with highlighted, copyable code blocks; tool calls as a compact tree by
  default (one summary line per turn, steps and their files nested under it — the always-open timeline is one
  toggle away); thinking that streams as it arrives; paged history for long sessions.
- **Steer while it works** — `steer`, follow-up and abort. A prompt sent mid-run is queued as a follow-up
  above the composer (`Queued messages`: edit, send now, remove) rather than refused, and runs when the
  current turn settles. Context compaction is a click away, with a confirmation.
- **Model & thinking that follow pi** — pick any model pi is configured with; the thinking picker mirrors the
  levels the *current model* supports in pi's own TUI and re-reads them on every switch, and a model added to
  `models.json` appears when you open the picker — no reload, no restart.
- **Edit or fork what was sent** — edit-and-resend forks before a past prompt and sends the rewrite; fork
  branches there and hands the prompt back to the composer. The old branch stays resumable.
- **Attach context the way each host can** — editor selection and live selection chips in VS Code; drag, drop
  and pasted images everywhere; browser uploads land next to the session and ride as `@mentions`.
- **`@mention` anything** — a gitignore-aware picker for files *and* directories (`@docs/` drills in), opened
  with `+` or by typing `@`, with markdown formatting in your own prompts too.
- **Native interactions in VS Code** — pi's interaction requests become QuickPick/InputBox there, and are
  rendered inline in the browser.
- **Git, files and a terminal where there is no editor** — on the browser host, a git panel (commit list,
  branch graph, uncommitted changes), an Explorer and a terminal, with read-only previews, diff views, and
  line ranges you drag to pin into your next message. VS Code keeps its own Explorer, editor, Source Control
  and terminal.
- **Manage MCP servers** — an indicator in the chat toolbar opens a manager for the servers pi sees for the
  session's directory: their state, tools and errors, plus add, remove, enable and disable. In project scope,
  disabling a user-level server writes a project override — the same file pi's own `/mcp` writes.
- **Prompt templates with a form** — a `/<template>` opens a generated form with a live preview, and a
  template file added or edited shows up without restarting pi.
- **Keyboard first** — `Ctrl+Alt+…` (`⌘⌥…` on macOS) starts a session, narrows the sidebar to a project,
  changes the model or the thinking level, toggles the git panel (browser host), and opens the compaction
  question; `/` jumps to the session search and `?` prints the whole list.

## Pi stays yours

Morse is a frontend, not a fork: it drives the `pi` you already have installed, over pi's own `--mode rpc`,
and that is a deliberate choice rather than an implementation detail.

- **It never imports pi, bundles it or patches it** — no vendored SDK, no forked CLI, no plugin added to
  your pi, no change to how pi behaves. Your models, credentials, tools, MCP servers and sessions stay where
  pi put them, which is why a chat started in the terminal resumes here — and one started here resumes in
  the terminal.
- **Trying it costs you nothing you do not already have** — pi's SDK is about 436 MB installed, and a
  frontend that vendors it pays that again for every such app on your machine. Morse spawns the one `pi` on
  your `PATH`, so any number of RPC-based frontends can live side by side on a single pi — and uninstalling
  Morse leaves your pi exactly as it was.
- **Everything else here is Morse's own work** — the browser host adds an Explorer, a git panel and real
  terminal tabs; both hosts add an MCP manager, a template editor and previews backed by a real language
  server. Some of it goes well past what pi's TUI offers. None of it is asked of pi, and none of it changes
  it.

Pi's own files are the exception, and there are three: `mcp.json` for the MCP manager, `prompts/*.md` for
the template editor and `trust.json` for the project-trust prompt. Morse edits them in pi's formats, only
when you use the feature that owns them. The reasoning in full, with numbers, is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#why-rpc-subprocesses-and-not-the-sdk).

## Requirements

- Node.js 20+ (developed on 24) and npm 10+.
- The `pi` CLI installed and authenticated (`pi --version`), or a path to it via `morse.pi.path` /
  `MORSE_PI_PATH`.
- VS Code 1.138+ for the extension host.
- Morse reuses your existing pi configuration: models, credentials, tools and sessions under `~/.pi`.

## Install

### Browser host (npm)

```bash
npm install -g @supanadit/morse-web
morse start
```

```text
  ▲  Morse started
  │
  ◆  port 4399 (PID: 20880)
  │
  ●  visit: http://127.0.0.1:4399/
  ●  logs:  morse logs
  │
  └  daemon running — the terminal can be closed
```

`morse start --port 3020`, `morse status`, `morse logs --follow`, `morse stop`, `morse restart`. Add `--lan`
to bind `0.0.0.0` (the UI has no auth — trusted networks only, or put an authenticating proxy in front), and
`-f` to stay in the foreground for systemd or Docker.

### VS Code extension

Install it from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=supanadit.morse) or
from [Open VSX](https://open-vsx.org/extension/supanadit/morse) — the registry VSCodium, Cursor, Windsurf,
code-server and Theia install from — or build the VSIX yourself:

```bash
npm install
npm run package
code --install-extension dist/morse.vsix
```

Then open the **Morse** view in the activity bar. The full step-by-step for both hosts — Marketplace, local
tarballs, `npm link`, settings and troubleshooting — is in [`docs/INSTALL.md`](docs/INSTALL.md).

## Documentation

| Document | Contents |
|---|---|
| [`docs/INSTALL.md`](docs/INSTALL.md) | Installing both hosts: marketplaces (VS Code + Open VSX), VSIX, npm/tarball, `npm link`, troubleshooting |
| [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) | VS Code settings and the browser host's environment variables |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | Build/dev commands, F5, `?mock=1`, and the pipeline checks |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The two hosts, packages, ports and the layering rules |
| [`docs/FRONTENDS.md`](docs/FRONTENDS.md) | The frontend contract and how to add a React/Svelte/Vue one |
| [`docs/PACKAGING.md`](docs/PACKAGING.md) | How the browser host becomes one npm package, and how to publish it |
| [`docs/RELEASING.md`](docs/RELEASING.md) | Cutting a semver release: bump, tag, CI publish of the VSIX and npm package |
| [`docs/STATUS.md`](docs/STATUS.md) | What is implemented, and what is not built yet |

## License

[MIT](LICENSE) © 2026 Supan Adit Pratama
