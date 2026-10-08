# Layered structure inside `@morse/ui-angular` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize `packages/ui-angular/src/app/` into the layers `host state services ui features shell routing`, with a one-way dependency rule, without changing any behaviour.

**Architecture:** A pure move plus an import rewrite, layer-by-layer from the inside out (`host` → `state` → `services` → `ui` → `features` → `shell`/`routing`), with three behaviour-preserving splits (`workspace-files`, `shortcuts`, `notifications`) and a re-slice of `chat/`. Every file moves with `git mv` so history follows, and each task ends green.

**Tech Stack:** Angular (standalone components, signals), TypeScript, `@angular/build:unit-test` (vitest + jsdom), npm workspaces, Node 24.

**Spec:** `docs/superpowers/specs/2026-10-08-ui-angular-layered-structure-design.md` — read it with this plan; the move maps, the R-U rules and the rationale live there.

## Global Constraints

- **Behaviour is frozen.** No change to any component, store, directive, template or stylesheet beyond its path and its imports. No wire change; no `PROTOCOL_VERSION` bump.
- **Scope is `packages/ui-angular` plus docs.** Never edit `@morse/protocol`, `@morse/core`, `@morse/host-runtime`, `@morse/adapter-pi-rpc`, `packages/extension`, `packages/server`, `packages/ui-runtime`.
- **Never edit generated output:** `packages/*/dist`, `packages/*/out`, `packages/extension/media/webview`, `packages/extension/.vscode-test`, `dist/*.vsix`.
- **Relative imports in `ui-angular` stay extensionless** (TypeScript/bundler resolution). Do **not** add `.js` extensions — that rule belongs to `ui-runtime`.
- **Locate imports by the module specifier's basename, never by line number.** Line numbers in this plan go stale as soon as a task before it lands.
- **A component move always takes its siblings:** the `.html` template, the `.spec.ts`, and a `.css` if one exists.
- **Exported class names, member names and `morse-*` selectors never change.** Only folders and file basenames move.
- **No new dependencies.**
- **Gate per task:** `npm run build -w @morse/ui-angular` (its type-check), then `npm run test -w @morse/ui-angular`. Both must pass.
- **One pre-existing failure is expected and must stay the only one:** `packages/ui-angular/src/app/.../workspace-files.spec.ts` (`listArgs` polling). Do not fix it, do not add to it.
- **Do not commit or push.** The root `AGENTS.md` forbids it unless the owner asks in the turn. Each task ends with a **Checkpoint (recorded, not run)** note marking where a commit would go.
- **Final state:** `src/app/` = `host/ state/ services/ ui/ features/ shell/ routing/`; `features/` = `chat/ workbench/ surfaces/ nav/ git/ overlays/ screens/`; R-U1–R-U8 hold.

## Import rewrite procedure (used by every move task)

For a module moving from `old/path.ts` to `new/path.ts`:

1. Find importers: `rg -l "old/<basename>" packages/ui-angular/src`.
2. For each match, rewrite the relative specifier so it points at `new/path.ts`, recomputing the `../` depth for that file's location under `src/app/`.
3. Dynamic `import('...')` strings and `templateUrl`/`styleUrl` strings in the moved files are rewritten the same way.
4. The build (`npm run build -w @morse/ui-angular`) is the proof that no importer was missed.

## Review Focus

The failure modes this refactor can introduce that no unit test exercises, most likely first:

1. **A relative import rewritten to the wrong `../` depth** — the app fails to compile; caught by the build gate, but only if the build is actually run before the tests.
2. **A spec or `.html` left behind** — the suite stays green while the behaviour it covered silently stops being tested, or Angular fails on a missing template. Pin it: after tasks 8–9, the spec-file count under `features/` is unchanged from the pre-move count.
3. **A string path a type-check does not see** — `templateUrl`/`styleUrl` and the dynamic `import()` in `app.ts`/`routes.ts`. Pin it: task 9 and task 10 grep every `import(` and `templateUrl`/`styleUrl` and confirm the target exists.
4. **A cross-layer rule (R-U2/R-U4/R-U5) broken by the new files** — nothing fails; only review catches it. Pin it: task 11's greps.
5. **The `?mock=1` no-host path stops booting** — unit tests use the mock transport but not the dev bootstrap. Pin it: task 11 ends with `npm run sync-webview` and a fresh `npm run build`, and the manual `?mock=1` check is called out for the owner.

