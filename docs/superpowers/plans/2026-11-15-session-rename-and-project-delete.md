# Session rename and project deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A session's title is Morse's to set and survives every engine report, and a project can be deleted as a unit — its sessions removed from each engine's storage, its directory left on disk.

**Architecture:** `session/rename` patches Morse's own record (`~/.morse/sessions/records/…`) with a `titlePinned` flag that reconcile and the live row writer both honour. `project/delete` lists the index rows for that `cwd`, closes each live session, removes each conversation through its own engine's catalog, and republishes.

**Tech Stack:** TypeScript, Angular 22 (zoneless signals), Vitest (system/ui-runtime), Angular `@angular/build:unit-test` (ui-angular), VS Code extension host.

**Spec:** `docs/superpowers/specs/2026-11-15-session-rename-and-project-delete-design.md`

## Global Constraints

- The engine's own session data (pi `.jsonl`, OpenCode server records) is never edited by a rename.
- Projects have no record and gain no rename: the only project operation is deletion.
- `titlePinned` is additive and optional on `MorseSessionRecord`; no shape-version bump, no migration.
- Sanitized input: `title.trim()`, rejected when empty or over 120 characters.
- Deletion is scope-guarded (`withinScope`/`canOpen`) and confirmed (native modal on VS Code, in-app in the browser).
- The project directory itself is never created, moved or removed by any code here.
- Conventional-commit messages (`feat:`, `fix:`, `test:`, `docs:`).

## Review Focus

1. **A pinned session across a reconcile** — an engine token change must not replace the reader's title.
2. **A pinned session across a live engine rename** — `agent/state.sessionTitle` must be ignored once pinned.
3. **Title boundaries** — empty/whitespace and 121 characters are refused with a notice; 120 characters saves.
4. **Project delete across engines** — pi and OpenCode sessions in one `cwd` both go; the directory survives; one failure still deletes the rest and the notice says "Deleted N of M".
5. **Scope and local state** — a project outside the host's scope is refused; deleted sessions' tabs are forgotten, and a draft tab is left alone (it holds no stored conversation).

---

### Task 1: Wire messages and client methods

**Files:**
- Modify: `packages/protocol/src/wire/client.ts` (two interfaces + the `ClientToHostMessage` union)
- Modify: `packages/protocol/src/wire.ts` (`CLIENT_MESSAGE_TYPES`)
- Modify: `packages/ui-runtime/src/client.ts` (`MorseClient` interface + send implementation)
- Test: `packages/ui-runtime/src/client.spec.ts`

**Interfaces:**
- Consumes: `ClientMessageBase`.
- Produces: `SessionRenameMessage { type: 'session/rename'; payload: { sessionId: string; title: string } }`,
  `ProjectDeleteMessage { type: 'project/delete'; payload: { path: string } }`,
  `MorseClient.renameSession(sessionId: string, title: string): void`,
  `MorseClient.deleteProject(path: string): void`.

- [ ] **Step 1: Write the failing tests** — append to `client.spec.ts`, using the existing transport-capture pattern:

```ts
it('sends a rename with the trimmed-free payload the host validates', () => {
  // client.renameSession('s1', 'Release prep')
  // expect sent to contain { type: 'session/rename', payload: { sessionId: 's1', title: 'Release prep' } }
});

it('sends a project delete by path', () => {
  // client.deleteProject('/work/morse')
  // expect sent to contain { type: 'project/delete', payload: { path: '/work/morse' } }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test -w @morse/ui-runtime -- client.spec`
Expected: FAIL — `client.renameSession is not a function`.

- [ ] **Step 3: Define the wire messages**

