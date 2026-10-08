<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->
<!-- Last updated: 2026-10-07 | Last verified: 2026-10-07 -->

# AGENTS.md

Morse is a **Comfortable Pi Interface**: one chat frontend for the Pi coding agent, running in a VS Code webview
or in a browser served by NestJS. Two hosts, one core, one swappable frontend.
Reasoning: `docs/ARCHITECTURE.md` · UI contract: `docs/FRONTENDS.md`.

**Precedence:** the **closest `AGENTS.md`** to the files you are changing wins. This root carries global defaults
only — every package below has its own file with its own commands, conventions and symptoms.

## Commands (verified)
| Task | Command | Notes |
| --- | --- | --- |
| Build everything | `npm run build` | libs -> UI -> sync webview -> extension + server |
| Type-check | `npm run check-types` | tsc --noEmit everywhere; needs the libraries built |
| Lint | `npm run lint` | eslint (extension) |
| Tests (fast) | `npm run test:fast` | vitest, no display: host-runtime, ui-runtime, server, ui-angular |
| Tests (all) | `npm test` | + the VS Code integration test: downloads VS Code, needs a display |
| Package the VSIX | `npm run package` | refuses a development webview bundle |
| Build the npm artifact | `npm run build:web` | -> `packages/morse-web/dist` |
| Publish the npm package | `npm run publish:web` | `build:web`, then `npm publish -w @supanadit/morse-web` |
| Extension dev | `npm run dev:extension` | F5 prelaunch: build once, then watch extension + UI + webview |
| Server dev | `npm run dev:server` | NestJS: tsc --watch + node --watch |
| UI dev | `npm run dev:ui` | ng serve (:4200 may be taken -> --port 4321) |
| Sync the webview | `npm run sync-webview` | after any UI change |
| Pipeline check | `node packages/server/scripts/ws-smoke.mjs ws://127.0.0.1:4399/ws` | no model call |

**Done** = `build` + `check-types` + `test:fast` (+ `npm run sync-webview` when the UI changed). CI
(`.github/workflows/ci.yml`) runs exactly that, plus `npm pack -w @supanadit/morse-web --dry-run`; its second job
adds the VS Code test under `xvfb-run`. Node 24; `npm ci` compiles node-pty (needs g++/make/python3).

## Layout (imports point inward only)
```text
core, protocol      pure                ports live in core/src/*/service.ts, never in domain.ts
host-runtime        host glue           -> protocol + core types
adapter-pi-rpc      pi subprocess       -> core
ui-runtime          transports + client -> protocol
ui-angular          Angular views       -> protocol, ui-runtime
extension, server   composition roots   -> everything
morse-web           npm delivery        bundles server + ui-angular; ships the `morse` CLI
```
Adapters never import each other; only the composition roots wire them.

## Conventions
- **ESM everywhere except the extension bundle** (esbuild -> CJS). Libraries and the server need explicit `.js`
  in relative imports.
- **UI state comes only from `reduceSessionView`**, and a frontend reads `capabilities` instead of guessing.
- **A wire change means bumping `packages/protocol/src/version.ts`** and rebuilding the UI.
- **Frontend = static bundle + `webview.manifest.json`**; hosts only compare `protocolVersion`.
- **NestJS: explicit `@Inject(...)` on every constructor parameter.**
- **pi framing**: split on LF only, strip CR, no `readline`, `StringDecoder`; stderr is logs only.
- **`overrides` in a workspace package are ignored** — only the root `package.json` is honoured.

## Where new code goes
| Need | Goes to |
| --- | --- |
| a use case | `packages/core/src/<module>/service.ts` |
| a port | the module that owns its lifetime (never `core/src/domain.ts`) |
| a pi command, or a new pi file | `packages/adapter-pi-rpc` |
| new UI data | `packages/protocol` + `packages/host-runtime/src/session-controller.ts` |
| a component or view-local state | `packages/ui-angular` — the layer or feature it belongs to, per its `AGENTS.md` § *Layers* (`host`, `state`, `services`, `ui`, `features`, `shell`, `routing`) |
| a framework-free frontend helper | `packages/ui-runtime` |
| a new host or frontend | `docs/FRONTENDS.md` |