---

### Task 1: `host/` layer

**Files** (see spec *Layer mapping → `app/host/`*):
- Move: `src/app/core/{transport.token.ts,morse.service.ts,view-state.ts,view-state.spec.ts}` → `src/app/host/`

**Interfaces:**
- Consumes: nothing.
- Produces: `app/host/transport.token.ts` (`MORSE_TRANSPORT`, `HostTransport`), `app/host/morse.service.ts` (`MorseService`), `app/host/view-state.ts` (`ViewState`) — same exports as before, new path.

- [ ] **Step 1: Create the target directory**

Run: `mkdir -p packages/ui-angular/src/app/host`

- [ ] **Step 2: Move the files with `git mv`**

Run:
```bash
cd packages/ui-angular/src/app
git mv core/transport.token.ts host/transport.token.ts
git mv core/morse.service.ts   host/morse.service.ts
git mv core/view-state.ts      host/view-state.ts
git mv core/view-state.spec.ts host/view-state.spec.ts
```

- [ ] **Step 3: Rewrite every importer** using the procedure above for the three basenames (`transport.token`, `morse.service`, `view-state`). Do not change what is imported, only from where.

- [ ] **Step 4: Build**

Run: `npm run build -w @morse/ui-angular`
Expected: PASS (no unresolved import).

- [ ] **Step 5: Test**

Run: `npm run test -w @morse/ui-angular`
Expected: only the pre-existing `workspace-files.spec.ts` failure.

- [ ] **Step 6: Checkpoint (recorded, not run)**

Would commit: `refactor(ui): lift the host seam into app/host`.

---

### Task 2: `state/` layer (straight moves)

**Files** (spec *Layer mapping → `app/state/`*), 14 straight moves (`workspace-files` moves here too; Task 5 then splits it in place):

| From | To |
| --- | --- |
| `core/shell-state.ts` (+spec) | `state/shell-state.ts` |
| `core/panel-state.ts` (+spec) | `state/panel-state.ts` |
| `core/git-panel-state.ts` | `state/git-panel-state.ts` |
| `core/mcp-state.ts` (+spec) | `state/mcp-state.ts` |
| `core/workspace-tabs.ts` (+spec) | `state/workspace-tabs.ts` |
| `core/workspace-files.ts` (+spec) | `state/workspace-files.ts` |
| `core/terminal-store.ts` (+spec) | `state/terminal-store.ts` |
| `core/attachments.ts` (+spec) | `state/attachments.ts` |
| `core/composer-drafts.ts` (+spec) | `state/composer-drafts.ts` |
| `core/queued-prompts.ts` (+spec) | `state/queued-prompts.ts` |
| `core/prompt-templates-state.ts` | `state/prompt-templates-state.ts` |
| `core/display-prefs.ts` (+spec) | `state/display-prefs.ts` |
| `core/notification-prefs.ts` (+spec) | `state/notification-prefs.ts` |
| `core/boot-handoff.ts` | `state/boot-handoff.ts` |

**Interfaces:**
- Consumes: `app/host/*` (Task 1).
- Produces: the same store classes at `app/state/*`.

- [ ] **Step 1: Create the directory** — `mkdir -p packages/ui-angular/src/app/state`
- [ ] **Step 2: `git mv` each row above** (each `.ts` with its `.spec.ts`).
- [ ] **Step 3: Rewrite every importer** for the 14 basenames.
- [ ] **Step 4: Build** — `npm run build -w @morse/ui-angular` → PASS.
- [ ] **Step 5: Test** — `npm run test -w @morse/ui-angular` → only the pre-existing failure.
- [ ] **Step 6: Checkpoint (recorded, not run)** — `refactor(ui): move app-local state into app/state`.

---

### Task 3: `services/` layer (straight moves)

**Files** (spec *Layer mapping → `app/services/`*), 4 straight moves:

| From | To |
| --- | --- |
| `core/queue-drain.ts` (+spec) | `services/queue-drain.ts` |
| `core/workbench-persistence.ts` (+spec) | `services/workbench-persistence.ts` |
| `core/update.ts` (+spec) | `services/update.ts` |
| `core/uploads.ts` (+spec) | `services/uploads.ts` |