In `wire/client.ts`, add both interfaces beside `SessionDeleteMessage`, each with a doc comment (rename writes Morse's index only; project delete removes sessions and keeps the directory), add them to the `ClientToHostMessage` union, and add `'session/rename'` and `'project/delete'` to `CLIENT_MESSAGE_TYPES` in `wire.ts`.

- [ ] **Step 4: Add the client methods**

`renameSession` sends `{ type: 'session/rename', payload: { sessionId, title } }`; `deleteProject` sends `{ type: 'project/delete', payload: { path } }`. Document both on `MorseClient` the way `deleteSession` is documented.

- [ ] **Step 5: Rebuild protocol, run the tests**

Run: `npm run build -w @morse/protocol && npm run test -w @morse/ui-runtime -- client.spec`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/wire/client.ts packages/protocol/src/wire.ts packages/ui-runtime/src/client.ts packages/ui-runtime/src/client.spec.ts
git commit -m "feat(protocol): add session rename and project delete messages"
```

---

### Task 2: Pin the title on Morse's record and honour it in reconcile

**Files:**
- Modify: `packages/system/src/session/record.ts`
- Modify: `packages/system/src/session/reconcile.ts`
- Test: `packages/system/src/session/reconcile.spec.ts`

**Interfaces:**
- Consumes: `MorseSessionRecord`, `planReconcile`.
- Produces: `MorseSessionRecord.titlePinned?: true`; `planReconcile` keeps a pinned title for the same id.

- [ ] **Step 1: Write the failing tests**

```ts
it('keeps a renamed session’s title when the engine reports a new token', () => {
  // stored: record('id-1', { title: 'Release prep', titlePinned: true })
  // report: info('id-1', { title: 'Reply with exactly: pi-host' }), tokens: id-1 -> previous token
  // expect plan.upserts[0].title to be 'Release prep' and titlePinned true
});

it('takes the engine’s title for a session the reader never renamed', () => {
  // same, stored without titlePinned
  // expect plan.upserts[0].title to be the reported title, and no titlePinned
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test -w @morse/system -- reconcile`
Expected: FAIL — the pinned title comes back as the reported one.

- [ ] **Step 3: Implement**

`record.ts`: add `titlePinned?: true` with a comment stating it marks the title as the reader's, that reconcile and the live row writer both honour it, and that the engine's own data is untouched.

`reconcile.ts`: when a reported record's id exists in `stored` with `titlePinned`, push `{ ...record, title: stored.title, titlePinned: true }` instead of `record` (keep the reported token mapping unchanged).

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test -w @morse/system -- reconcile`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/system/src/session/record.ts packages/system/src/session/reconcile.ts packages/system/src/session/reconcile.spec.ts
git commit -m "feat(system): keep a pinned session title through reconcile"
```

---

### Task 3: Router rename, project ids, and the live title rule

**Files:**
- Modify: `packages/system/src/session/ports.ts` (`SessionCatalog` optional methods)
- Modify: `packages/system/src/session/record.ts` (`titleForReport`)
- Modify: `packages/system/src/session/agent-router.ts` (`rename`, `idsInProject`, row writer)
- Test: `packages/system/src/session/record.spec.ts` (create)
- Test: `packages/system/src/session/agent-router.spec.ts`

**Interfaces:**
- Produces: `SessionCatalog.rename?(id: string, title: string): Promise<boolean>`,
  `SessionCatalog.idsInProject?(cwd: string): Promise<string[]>`,
  `titleForReport(record: Pick<MorseSessionRecord, 'title' | 'titlePinned'>, reported: string | undefined): string`.
- Consumes: `SessionStore.read/write`, `MorseSessionRecord`.

- [ ] **Step 1: Write the failing tests**

`record.spec.ts`:

```ts
it('keeps a pinned title whatever the engine reports', () => {
  // titleForReport({ title: 'Release prep', titlePinned: true }, 'Engine name') === 'Release prep'
});

it('takes the engine title when the title is not pinned', () => {
  // titleForReport({ title: 'Old' }, 'Engine name') === 'Engine name'
});

it('falls back to the stored title when the engine reports none', () => {
  // titleForReport({ title: 'Old' }, undefined) === 'Old'
});
```

`agent-router.spec.ts` (using the spec's existing fake store/catalog harness):

```ts
it('renames by writing the record with the pin and no engine token', () => {
  // router.rename(id, 'Release prep') -> true
  // store.write called once with { title: 'Release prep', titlePinned: true } and no second argument
});

it('reports a rename of a session the index no longer holds', () => {
  // router.rename('gone', 'x') -> false, and no write
});

it('lists only the sessions of one project', () => {
  // records in /work/morse and /work/other -> idsInProject('/work/morse') only the former's ids
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test -w @morse/system -- record.spec agent-router`
Expected: FAIL — `titleForReport` is not exported; `router.rename` is not a function.

- [ ] **Step 3: Implement**

`ports.ts`: add both optional methods with doc comments that mirror `remove`'s ("a catalog that cannot rename omits it").

`record.ts`: `titleForReport` as declared in Interfaces.

`agent-router.ts`:
- `rename(id, title)`: `const record = await this.deps.store.read(id); if (record === undefined) return false; await this.deps.store.write({ ...record, title, titlePinned: true }); return true;`
- `idsInProject(cwd)`: `await this.ensureFresh(true);` then the ids of every stored record whose `cwd === cwd` (destructive callers need the freshest window).
- Row writer: in the same-engine branch and the resumed branch, the new title is `titleForReport(row|carried, state.sessionTitle)`. In the fork branch the child keeps `state.sessionTitle ?? row.title` and **drops** the pin (a fork is a new conversation): spread the parent without `titlePinned`.
- Never set `titlePinned` when seeding a brand-new row.

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test -w @morse/system -- record.spec agent-router`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/system/src/session/ports.ts packages/system/src/session/record.ts packages/system/src/session/record.spec.ts packages/system/src/session/agent-router.ts packages/system/src/session/agent-router.spec.ts
git commit -m "feat(system): rename, project ids and pinned titles in the router"
```

---

### Task 4: The use cases and the host handlers

**Files:**
- Modify: `packages/system/src/session/service.ts`
- Modify: `packages/system/src/host/session-controller.ts`
- Test: `packages/system/src/session/service.spec.ts`
- Test: `packages/system/src/host/session-controller.spec.ts`

**Interfaces:**
- Consumes: `SessionCatalog.rename/idsInProject`, `SessionService.remove`, `canOpen`, `publishSessions`, `transcripts.clear`, `fallBackAfterSessionGone`.
- Produces: `SessionService.renameSession(key: string, title: string): Promise<boolean>`,
  `SessionService.deleteProject(path: string): Promise<{ deleted: string[]; failed: string[] }>`,
  and the `session/rename` / `project/delete` client handlers.

- [ ] **Step 1: Write the failing service tests**

```ts
it('renames through the catalog and reports an unknown session', () => {
  // catalog.rename resolves true -> renameSession resolves true
  // catalog.rename resolves false -> renameSession resolves false
  // catalog without rename -> rejects UnsupportedByHostError
});

it('deletes a project’s sessions after closing each live one', () => {
  // idsInProject -> ['a','b'] (one pi record, one opencode record); close records the order
  // deleteProject('/work/morse') -> { deleted: ['a','b'], failed: [] }, close before each remove
});

it('reports the sessions it could not delete and keeps going', () => {
  // catalog.remove rejects for 'b' -> { deleted: ['a','c'], failed: ['b'] }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test -w @morse/system -- service.spec`
Expected: FAIL — `deleteProject is not a function`.

- [ ] **Step 3: Implement the service**

`renameSession` throws `UnsupportedByHostError('This host cannot rename sessions.')` when `catalog.rename` is absent, else delegates. `deleteProject` throws the same shape when `idsInProject` is absent; otherwise loops the ids through `this.remove(id)` (which closes first), collecting failures instead of throwing, and returns `{ deleted, failed }`.

- [ ] **Step 4: Write the failing controller tests**

```ts
it('renames a session and republishes the list', () => {
  // session/rename { sessionId: 'sess-1', title: '  Release prep  ' }
  // expect the emitted session/list to carry title 'Release prep' for sess-1
});

it('refuses an empty or over-long title', () => {
  // '   ' -> an error notice, no session/list republish
  // 'x'.repeat(121) -> refused; 'x'.repeat(120) -> accepted
});

it('deletes a project’s sessions, clears their transcripts and says how many', () => {
  // two sessions in /work/morse, one active -> project/delete
  // expect transcripts cleared for both, a notice naming the count, and no rows for that cwd in session/list
});

it('refuses a project outside the host scope', () => {
  // scope roots ['/work/morse'], project/delete '/etc' -> error notice, no catalog call
});
```

- [ ] **Step 5: Run to verify they fail**

Run: `npm run test -w @morse/system -- session-controller`
Expected: FAIL — the message types are not handled.

- [ ] **Step 6: Implement the handlers**

Add `case 'session/rename'` and `case 'project/delete'` beside `session/delete`. Rename trims, refuses empty/over-120 with `this.fail('A session title needs between 1 and 120 characters.')`, calls `registry.renameSession`, reports `'That session is no longer in the index.'` on `false`, and otherwise `await this.publishSessions()`. Project delete refuses outside `canOpen(path)` with the existing deletion wording, calls `registry.deleteProject(path)`, clears each deleted id's transcript, calls `fallBackAfterSessionGone(activeKey)` when the active key was deleted, emits the notice (`Deleted N sessions in <name>.`, or `Deleted N of M — the rest could not be removed.`), then `await this.publishSessions()`.

- [ ] **Step 7: Run the whole system suite**

Run: `npm run test -w @morse/system`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/system/src/session/service.ts packages/system/src/session/service.spec.ts packages/system/src/host/session-controller.ts packages/system/src/host/session-controller.spec.ts
git commit -m "feat(system): handle session rename and project delete"
```

---

### Task 5: Sidebar rename and project delete

**Files:**
- Modify: `packages/ui-angular/src/app/host/morse.service.ts`
- Modify: `packages/ui-angular/src/app/state/workspace-tabs.ts`
- Modify: `packages/ui-angular/src/app/features/session-nav/session-nav.ts`
- Modify: `packages/ui-angular/src/app/features/session-nav/session-nav.html`
- Modify: `packages/ui-angular/src/app/features/session-nav/session-nav.css`
- Test: `packages/ui-angular/src/app/state/workspace-tabs.spec.ts`
- Test: `packages/ui-angular/src/app/features/session-nav/session-nav.spec.ts`

**Interfaces:**
- Consumes: `MorseClient.renameSession/deleteProject`, `WorkspaceTabs.refreshSession/forget`, host command `confirmDeleteProject`.
- Produces: `MorseService.renameSession(sessionId, title)`, `MorseService.deleteProject(path)`,
  `WorkspaceTabs.forgetProject(cwd: string): void`.

- [ ] **Step 1: Write the failing tab test**

```ts
it('forgets a project’s session tabs and leaves its file tabs alone', () => {
  // session tabs in /work/morse and /work/other, a file tab in /work/morse
  // forgetProject('/work/morse') -> only that project's session tab is gone
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -w @morse/ui-angular -- --watch=false`
Expected: FAIL — `forgetProject is not a function`.

- [ ] **Step 3: Implement `forgetProject` and the service passthroughs**

`WorkspaceTabs.forgetProject(cwd)` forgets every session tab whose `cwd === cwd` (reuse `forget`), leaving draft and file tabs. `MorseService` gains `renameSession` and `deleteProject` beside `deleteSession`.

- [ ] **Step 4: Write the failing nav tests**

```ts
it('renames a session from its context menu', async () => {
  // open the session menu -> click Rename -> type 'Release prep' + Enter
  // expect transport sent { type: 'session/rename', payload: { sessionId, title: 'Release prep' } }
  // expect the tab label to read 'Release prep'
});

it('refuses an empty rename without sending it', async () => {
  // type '   ' + Enter -> no session/rename, row unchanged
});

it('deletes a project after asking in-app', async () => {
  // right-click the project row -> 'Delete project…' -> confirm
  // expect { type: 'project/delete', payload: { path: '/work/morse' } }
  // expect that project's session tab to be forgotten
});

it('asks the host when it has native dialogs', async () => {
  // nativeDialogs capability + confirmDeleteProject answering { confirmed: true }
  // expect the host command, then project/delete
});
```

- [ ] **Step 5: Run to verify they fail**

Run: `npm run test -w @morse/ui-angular -- --watch=false`
Expected: FAIL — there is no rename item and no project menu.

- [ ] **Step 6: Implement the sidebar**

- A `renaming = signal<{ id: string; title: string } | undefined>()`; the session row renders an `<input class="rename-input">` in place of its title when renaming, committed on Enter (trim, refuse empty, then `morse.renameSession` + `tabs.refreshSession`), cancelled on Escape and blur.
- The session menu gains **Rename** above the destructive item, closing the menu first.
- `onTreeContext` opens a `projectMenu` for project nodes instead of returning early (the "Load more" node keeps returning); the menu shows the project's name, its session count, and a confirm step: `Delete the N sessions in “name”? The folder stays on disk.`
- Confirmation: `nativeDialogs()` → `confirmDeleteProject` with `{ path, name, count }`, falling back to the in-app step when the answer is undefined; otherwise the in-app step.
- On confirm: `tabs.forgetProject(path)`, then `morse.deleteProject(path)`.

- [ ] **Step 7: Run the UI suite**

Run: `npm run test -w @morse/ui-angular -- --watch=false`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/ui-angular/src/app/host/morse.service.ts packages/ui-angular/src/app/state/workspace-tabs.ts packages/ui-angular/src/app/state/workspace-tabs.spec.ts packages/ui-angular/src/app/features/session-nav/
git commit -m "feat(ui): rename sessions and delete projects from the sidebar"
```

---

### Task 6: The VS Code confirmation

**Files:**
- Modify: `packages/protocol/src/wire/host.ts` (`HostCommand` union)
- Modify: `packages/extension/src/internal/vscode/chat-view-provider.ts`

**Interfaces:**
- Produces: host command `'confirmDeleteProject'` with `{ path: string; name: string; count: number }`,
  answering `{ confirmed: boolean }`.

- [ ] **Step 1: Add the command and its handler**

Beside `confirmDeleteSession`, add the union member and a case that reads `name`/`count` with `stringArg`/a numeric read and shows a modal warning: `Delete the ${count} sessions in “${name}”? Their conversations cannot be recovered. The folder itself stays on disk.`, resolving `{ confirmed: answer === 'Delete' }`.

- [ ] **Step 2: Type-check the extension**

Run: `npm run build -w @morse/protocol && npm run check-types -w morse`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add packages/protocol/src/wire/host.ts packages/extension/src/internal/vscode/chat-view-provider.ts
git commit -m "feat(extension): confirm a project delete in a native dialog"
```

---

### Task 7: Document it and verify the workspace

**Files:**
- Modify: `docs/STATUS.md`
- Modify: `docs/DATA-COMPATIBILITY.md`
- Modify: `docs/superpowers/specs/2026-11-15-session-rename-and-project-delete-design.md` (status line)

- [ ] **Step 1: Update the docs**

Remove the "Session rename" bullet from `STATUS.md`'s **Not built yet** and add shipped bullets for rename (Morse-side, survives engine reports) and project deletion (sessions removed, directory kept). Add one line to `DATA-COMPATIBILITY.md` saying `titlePinned` is additively optional and older hosts ignore it. Mark the spec `Status: implemented`.

- [ ] **Step 2: Run the full suite**

Run: `npm run test:fast`
Expected: every workspace green.

- [ ] **Step 3: Type-check and lint**

Run: `npm run check-types && npm run lint`
Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add docs/STATUS.md docs/DATA-COMPATIBILITY.md docs/superpowers/specs/2026-11-15-session-rename-and-project-delete-design.md
git commit -m "docs: record session rename and project deletion"
```