## Gotchas (cross-cutting)
| Symptom | Cause / fix |
| --- | --- |
| `overrides` in a workspace package ignored | only the root `package.json` is honoured |
| Webview blank after a UI change | run `npm run sync-webview` |
| `--frontend=x` silently ignored | npm drops flags on nested `npm run`; use `npm run sync-webview -- --frontend=x` |
| The symptom is not listed here | each package owns its own: `grep -rn "<symptom>" packages/*/AGENTS.md` |

## Boundaries
### Always
- Run the smallest relevant check after a change; `build` + `check-types` + `test:fast` before claiming done.
- Take a new UI data field through `@morse/protocol` first, then route it in `host-runtime`.
- Fix a symptom where its cause is, and write it into that package's `AGENTS.md` — a documented trap beats a
  clever fix.

### Ask first
- Adding a dependency (the purity rules below exist to keep the surface small).
- Changing a wire shape: it is a `protocolVersion` bump plus a UI rebuild.
- Changing a `MORSE_*` env var or a VS Code setting (`docs/CONFIGURATION.md` is the contract).

### Never
- Never commit or push unless the user asks in the current turn.
- Never send a real prompt to a model in tests — stop at `host/ready` / `get_state`.
- Never edit generated output: `packages/*/dist`, `packages/*/out`, `packages/extension/media/webview`,
  `packages/extension/.vscode-test`, `dist/*.vsix`.
- Never import `pi` at runtime (~436 MB) — always spawn `pi --mode rpc`.
- Never let `@morse/core` or `@morse/protocol` gain a dependency: no `vscode`, no NestJS, no `node:*`.

## Scoped AGENTS.md (MUST read when working in these directories)
| Directory | File | Covers |
| --- | --- | --- |
| `packages/protocol` | [AGENTS.md](./packages/protocol/AGENTS.md) | the wire contract, the version bump |
| `packages/core` | [AGENTS.md](./packages/core/AGENTS.md) | use cases, ports, the hot-session registry |
| `packages/host-runtime` | [AGENTS.md](./packages/host-runtime/AGENTS.md) | message routing, transcript, terminal port |
| `packages/ui-runtime` | [AGENTS.md](./packages/ui-runtime/AGENTS.md) | transports, mock host, prompt-template expansion |
| `packages/adapter-pi-rpc` | [AGENTS.md](./packages/adapter-pi-rpc/AGENTS.md) | pi subprocess, prompts, MCP, trust |
| `packages/server` | [AGENTS.md](./packages/server/AGENTS.md) | NestJS host: files, git, PTY, LSP, env |
| `packages/extension` | [AGENTS.md](./packages/extension/AGENTS.md) | VS Code host: webview CSP, panels, PATH |
| `packages/ui-angular` | [AGENTS.md](./packages/ui-angular/AGENTS.md) | views, app state, shortcuts, preview |
| `packages/morse-web` | [AGENTS.md](./packages/morse-web/AGENTS.md) | the npm artifact, the `morse` CLI |

> **Agents**: when you read or edit files in a listed directory, load its `AGENTS.md` first — it overrides this
> root, and it holds the symptoms for that area.

## Pointers
| Need | File |
| --- | --- |
| installing (VSIX + CLI) | `docs/INSTALL.md` |
| releasing (VSIX + npm) | `docs/RELEASING.md`, `.github/workflows/release.yml` |
| settings and environment | `docs/CONFIGURATION.md` |
| architecture and the rule map | `docs/ARCHITECTURE.md` |
| the frontend contract | `docs/FRONTENDS.md` |
| measured performance baseline | `docs/DEVELOPMENT.md` |
| packaging the npm artifact | `docs/PACKAGING.md` |
| what is shipped, and what is not | `docs/STATUS.md` |

## Terminology
| Term | Means |
| --- | --- |
| host | a composition root: `packages/server` (browser) or `packages/extension` (VS Code) |
| frontend | a view layer over the protocol: today `packages/ui-angular` |
| adapter | the pi subprocess driver: `packages/adapter-pi-rpc` |
| session vs draft | a draft tab has no real session yet — never send `session/activate` for it |
| capability | what a host says it can do (`HostCapabilities`); a frontend must not need more |