**Interfaces:**
- Consumes: `app/host/*`, `app/state/*`.
- Produces: `QueueDrain`, `WorkbenchPersistence`, `UpdateCheck`, `Uploader` (+ the `MAX_UPLOAD_BYTES`/`UploadedFile`/`UploadReport` exports) at `app/services/*`.

- [ ] **Step 1: Create the directory** — `mkdir -p packages/ui-angular/src/app/services`
- [ ] **Step 2: `git mv` each row.**
- [ ] **Step 3: Rewrite every importer** for the 4 basenames.
- [ ] **Step 4: Build** → PASS.
- [ ] **Step 5: Test** → only the pre-existing failure.
- [ ] **Step 6: Checkpoint (recorded, not run)** — `refactor(ui): move use-cases into app/services`.

---

### Task 4: `ui/` layer, dissolving `shared/`

**Files** (spec *Layer mapping → `app/ui/`*):

| From | To |
| --- | --- |
| `core/animation.service.ts` | `ui/animation.service.ts` |
| `core/drop-zone.ts` (+spec) | `ui/drop-zone.ts` |
| `core/drop-flight.ts` | `ui/drop-flight.ts` |
| `core/popover-fit.directive.ts` (+spec) | `ui/popover-fit.directive.ts` |
| `shared/enter.directive.ts` | `ui/enter.directive.ts` |
| `shared/confirm-dialog.ts` (+`.html`, +spec) | `ui/confirm-dialog.ts` |
| `shared/markdown/markdown.ts` (+spec) | `ui/markdown/markdown.ts` |

After this task `src/app/shared/` must not exist (confirm with `ls`).

**Interfaces:**
- Consumes: `app/services/*`, `app/state/*`, `app/host/*`.
- Produces: `AnimationService`, `DropZone`, `DropFlight`, `PopoverFit`, `EnterDirective`, `ConfirmDialog`, `Markdown`.

- [ ] **Step 1: Create the directory** — `mkdir -p packages/ui-angular/src/app/ui/markdown`
- [ ] **Step 2: `git mv` each row**, taking siblings (the `confirm-dialog.html`, the specs).
- [ ] **Step 3: Rewrite every importer** for the moved basenames and for `../shared/…` paths.
- [ ] **Step 4: Build** → PASS.
- [ ] **Step 5: Test** → only the pre-existing failure (the moved `markdown.spec.ts` and `popover-fit.spec.ts` now run from `ui/`).
- [ ] **Step 6: Checkpoint (recorded, not run)** — `refactor(ui): move DOM primitives into app/ui`.

---

### Task 5: Split `workspace-files` (data vs. poller)

**Files** (spec *The three splits → `workspace-files`*):
- Create: `src/app/state/workspace-files.store.ts`
- Create: `src/app/services/workspace-files.service.ts`
- Delete (after the split): `src/app/state/workspace-files.ts`
- Move + split: `src/app/state/workspace-files.spec.ts` → the two specs below

**Interfaces:**
- Consumes: `app/host/morse.service.ts` (`MorseService`), `@morse/protocol` (`GitStatus`), `@morse/ui-runtime` (`asGitStatus`).
- Produces:
  - `state/workspace-files.store.ts` → `WorkspaceFilesStore` with `files`, `busy`, `status`, `error` (readonly signal views) and setters the service calls (`setFiles`, `setBusy`, `setStatus`, `setError`).
  - `services/workspace-files.service.ts` → `WorkspaceFiles` with `available`, `gitAvailable`, `ensureLoaded`, `refresh`, `stage`, `unstage` — the same public API the old class had, minus the signal views the store now owns.

- [ ] **Step 1: Move the old source into the store half and add setters**

Create `state/workspace-files.store.ts` holding the `cache`/`loading`/`statuses`/`failure` signals, their `asReadonly()` views, and one setter per signal. No `MorseService`, no timer, no `effect`.

- [ ] **Step 2: Move the poller into the service half**

Create `services/workspace-files.service.ts` with the two `effect`s, `poll`, `needsFreshList`, `ensureLoaded`, `load`, `refresh`, `stage`, `unstage`, `mutate`, and the pure helpers `workingTreeSignature`/`asFiles`. It injects `MorseService` and `WorkspaceFilesStore`, and writes into the store.

- [ ] **Step 3: Delete the old file**

Run: `git rm packages/ui-angular/src/app/state/workspace-files.ts`

- [ ] **Step 4: Repoint consumers**

