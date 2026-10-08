# A layered, feature-sliced structure inside `@morse/ui-angular`

- **Date:** 2026-10-08
- **Status:** Design — approved in chat, awaiting spec review
- **Scope:** `packages/ui-angular` (source layout, import paths, tests, docs)
- **Related:** `docs/ARCHITECTURE.md`, `docs/FRONTENDS.md`, `packages/ui-angular/AGENTS.md`,
  `packages/ui-runtime/AGENTS.md`

## Context

`docs/ARCHITECTURE.md` already applies Clean Architecture v4 across the monorepo (rules R1–R10,
"so the structure can be audited rather than trusted"). That rigour stops at the package boundary:
`packages/ui-angular` is documented as one thing — "frontend presentation" — and inside it there is no
layer map at all. The result is a tree a reader has to reverse-engineer.

Measured on the graph (non-spec imports, `packages/ui-angular/src/app/`):

| Direction | Edges | Reading |
| --- | --- | --- |
| `chat → core` | 62 | every surface reaches into one bucket |
| **`core → core`** | 37 | `core` depends on itself across modules |
| `chat → chat` | 32 | sub-features of `chat` import each other directly |
| `nav/palette/shortcuts/git/about/agent/boot → core` | 41 | same bucket, again |
| `chat → shared` | 11 | |
| **`shared → core`** | 1 | "shared" is not a lower layer: `enter.directive` imports `core/animation.service` |

Highest fan-in: `core/morse.service.ts` 31, `core/workspace-tabs.ts` 19, `core/shortcuts.ts` 15,
`core/shell-state.ts` 12, `core/attachments.ts` 10, `shared/enter.directive.ts` 9,
`core/animation.service.ts` 8.

`core/` (27 files, +3 in `shared/`) is therefore "everything": the host client binding, app-local
signal stores, use-cases, DI tokens, and DOM primitives (`animation.service`, `drop-zone`,
`drop-flight`, `popover-fit.directive`) in one folder. `chat/` is not "chat" either: it holds 24 flat
subfolders, of which only some are the conversation — the terminal, MCP manager/editor, prompt
editor, task board, tab strip, bottom panel and session page are not.

This spec gives the frontend its own layer map and a tree that matches it. It is the first of four
axes the design review identified; the other three are explicitly out of scope (see *Out of scope*).

## Goal

`packages/ui-angular` reads as layers with one dependency direction, and as features a reader can
find without grep.

### Success criteria

- Every file under `src/app/` sits in the layer or feature it belongs to, per the maps below.
- The dependency direction is one-way and acyclic, stated as rules in `packages/ui-angular/AGENTS.md`
  and `docs/ARCHITECTURE.md`.
- No behavioural change, no wire change, no `PROTOCOL_VERSION` bump.
- `npm run build`, `npm run test:fast` and `npm run sync-webview` pass.

## Non-goals

- **No component consolidation** (axis 2 of the review): the 6 pickers, the 13 hand-rolled backdrops
  and the repeated Escape handlers stay as they are. Only folder placement changes.
- **No decomposition of the large components** (axis 3): `file-preview.ts` (2 076 lines),
  `chat-composer.ts` (1 934), `git-panel.ts` (1 568), `workspace-tabs.ts` (1 412),
  `chat-transcript.ts` (1 209) and `app.ts` (719) keep their internals.
- **No shell-layout redesign** (axis 4): `app.ts`/`app.html` may move to `shell/`, but its content,
  signals and template are not rewritten.