Find them: `rg -l "workspace-files" packages/ui-angular/src`.
- A surface that only **reads** the tree (the `@` picker, the Explorer) injects `WorkspaceFilesStore`.
- A surface that calls `refresh()`/`stage()`/`unstage()` (the Explorer's refresh button, the git panel) injects `WorkspaceFiles`.

- [ ] **Step 5: Split the spec**

Move the existing spec to `services/workspace-files.service.spec.ts` (polling / freshness / mutation). Add `state/workspace-files.store.spec.ts` asserting the store's views update from its setters. The pre-existing `listArgs` failure stays where it is.

- [ ] **Step 6: Build** → PASS.
- [ ] **Step 7: Test** → only the pre-existing failure.
- [ ] **Step 8: Checkpoint (recorded, not run)** — `refactor(ui): split workspace-files into a store and a poller`.

---

### Task 6: Split `shortcuts` (catalogue / registry / DOM binding)

**Files** (spec *The three splits → `shortcuts`*):
- Create: `src/app/services/shortcuts.catalog.ts`
- Create: `src/app/services/shortcut.service.ts`
- Create: `src/app/ui/shortcut-keys.ts`
- Delete (after the split): `src/app/core/shortcuts.ts`
- Move + split: `src/app/core/shortcuts.spec.ts`

**Interfaces:**
- Consumes: `app/state/shell-state.ts` (`ShellState`).
- Produces:
  - `services/shortcuts.catalog.ts` → the types (`ActionId`, `LocalKeyId`, `ShortcutId`, `ShortcutGroup`, `Binding`, `ShortcutBase`, `ManagedShortcut`, `LocalShortcut`, `ShortcutSpec`), the `SHORTCUTS` table, and the pure helpers (`isManagedShortcut`, `isApple`, `bindingLabel`, `matches`, `matchesOne`, `isEditable`, `asBindings`).
  - `services/shortcut.service.ts` → `ShortcutService` with `catalog`, `available`, `bind(id, run, enabled?)`, `run(id)`, and a new `dispatch(event: KeyboardEvent): void` carrying the decision half of the old `onKeydown` (it no longer touches `document`).
  - `ui/shortcut-keys.ts` → `ShortcutKeys`, an injectable that injects `ShortcutService`, attaches `document.addEventListener('keydown', e => service.dispatch(e), true)` on construction and detaches on destroy.

- [ ] **Step 1: Extract the catalogue and pure helpers** into `services/shortcuts.catalog.ts` (verbatim from `core/shortcuts.ts`).
- [ ] **Step 2: Extract the registry** into `services/shortcut.service.ts`; move the body of `onKeydown` into `dispatch(event)` and delete the constructor's `document` listener.
- [ ] **Step 3: Add the DOM adapter** `ui/shortcut-keys.ts` (`ShortcutKeys`) that owns the `keydown` listener and calls `ShortcutService.dispatch`.
- [ ] **Step 4: Instantiate the adapter** — `app/shell` does not exist yet, so add `inject(ShortcutKeys)` to `src/app/app.ts` (a constructor line) so the listener is attached exactly once; Task 10 moves the file without changing that line.
- [ ] **Step 5: Delete the old file** — `git rm packages/ui-angular/src/app/core/shortcuts.ts`
- [ ] **Step 6: Repoint consumers** — `rg -l "core/shortcuts" packages/ui-angular/src` (the dialog, the palette, the composer, `app.ts`) and import from `services/shortcut.service` / `services/shortcuts.catalog` as appropriate.
- [ ] **Step 7: Split the spec** — `core/shortcuts.spec.ts` → `services/shortcut.service.spec.ts`; add a small `services/shortcuts.catalog.spec.ts` covering `bindingLabel`/`matches` (they were already covered; keep the assertions, change the import).
- [ ] **Step 8: Build** → PASS.
- [ ] **Step 9: Test** → only the pre-existing failure.
- [ ] **Step 10: Checkpoint (recorded, not run)** — `refactor(ui): split shortcuts into catalogue, registry and key binding`.

---

### Task 7: Split `notifications` (policy vs. delivery)

**Files** (spec *The three splits → `notifications`*):
- Create: `src/app/services/run-notifier.ts`
- Create: `src/app/services/notification-channel.ts`
- Delete (after the split): `src/app/core/notifications.ts`
- Move + split: `src/app/core/notifications.spec.ts`

**Interfaces:**
- Consumes: `app/host/morse.service.ts`, `app/state/attachments.ts` (`AttachmentStore`), `app/state/notification-prefs.ts` (`NotificationPrefs`).
- Produces:
  - `services/run-notifier.ts` → `RunNotifier` with `permission`, `optIn()`, and the internal policy. It keeps the in-app toast fallback and calls `AttachmentStore.say`.
  - `services/notification-channel.ts` → `readPermission()`, `queryPermission()`, `onPermissionChange(refresh)` registration, and `webNotify(body)` — the browser/host delivery, taking callbacks instead of app state.

- [ ] **Step 1: Extract the delivery helpers** into `services/notification-channel.ts` (verbatim behaviour; no Angular state, no `AttachmentStore`).
- [ ] **Step 2: Extract the policy** into `services/run-notifier.ts`; it calls the channel and falls back to `AttachmentStore.say`.
- [ ] **Step 3: Delete the old file** — `git rm packages/ui-angular/src/app/core/notifications.ts`
- [ ] **Step 4: Repoint consumers** — `rg -l "core/notifications" packages/ui-angular/src`.
- [ ] **Step 5: Split the spec** — `core/notifications.spec.ts` → `services/run-notifier.spec.ts` (behaviour unchanged).
- [ ] **Step 6: Build** → PASS.
- [ ] **Step 7: Test** → only the pre-existing failure.
- [ ] **Step 8: Checkpoint (recorded, not run)** — `refactor(ui): split run-notifier policy from notification delivery`.

**After tasks 1–7, `src/app/core/` must be empty.** Remove it: `rmdir packages/ui-angular/src/app/core` (it should be non-empty only if a file was missed — treat that as a failure).

---

### Task 8: Re-slice `chat/` (nest `transcript/` and `composer/`)

**Files** (spec *Feature mapping → `features/chat/`*). Move whole folders with `git mv`, then rename the direct files inside them:

| From | To |
| --- | --- |
| `chat/chat-transcript/` | `features/chat/transcript/` — rename `chat-transcript.*` → `transcript.*` |
| `chat/tool-group/` | `features/chat/transcript/tool-group/` |
| `chat/pin-annotation/` | `features/chat/transcript/pin-annotation/` |
| `chat/prompt-rail/` | `features/chat/transcript/prompt-rail/` |
| `chat/chat-composer/` | `features/chat/composer/` — rename `chat-composer.*` → `composer.*` |
| `chat/model-picker/` | `features/chat/composer/model-picker/` |
| `chat/thinking-picker/` | `features/chat/composer/thinking-picker/` |
| `chat/command-picker/` | `features/chat/composer/command-picker/` |
| `chat/file-picker/` | `features/chat/composer/file-picker/` |
| `chat/usage/` | `features/chat/composer/usage/` |
| `chat/prompt-template-dialog/` | `features/chat/composer/prompt-template-dialog/` |
| `chat/chat-header/` | `features/chat/header/` — rename `chat-header.*` → `header.*` |
| `chat/empty-session/` | `features/chat/empty/` — rename `empty-session.*` → `empty.*` |
| `chat/interaction-panel/` | `features/chat/interaction/` — rename `interaction-panel.*` → `interaction.*` |
| `chat/task-overlay/` | `features/chat/tasks/` — rename `task-overlay.*` → `tasks.*` |
| `chat/pi-ui/` | `features/chat/pi-ui/` |

**Interfaces:**
- Consumes: `app/host`, `app/state`, `app/services`, `app/ui`.
- Produces: the same components under `features/chat/…`; class names and selectors unchanged.

- [ ] **Step 1: Create the directories** — `features/chat/{transcript,composer,header,empty,interaction,tasks,pi-ui}` and the nested ones.
- [ ] **Step 2: Move folders with `git mv`** per the table.
- [ ] **Step 3: Rename the direct files** inside each renamed folder and update their `templateUrl`/`styleUrl` strings to the new basenames.
- [ ] **Step 4: Rewrite every importer** — `rg -l "chat/(chat-transcript|chat-composer|chat-header|empty-session|interaction-panel|task-overlay|tool-group|pin-annotation|prompt-rail|model-picker|thinking-picker|command-picker|file-picker|usage|prompt-template-dialog|pi-ui)" packages/ui-angular/src`.
- [ ] **Step 5: Build** → PASS.
- [ ] **Step 6: Test** → only the pre-existing failure.
- [ ] **Step 7: Verify no spec was left behind** — task 11 pins the count; here confirm each moved folder still contains its `.spec.ts` where it had one.
- [ ] **Step 8: Checkpoint (recorded, not run)** — `refactor(ui): nest the chat feature under features/chat`.

---

### Task 9: The six remaining features

**Files** (spec *Feature mapping → The other six features*):

| From | To |
| --- | --- |
| `chat/tab-strip/` | `features/workbench/tab-strip/` |
| `chat/file-preview/` | `features/workbench/file-preview/` |
| `chat/bottom-panel/` | `features/workbench/bottom-panel/` |
| `chat/terminal/` | `features/workbench/terminal/` |
| `chat/mcp-editor/` | `features/surfaces/mcp-editor/` |
| `chat/prompt-editor/` | `features/surfaces/prompt-editor/` |
| `chat/session-page/` | `features/surfaces/session-page/` |
| `chat/mcp-panel/` | `features/overlays/mcp-panel/` |
| `nav/session-nav/` | `features/nav/session-nav/` |
| `nav/file-explorer/` | `features/nav/file-explorer/` |
| `nav/project-picker/` | `features/nav/project-picker/` |
| `nav/project-filter/` | `features/nav/project-filter/` |
| `git/git-panel.ts` (+`.html`) | `features/git/git-panel/` |
| `git/branch-picker/` | `features/git/branch-picker/` |
| `palette/command-palette.ts` (+`.html`) | `features/overlays/command-palette/` |
| `shortcuts/shortcuts-dialog.ts` (+`.html`) | `features/overlays/shortcuts-dialog/` |
| `about/about-dialog.ts` (+`.html`, +spec), `about/credits.ts` (+spec) | `features/overlays/about/` |
| `boot/boot-splash.ts` (+`.html`) | `features/screens/boot-splash/` |
| `connection/connection-screen.ts` (+`.html`) | `features/screens/connection-screen/` |
| `agent/agent-screen.ts` (+`.html`) | `features/screens/agent-screen/` |

After this task `src/app/{nav,git,palette,shortcuts,about,boot,connection}` must not exist, and `src/app/chat/` must not exist.

**Interfaces:**
- Consumes: everything to the right in the layer order.
- Produces: the same components under `features/…`.

- [ ] **Step 1: Create the feature directories.**
- [ ] **Step 2: `git mv` each row** (folders, or the single `.ts`+`.html` where the source was a loose file — give it its own folder per the table).
- [ ] **Step 3: Update the lazy `import()` specifiers** in `src/app/app.ts` (the prompt-editor import) and in `src/app/routes.ts` / `src/app/routes.spec.ts` (the `/mcp`, `/prompts`, `/session` rows) to the `features/surfaces/…` paths.
- [ ] **Step 4: Rewrite every other importer** by basename.
- [ ] **Step 5: Build** → PASS. This is also the check that no `templateUrl`/`styleUrl` and no dynamic `import()` string was missed.
- [ ] **Step 6: Test** → only the pre-existing failure.
- [ ] **Step 7: Verify the spec count** — `find packages/ui-angular/src/app/features -name '*.spec.ts' | wc -l` equals the number of specs that lived under `chat/ nav/ git/ palette/ shortcuts/ about/ boot/ connection/` before the task.
- [ ] **Step 8: Checkpoint (recorded, not run)** — `refactor(ui): group the view layer into features`.

---

### Task 10: `shell/` and `routing/`

**Files:**
- Move: `src/app/{app.ts,app.html,app.css,app.spec.ts,app.bottom-panel.spec.ts,app.embedded.spec.ts,app.session-tabs.spec.ts}` → `src/app/shell/`
- Move: `src/app/{routes.ts,routes.spec.ts,app.config.ts}` → `src/app/routing/`
- Modify: `src/main.ts` (its imports of the route table and the config)

**Interfaces:**
- Consumes: `features/`, and any layer below.
- Produces: `App` at `app/shell/app.ts`; `APP_ROUTES`, `DEFAULT_ROUTE`, `hashPath`, `resolveAppRoute` at `app/routing/routes.ts`; `appConfig` at `app/routing/app.config.ts` — unchanged exports.

- [ ] **Step 1: Create the directories** — `mkdir -p packages/ui-angular/src/app/{shell,routing}`
- [ ] **Step 2: `git mv` the `shell/` files and the `routing/` files.**
- [ ] **Step 3: Repoint `src/main.ts`** at `./app/routing/routes` and `./app/routing/app.config`.
- [ ] **Step 4: Rewrite the moved files' own imports** (their `../` depth changed) by basename.
- [ ] **Step 5: Build** → PASS.
- [ ] **Step 6: Test** → only the pre-existing failure.
- [ ] **Step 7: Checkpoint (recorded, not run)** — `refactor(ui): move the app shell and routing into their own layers`.

---

### Task 11: Documentation and the final gate

**Files:**
- Modify: `packages/ui-angular/AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/FRONTENDS.md`, `AGENTS.md` (root), `docs/DEVELOPMENT.md`, `packages/server/AGENTS.md`, `packages/host-runtime/AGENTS.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Rewrite `packages/ui-angular/AGENTS.md`** — the **Overview** table around `host state services ui features shell routing`, a new **Layers** heading carrying R-U1–R-U8 verbatim from the spec, and repointed **When stuck** / **Gotchas** path citations (they name `core/...`, `chat/...`, `shared/...` today).
- [ ] **Step 2: Add a section to `docs/ARCHITECTURE.md`** — *Inside a frontend*: the layer map, the R-U rules, and the one-way arrow.
- [ ] **Step 3: `docs/FRONTENDS.md`** — state the layer order as the shape a second frontend should follow (the *Reusable pieces* / *Rules a frontend must follow* area).
- [ ] **Step 4: root `AGENTS.md`** — add the `ui-angular` layer map to *Where new code goes*.
- [ ] **Step 5: Fix stale citations** in `docs/DEVELOPMENT.md`, `packages/server/AGENTS.md`, `packages/host-runtime/AGENTS.md` (they name `chat/file-preview/preview-positions.ts`, `core/git-graph.ts`, `chat/terminal/terminal-links.ts`, `shared/markdown/markdown.ts`).
- [ ] **Step 6: Rule verification (the Review Focus pins)**

Run:
```bash
cd packages/ui-angular/src/app
# 1. no old top-level dirs remain
ls
# 2. no import points at the old core/ or shared/ layers (hard)
! rg -n "from '[^']*(core|shared)/" .
# 3. R-U5: state imports nothing from services (hard)
! rg -n "from '[^']*services/" state
# 4. R-U4: services imports nothing from ui (hard)
! rg -n "from '[^']*ui/" services
# 5. R-U2: cross-feature imports (best-effort; review is authoritative)
for d in features/*/; do f=$(basename "$d"); others=$(ls features | grep -vx "$f" | paste -sd'|'); rg -n "\.\./.*($others)/" "$d" || true; done
# 6. every dynamic import() target exists
rg -n "import\(" .
```
Expected: steps 2–4 print nothing; steps 5–6 are read and eyeballed (no line should name another feature's folder).

- [ ] **Step 7: Full gate**

Run: `npm run build` → PASS.
Run: `npm run test:fast` → host-runtime, ui-runtime and server green; `ui-angular` green except the one pre-existing `workspace-files.spec.ts` failure.
Run: `npm run sync-webview` → the webview bundle is regenerated.

- [ ] **Step 8: Manual, for the owner** — open `npm run dev:ui` with `?mock=1` and confirm the chat still boots with no host (the one path no unit test covers). Do not start a server or the app yourself unless asked.

- [ ] **Step 9: Checkpoint (recorded, not run)** — `docs(ui): document the layered structure and the R-U rules`.

---

## Self-review

- **Spec coverage:** every spec section maps to a task — layer maps → Tasks 1–4, the three splits → Tasks 5–7, the chat re-slice → Task 8, the other features → Task 9, composition → Task 10, docs + gate → Task 11. The *Out of scope* list has no task, by design.
- **Type consistency:** the names used across tasks are the spec's (`WorkspaceFilesStore`/`WorkspaceFiles`, `ShortcutService`/`ShortcutKeys`/`shortcuts.catalog`, `RunNotifier`/`notification-channel`), and each is defined in exactly one task.
- **Review Focus:** each of the five lines is pinned — 1 by every build gate, 2 by Task 9's count check, 3 by Tasks 9–10, 4 by Task 11's greps, 5 by Task 11's build + `sync-webview` and the owner's manual note.
- **No commit steps:** intentional; the project forbids committing unless asked, so each task records a checkpoint instead.