- No automated boundary check. Enforcement is **documentation + review** (the owner's choice);
  no ESLint rule, no dependency-cruiser, no CI job.
- No new package and no move to `@morse/ui-runtime`. The framework-free extraction was a previous,
  separate change.
- No change to `@morse/protocol`, `@morse/core`, `@morse/host-runtime`, `@morse/adapter-pi-rpc`,
  `packages/extension` or `packages/server`.
- No commit or push is part of this work (see the root `AGENTS.md`).

## Confirmed decisions

1. **Focus:** axis 1 only — foundation/taxonomy.
2. **Shape:** the hybrid tree ("Opsi 3"): a layered backbone (`host`, `state`, `services`, `ui`) plus a
   feature-sliced view layer (`features/`), with `shell/` and `routing/` as composition.
3. **Enforcement:** documentation + manual review.
4. **Host seam (C1):** the client binding moves *below* state, into its own `host/` layer. This is what
   breaks the measured `state ↔ services` cycle (see *Why `host/` exists*).

## Target structure

```
packages/ui-angular/src/
  main.ts                 # bootstrap (stays; imports updated)
  styles.css              # theme (stays)
  index.html              # (stays)
  app/
    host/                 # the seam to a host: the port + the client binding over it
    state/                # app-local reactive state (Angular signals), no I/O, no DOM
    services/             # use-cases and adapters (host/browser I/O)
    ui/                   # Angular/DOM primitives and presentational atoms
    features/             # the view layer, one folder per surface domain
      chat/
      workbench/
      surfaces/
      nav/
      git/
      overlays/
      screens/
    shell/                # the App: layout composition
    routing/              # hash route table + DI providers
```

## Layer rules (R-U)

The layers, inner → outer:

```
host < state < services < ui < features < shell < routing
```

Each arrow below means *depends on*, so dependencies point inward and never back out:

```
routing → shell → features → ui → services → state → host
```

- **R-U1** — A layer may depend only on layers to the right of it in
  `routing → shell → features → ui → services → state → host`, and may skip layers; it may never depend
  on a layer to its left.
- **R-U2** — `features/x` never imports `features/y`. Sharing goes through `state/`, `services/`, `ui/`
  or `@morse/ui-runtime`.
- **R-U3** — `ui/` imports nothing from `features/`, `shell/` or `routing/`.
- **R-U4** — `services/` imports nothing from `ui/` (this is what keeps the chain acyclic).
- **R-U5** — `state/` imports nothing from `services/`; it talks to the host through `host/`.
- **R-U6** — `host/` imports only `@morse/protocol`, `@morse/ui-runtime` and files in `host/`.
- **R-U7** — Only `shell/` and `routing/` may import from more than one feature.
- **R-U8** — Any layer may import `@morse/protocol` and `@morse/ui-runtime` freely: those are the
  framework-free core, which sits below `host`.

### Why `host/` exists

`MorseService` is the app's binding to the `@morse/ui-runtime` client, and it depends only on
`transport.token`. Five state stores inject it (`git-panel-state`, `mcp-state`,
`prompt-templates-state`, `workspace-files`, `workspace-tabs`), while many services inject state
(`queue-drain`, `workbench-persistence`, `uploads`, `notifications`, `shortcuts`, …). With the client
inside `services/`, `state ↔ services` is a layer-level cycle. Lifting the client (and the
persistence facade that sits on the same port) into `host/` makes the order strictly one-way.

## Layer mapping

### `app/host/` — the host seam (3)

| Target | Source |
| --- | --- |
| `host/transport.token.ts` | `core/transport.token.ts` |
| `host/morse.service.ts` | `core/morse.service.ts` |
| `host/view-state.ts` | `core/view-state.ts` |

### `app/state/` — app-local reactive state (14)

| Target | Source |
| --- | --- |
| `state/shell-state.ts` | `core/shell-state.ts` |
| `state/panel-state.ts` | `core/panel-state.ts` |
| `state/git-panel-state.ts` | `core/git-panel-state.ts` |
| `state/mcp-state.ts` | `core/mcp-state.ts` |
| `state/workspace-tabs.ts` | `core/workspace-tabs.ts` |
| `state/workspace-files.store.ts` | `core/workspace-files.ts` (split — see below) |
| `state/terminal-store.ts` | `core/terminal-store.ts` |
| `state/attachments.ts` | `core/attachments.ts` |
| `state/composer-drafts.ts` | `core/composer-drafts.ts` |
| `state/queued-prompts.ts` | `core/queued-prompts.ts` |
| `state/prompt-templates-state.ts` | `core/prompt-templates-state.ts` |
| `state/display-prefs.ts` | `core/display-prefs.ts` |
| `state/notification-prefs.ts` | `core/notification-prefs.ts` |
| `state/boot-handoff.ts` | `core/boot-handoff.ts` |

### `app/services/` — use-cases and adapters (9)

| Target | Source |
| --- | --- |
| `services/queue-drain.ts` | `core/queue-drain.ts` |
| `services/workbench-persistence.ts` | `core/workbench-persistence.ts` |
| `services/update.ts` | `core/update.ts` |
| `services/uploads.ts` | `core/uploads.ts` |
| `services/workspace-files.service.ts` | `core/workspace-files.ts` (split — see below) |
| `services/shortcuts.catalog.ts` | `core/shortcuts.ts` (split — see below) |
| `services/shortcut.service.ts` | `core/shortcuts.ts` (split — see below) |
| `services/run-notifier.ts` | `core/notifications.ts` (split — see below) |
| `services/notification-channel.ts` | `core/notifications.ts` (split — see below) |

### `app/ui/` — Angular/DOM primitives and presentational atoms (8)

| Target | Source |
| --- | --- |
| `ui/animation.service.ts` | `core/animation.service.ts` |
| `ui/drop-zone.ts` | `core/drop-zone.ts` |
| `ui/drop-flight.ts` | `core/drop-flight.ts` |
| `ui/popover-fit.directive.ts` | `core/popover-fit.directive.ts` |
| `ui/enter.directive.ts` | `shared/enter.directive.ts` |
| `ui/confirm-dialog.ts` | `shared/confirm-dialog.ts` |
| `ui/markdown/markdown.ts` | `shared/markdown/markdown.ts` |
| `ui/shortcut-keys.ts` | `core/shortcuts.ts` (split — see below) |

`shared/` is dissolved by this map; the reverse `shared → core` edge disappears because both files
now live in the same layer.

## The three splits

Each split separates one unit that holds two responsibilities. Behaviour is unchanged; only where
the code lives and how the two halves reach each other changes.

### `workspace-files` — data vs. the poller

`core/workspace-files.ts` (250 lines) holds both an observable tree and the timer/HTTP logic that
fills it.

- `state/workspace-files.store.ts` — `WorkspaceFilesStore`: the `cache`/`loading`/`statuses`/`failure`
  signals, their `asReadonly()` views, and setters. No `MorseService`, no timer.
- `services/workspace-files.service.ts` — `WorkspaceFiles`: `available`/`gitAvailable` computeds, the
  two `effect`s, `poll`, `needsFreshList`, `ensureLoaded`, `load`, `refresh`, `stage`/`unstage`, and the
  pure helpers `workingTreeSignature`/`asFiles`. Writes into the store.

Consumers: a surface that only **reads** the tree injects the store; one that calls `refresh()`,
`stage()` or `unstage()` injects the service.

### `shortcuts` — catalogue, registry, DOM binding

`core/shortcuts.ts` (423 lines) holds the action catalogue and its labels, the owner-bound handler
registry, and the `document` key listener.

- `services/shortcuts.catalog.ts` — the types (`ActionId`, `LocalKeyId`, `ShortcutId`,
  `ShortcutGroup`, `Binding`, `ShortcutBase`, `ManagedShortcut`, `LocalShortcut`, `ShortcutSpec`), the
  `SHORTCUTS` table, and the pure helpers (`isManagedShortcut`, `isApple`, `bindingLabel`, `matches`,
  `matchesOne`, `isEditable`, `asBindings`).
- `services/shortcut.service.ts` — `ShortcutService`: the handler `Map`, the `revision` signal,
  `catalog`, `available`, `bind`, `run`, `bump`, and `dispatch(event)` (the decision half of the old
  `onKeydown`).
- `ui/shortcut-keys.ts` — the DOM adapter: attach/detach
  `document.addEventListener('keydown', …, true)`, forwarding each event to `ShortcutService.dispatch`.

### `notifications` — policy vs. delivery

`core/notifications.ts` (212 lines) holds both the "a run finished, should we tell the reader?" policy
and the browser/host delivery.

- `services/run-notifier.ts` — `RunNotifier`: the streaming diff over `morse.sessionActivity()`, the
  `NotificationPrefs` gate, `looking()`, `body()`, `optIn()`, and the `permission` signal. Its in-app
  toast fallback stays here, using `AttachmentStore.say` (services → state is allowed).
- `services/notification-channel.ts` — the delivery helpers: `readPermission`, `queryPermission`, the
  focus/visibility refresh registration, `webNotify`, and the host-notify call. The `RunNotifier`
  decides; the channel sends. Both live in `services/` deliberately: that is what keeps `services ⊥ ui`
  (R-U4) and the chain acyclic.

## Feature mapping

`features/` is sliced by role in the layout. Folder and file names lose a redundant prefix
(`chat-…` inside `features/chat/`); exported class names and `morse-…` selectors do **not** change.

### `features/chat/` — the conversation column

```
features/chat/
  header/            ← chat/chat-header/chat-header.ts
  empty/             ← chat/empty-session/empty-session.ts
  interaction/       ← chat/interaction-panel/interaction-panel.ts
  tasks/             ← chat/task-overlay/task-overlay.ts
  pi-ui/             ← chat/pi-ui/pi-ui.ts
  transcript/
    transcript.ts    ← chat/chat-transcript/chat-transcript.ts
    tool-group/      ← chat/tool-group/   (tool-group.ts, task-board.ts)
    pin-annotation/  ← chat/pin-annotation/
    prompt-rail/     ← chat/prompt-rail/
  composer/
    composer.ts      ← chat/chat-composer/chat-composer.ts
    model-picker/    ← chat/model-picker/   (model-picker.ts, model-inputs.ts)
    thinking-picker/ ← chat/thinking-picker/
    command-picker/  ← chat/command-picker/
    file-picker/     ← chat/file-picker/
    usage/           ← chat/usage/usage-indicator.ts
    prompt-template-dialog/ ← chat/prompt-template-dialog/
```

### The other six features

| Target | Source |
| --- | --- |
| `features/workbench/tab-strip/` | `chat/tab-strip/` |
| `features/workbench/file-preview/` | `chat/file-preview/` |
| `features/workbench/bottom-panel/` | `chat/bottom-panel/` |
| `features/workbench/terminal/` | `chat/terminal/` |
| `features/surfaces/mcp-editor/` | `chat/mcp-editor/` (`mcp-editor.ts`, `mcp-editor-page.ts`) |
| `features/surfaces/prompt-editor/` | `chat/prompt-editor/` (`prompt-editor.ts`, `prompt-editor-page.ts`) |
| `features/surfaces/session-page/` | `chat/session-page/` |
| `features/nav/session-nav/` | `nav/session-nav/` |
| `features/nav/file-explorer/` | `nav/file-explorer/` |
| `features/nav/project-picker/` | `nav/project-picker/` |
| `features/nav/project-filter/` | `nav/project-filter/` |
| `features/git/git-panel/` | `git/git-panel.ts` |
| `features/git/branch-picker/` | `git/branch-picker/` |
| `features/overlays/command-palette/` | `palette/command-palette.ts` |
| `features/overlays/shortcuts-dialog/` | `shortcuts/shortcuts-dialog.ts` |
| `features/overlays/about/` | `about/` (`about-dialog.ts`, `credits.ts`) |
| `features/overlays/mcp-panel/` | `chat/mcp-panel/` |
| `features/screens/boot-splash/` | `boot/boot-splash.ts` |
| `features/screens/connection-screen/` | `connection/connection-screen.ts` |
| `features/screens/agent-screen/` | `agent/agent-screen.ts` |

Rationale for each move is the *role in the layout* of `app.html`: the chat column, the browser host's
tabbed chrome (`workbench`), route-mounted surfaces (`surfaces`, matching `routes.ts`), the sidebar
(`nav`), the right column (`git`), app-level modals (`overlays`), and full-screen states (`screens`).

### Composition

- `app/shell/` ← `app.ts`, `app.html`, `app.css`, `app.spec.ts`, `app.bottom-panel.spec.ts`,
  `app.embedded.spec.ts`, `app.session-tabs.spec.ts`.
- `app/routing/` ← `routes.ts`, `app.config.ts`, `routes.spec.ts`.
- `src/main.ts` stays; its imports of `routes`/`app.config` are updated.

## Migration strategy

One step per layer; **each step ends green**; every file moves with `git mv` so history follows, and
its importers are rewritten in the same step. No behaviour change, no wire change, no commit.

**Gate per step:** `npm run build -w @morse/ui-angular`, then
`npm run test -w @morse/ui-angular`.

| # | Step | Contents |
| --- | --- | --- |
| 1 | `host/` | the 3 files; update importers |
| 2 | `state/` | the 13 straight moves (not `workspace-files`) |
| 3 | `services/` | `queue-drain`, `workbench-persistence`, `update`, `uploads` |
| 4 | `ui/` | the 4 core primitives + fold in the 3 `shared/` files |
| 5 | split `workspace-files` | store + service; repoint consumers |
| 6 | split `shortcuts` | catalogue + service + `ui/shortcut-keys` |
| 7 | split `notifications` | `run-notifier` + `notification-channel` |
| 8 | `features/chat/` | nest `transcript/` and `composer/`; drop the `chat-` prefix |
| 9 | the other features | `workbench`, `surfaces`, `nav`, `git`, `overlays`, `screens` |
| 10 | `shell/` + `routing/` + docs | `shell/`, `routing/`, then the documentation pass |

Inner-first ordering (1–4) means each importer is rewritten once, and once `host/`/`state/`/`services/`/
`ui/` are in place, the feature moves are pure path changes against stable targets.

**Final gate:** `npm run build`, `npm run test:fast`, `npm run sync-webview`, plus a verification grep
asserting: no import of the old `core/` or `shared/`; `services/` imports no `ui/`; `state/` imports no
`services/`; no `features/x → features/y`.

### Documentation (step 10)

- `packages/ui-angular/AGENTS.md` — rewrite **Overview** around the layers, add R-U1–R-U8 under a new
  *Layers* heading, and repoint the **When stuck**/**Gotchas** path citations.
- `docs/ARCHITECTURE.md` — a new section *Inside a frontend* carrying the layer map and R-U1–R-U8.
- `docs/FRONTENDS.md` — state the layer order as the shape a second frontend should follow.
- root `AGENTS.md` — add the `ui-angular` layer map to *Where new code goes*.
- Fix stale path citations: `packages/server/AGENTS.md`, `packages/host-runtime/AGENTS.md`,
  `docs/DEVELOPMENT.md`.

## Definition of done

- `src/app/` = `host/ state/ services/ ui/ features/ shell/ routing/`; `features/` = `chat/ workbench/
  surfaces/ nav/ git/ overlays/ screens/`.
- `npm run build` passes; `npm run test:fast` passes except the pre-existing
  `src/app/.../workspace-files.spec.ts` `listArgs` failure, which this work does not introduce and does
  not fix; `npm run sync-webview` regenerates the webview bundle.
- The layer and feature maps in this spec match the tree (spot-checked by the verification grep).
- R-U1–R-U8 are written down in `packages/ui-angular/AGENTS.md` and `docs/ARCHITECTURE.md`.

## Risks

| Risk | Mitigation |
| --- | --- |
| A missed importer after a move | `npm run build -w @morse/ui-angular` is a full type-check; every step runs it |
| The `state`/`services` cycle reappears through a new file | R-U4/R-U5 in the docs, checked in the final grep and in review |
| Splitting a store changes a consumer's surface | Keep the service's observable API (`files`, `busy`, `status`, `error`, `refresh`, …) reachable from the layer the consumer already uses; split step is its own gate |
| Feature renames break lazy `import()` specifiers | Step 9 updates the dynamic imports in `app.ts`, `routes.ts` and `routes.spec.ts` in the same step; the type-check catches any miss |
| Diff is large and entangled with unrelated work in the tree | Move-only steps (0-line diffs) keep review tractable; nothing is committed |

## Out of scope (tracked, not done here)

1. **Component consolidation** — one overlay/dialog/menu primitive and one shared picker; the 13
   backdrops and repeated Escape handlers.
2. **Decomposing the large components** — `app.ts`, `chat-composer`, `file-preview`, `git-panel`,
   `workspace-tabs`, `chat-transcript`.
3. **Shell-layout redesign** — the internals of `app.ts`/`app.html`.
