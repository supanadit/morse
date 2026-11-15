# Message editing and branching — design

## Intent

Editing a past prompt should look the same to the reader on every engine, but the
engines mean different things by it. Pi has no edit primitive: its fork writes a
new session file, which is why "edit" has always been a fork. OpenCode does have
one — its session revert (`/api/session/:id/revert/stage` then `.../commit`)
rewinds the same session in place — but Morse still forks it, so every OpenCode
edit silently spawns a new session and leaves the old one in the sidebar.

The same asymmetry decides what "branch from this answer" can mean, and today no
engine offers it at all: fork and edit are attached to user rows only.

Finally, the session list paints every row with the same purple chat icon, so a
branch and a subagent are indistinguishable from an original conversation.

## What exists today

- `chat/edit` and `chat/fork` are wired end to end (`packages/protocol/src/wire/client.ts`),
  advertised by both hosts as `capabilities.editMessage` / `forkMessage`.
- `HostSessionController.editPrompt` and `forkPrompt` share `forkBefore`, which
  calls `registry.forkActive(entryId)` and then re-homes the transcript
  (`packages/system/src/host/session-controller.ts:1580-1713`).
- `SessionRegistry.forkActive` already tolerates a key that does not move
  (`packages/system/src/session/service.ts:290-331`).
- OpenCode's `fork` calls `/api/session/:id/fork` and moves `engineId` to the new
  session (`packages/integration-opencode/src/opencode-agent.ts:479-496`).
- Pi's `fork` sends the `fork` RPC; its picker list (`get_fork_messages`) keeps
  only user messages with text, while `fork` itself accepts any user message entry
  (`packages/integration-pi/src/pi-rpc-agent.ts:263-300`).
- Both engines' fork is exclusive of the boundary message: OpenCode projects the
  history *before* the given message, pi ends the new conversation before the
  entry. So forking before the next user prompt keeps everything above it.
- Pi additionally exposes a `clone` RPC: fork at the leaf (`position: "at"`),
  copying the whole conversation (`dist/modes/rpc/rpc-mode.js`, case `"clone"`).
- Copy already exists on both roles and only writes to the clipboard
  (`packages/ui-angular/src/app/features/transcript/transcript.ts:556-589`).
- `session-nav` sets `icon: 'session'` for every row
  (`packages/ui-angular/src/app/features/session-nav/session-nav.ts:225-239`).

## How branching actually works in each engine

Both engines can "branch from this answer and keep it", with no new reading API:

- The answer is the last conversational item of a turn. The cut point for the new
  branch is the **next user prompt** (or the end of the conversation).
- OpenCode: `POST /api/session/:id/fork { before: nextUserMessageId }` copies the
  projected history *before* that prompt, the answer included — this is the same
  call `fork()` already makes today (`opencode-agent.ts:479-483`), so the body
  field is `before`, not `messageID`. At the tail, fork with **no body** copies
  the full history.
- Pi: `fork(nextUserEntryId)` does the same; at the tail, `clone` copies
  everything.

So the host rule is uniform and needs no assistant message ids: **fork before the
next user prompt; if there is none, clone.** This also removes the earlier worry
that mid-conversation answer branching would be OpenCode-only — it is not.

Two details confirmed against the installed OpenCode 2.2.7 bundle:

- A body-less fork still records `fork_boundary` (type `through`, the last
  message), so the child row keeps `fork_session_id` and the catalog still derives
  `parentId` (`opencode-session-catalog.ts:157-176`). A tail branch nests in the
  sidebar like any other.
- The fork's own boundary type decides how much is copied: `before` with a
  message id is exclusive, `through` includes the last message.

## Goals

1. An edit rewrites the conversation **the way the engine does**: in place on
   OpenCode (same session id, no new row), as a branch on Pi.
2. With OpenCode's in-place rewrite, the discarded tail and the file snapshot roll
   back to the edited prompt (choice **A**): the engine's own edit semantics.
3. A finished answer offers **Branch from here**, which keeps the answer and starts
   a new branch behind it, on both engines.
4. The session list distinguishes an original (purple chat), a branch (green fork),
   and a subagent (red bot) at a glance.
5. Copy stays what it is: clipboard only, on both roles. No new copy feature.
6. A prompt with no text — an image-only or pin-only message — edits, forks and
   branches like any other, and never resolves to a neighbouring prompt.

## Non-goals

- Branching or editing **mid-turn** (before a tool call has settled). The action
  lives on the turn's final answer only.
- "Revert without resending", and any `unrevert` UI. An edit always sends the
  replacement prompt, which is what makes OpenCode discard the tail.
- Editing assistant messages. Only user prompts are editable, as today.
- Copying a message into the composer or into a new session.
- A new wire capability for edit/fork: both hosts already advertise both actions,
  and both engines will support all three behaviors.

## Anti-goals

- The host naming an engine ("if OpenCode…") or an engine's HTTP living in
  `@morse/system`. That boundary is linted (`scripts/check-agent-boundary.mjs`).
- An edit that grows the sidebar on OpenCode.
- Icons guessed from a title or first message instead of `parentId` / `subagent`.

## Approaches considered

1. **Engine-owned primitives — chosen.** The port gains `rewrite(entryId)` (each
   engine's own edit semantics) and `clone()` (branch at the tip). The host keeps
   truncating and re-homing; it asks the port, never the engine name. Cost: the
   port, both adapters, the router/registry, the host and the UI. Benefit: each
   engine's rule sits in its own package and is testable alone.
2. **Host asks the engine kind and drives it directly.** Fewer abstractions, but
   puts engine transport inside `@morse/system` and breaks the agent boundary.
   Rejected.
3. **Reuse `fork()` only.** Smallest diff, but it cannot keep the answer at the
   tail and leaves OpenCode edits as forks — the bug this work exists to fix. It
   would need one new primitive anyway. Rejected.

## The design

### Port (`@morse/agent`)

Two required additions to `AgentGateway`, beside the existing `fork`:

```ts
/**
 * Rewrites the conversation the way this engine can: in place from `entryId`
 * forward (the same session, the same id) or by branching before it (a new
 * session, a new id). Returns the text of the message that was dropped.
 */
rewrite(entryId: string): Promise<{ text: string; cancelled: boolean }>;

/**
 * Branches at the tip: a new session whose conversation is a copy of this one,
 * through the last message. The old branch stays.
 */
clone(): Promise<{ cancelled: boolean }>;
```

`fork(entryId)` keeps its meaning: always a branch, always before `entryId`.

`forkMessages()` becomes **`userMessages()`**: the same ordered list, but *every*
user message rather than only the ones the engine's own picker would offer.

```ts
/** Every user message the session holds, in conversation order. */
userMessages(): Promise<AgentUserMessage[]>;   // { entryId, text }
```

That rename is the alignment fix. Today the host maps a transcript row to an
engine entry by counting *forkable* rows from the end, and the three lists
disagree: OpenCode returns every user message, pi's `get_fork_messages` drops
messages with empty text, and Morse's own predicate keeps rows with text *or*
pins. One image-only or pin-only prompt is enough to shift the count, and the
edit/fork silently targets its neighbour. With a total list on both sides the
mapping is arithmetic, and the predicate disappears.

Both engines can fork a text-less user message: pi's `fork` only demands
`type === "message" && role === "user"` (`runtimeHost.fork` in the installed
1.5.2 bundle) — the text filter belongs to pi's picker, not its fork.

Both additions are required, like `fork` is today, because both adapters can
implement them. An engine that one day cannot simply rejects with
`UnsupportedByHostError`, which the host already turns into a notice.

### OpenCode adapter

The adapter speaks OpenCode **v2** (`/api`, see
`packages/integration-opencode/src/internal/connection.ts`). The v1 `POST
/session/:id/revert { messageID }` that old checkouts show is not what the
installed 2.2.7 server serves, and the local source checkout
(`~/Workspaces/OSS/Bun/opencode`, v1.18.x) is the wrong reference for this work.
The v2 surface, read from the installed bundle, is:

- `POST /api/session/:sessionID/revert/stage { messageID, files? }` — stages a
  reversible boundary and, by default (`files !== false`), **restores the files**
  touched after it immediately.
- `POST /api/session/:sessionID/revert/commit` — commits the boundary and drops
  the messages from it forward (the client reducer removes `id >= to`; the
  boundary is inclusive of `messageID`).
- `DELETE /api/session/:sessionID/revert` — clears a staged revert, restoring the
  files. Not used by Morse.

`rewrite(entryId)` therefore:

1. `POST /api/session/:id/revert/stage { messageID: entryId }` — the entry id is
   the user prompt's engine id, the same one edit already resolves. Inclusive, so
   the prompt itself goes, which is exactly "replace this turn and the tail".
2. `POST /api/session/:id/revert/commit` — the server does **not** commit on the
   next prompt; OpenCode's own client commits explicitly before submitting
   (`Failed to commit revert` in its submit path). Mirroring that is what keeps
   the engine's history and Morse's consistent.
3. `refreshState()` and return the prompt text read before the call.

Failure paths: a stage that fails (409 busy, 404 unknown message, transport) leaves
the session and the files untouched and throws the adapter's usual
`OpenCodeRequestError` / `AgentUnavailableError`. A commit that fails after a
successful stage leaves the files rolled back and the tail only *staged*; the
adapter clears the revert (`DELETE …/revert`, best effort) before throwing, so the
reader is not left with a half-applied boundary.

`clone()`: `POST /api/session/:id/fork` with no body (full history), then adopt the
returned id exactly as `fork` does today — `engineId`, `mergeState`,
unsubscribe/attach, `refreshState`.

### Pi adapter

- `rewrite(entryId)`: delegate to `fork(entryId)` — pi's edit *is* a fork — and
  report its result unchanged.
- `clone()`: send `{ type: 'clone' }` (add `RpcCloneCommand` to
  `internal/rpc/commands.ts`), then `refreshState()` like `fork` does. The RPC
  answers `{ cancelled }`.
- `userMessages()`: derived from the same `get_entries` read `history()` already
  does, filtered to the **active path** (`activePathEntries`) and to
  `type === 'message' && role === 'user'`. Using the active path, not
  `get_fork_messages`'s whole tree, is what keeps the list aligned with the
  transcript: a session that was forked before inside pi holds several branches in
  one file, and only one of them is the conversation on screen.

### OpenCode adapter: reading the list

`toForkMessages` already keeps every user message (`message.type === 'user'`), so
the rename to `userMessages` is the whole change there. The paged read stays,
capped by `MAX_HISTORY_PAGES` as today.

### Router and registry (`@morse/system`)

- `RoutedGateway.rewrite(entryId)` mirrors `RoutedGateway.fork`: call the inner
  gateway, then `await this.state()` so a rewritten *and* a re-keyed session both
  have their row absorbed before any caller looks again.
- `RoutedGateway.clone()` mirrors it too.
- `SessionRegistry.forkActive`'s body becomes a private
  `branchActive(operation: 'fork' | 'rewrite', entryId, sessionKey?)`; `forkActive`
  and a new `rewriteActive` are thin wrappers. Everything after the gateway call
  is already correct for both: `forkActive` returns early when the key did not
  move (`service.ts:302-305`), and `transcripts.move(from, to, items)` already
  replaces in place when `from === to`
  (`packages/system/src/host/transcript-store.ts:134-137`).
- `cloneActive(sessionKey?)` is the same flow without an entry id: `gateway.clone()`,
  absorb the state, re-key when the id moved. It reports no `text`.
- `RoutedGateway.userMessages()` and `clone()` forward to the inner gateway, like
  `forkMessages()` does today.

### Mapping a row to an entry (`entryIdForEdit`)

The predicate goes away; the mapping becomes an index into the total list:

```ts
const userItems = items.filter((item) => item.kind === 'user');
const index = userItems.findIndex((item) => item.id === itemId);
const position = userMessages.length - (userItems.length - index);
return userMessages[position]?.entryId;
```

Counting from the end still tolerates a partially loaded transcript (older pages
absent), but now every user row has exactly one engine message, so no prompt can
resolve to its neighbour. `branchFrom` calls the same helper with the *next user
item's* id.

### Host (`HostSessionController`)

- `editPrompt(itemId, text)` calls `registry.rewriteActive(entryId)`, re-homes the
  transcript with the kept rows, then sends the edited text. It no longer calls
  `forkActive`.
- `forkPrompt(itemId)` keeps calling `forkActive` and seeding the composer.
- New `branchFrom(itemId)`:
  1. Refuse in a draft, while streaming, or when the item is not the turn's last
     answer — same notice wording style as `forkBefore`.
  2. Find the next `user` item after the answer; the kept rows are
     `items.slice(0, indexOfNextUser)` (or the whole list at the tail).
  3. With a next user item: resolve **its** entry id through the shared mapping
     (`entryIdForEdit(items, nextUserItemId, userMessages)`) and call
     `forkActive` with it. Without one: call `registry.cloneActive()`.
  4. Re-home the kept rows through `transcripts.move`, clear
     `historyBefore` / `hasOlderHistory`, `emitState()`, `publishSessions()`.
  5. Do **not** seed the composer: the branch keeps the answer, and the reader
     types what comes next.
- New wire message `chat/branch` with `{ itemId }`, handled next to `chat/edit` and
  `chat/fork` (`session-controller.ts:455-465`). Payload validation and the client
  action mirror the existing two.

### Protocol (`@morse/protocol`)

- `ChatBranchMessage` (`chat/branch`) in `wire/client.ts`, added to the `ClientMessage`
  union and the payload schema the host validates.
- No `HostCapabilities` change: `forkMessage` already means "this host can branch a
  conversation", and every engine behind these hosts now can.
- `SessionViewState` is unchanged.

### UI (`@morse/ui-runtime`, `@morse/ui-angular`)

- `client.ts` gains `branchMessage(itemId)` sending `chat/branch`, and
  `MorseService.branchMessage` forwards it, next to `forkMessage`.
- `transcript.ts`: a `canBranch(item)` for assistant items that are the turn's
  last conversational row and are not streaming; `branch(item)` calls
  `morse.branchMessage(item.id)`. The template shows it in the same hover action
  group as edit/fork, labelled "Branch from here". Copy stays as it is.
- `IconKind` (`packages/ui-runtime/src/files/tree.ts`) gains `session-fork` and
  `session-bot` (and the `ICON_SYMBOL` map entries).
- `app.html` sprite gains `morse-session-fork` (three nodes and a curve, the
  `morse-git` shape) and `morse-session-bot` (a rounded head, two eyes, an
  antenna), both stroked in `currentColor`.
- `styles.css`: `.file-icon.session-fork { color: #6aa84f }` (green, the existing
  `shell` green) and `.file-icon.session-bot { color: #d05c5c }` (red). `.session`
  keeps its purple `#b08ccb`.
- `session-nav.ts` `toNode` picks the icon: `subagent === true` → `session-bot`;
  else `parentId !== undefined` → `session-fork`; else `session`. A subagent wins
  over a fork because it is the stronger fact.

### Docs

`docs/STATUS.md`'s editing/forking section gains: edit rewrites in place on
OpenCode (and rolls the file snapshot back, because that is the engine's edit),
branches on Pi; **Branch from here** keeps an answer; the three session icons;
and that a prompt with no text is a normal branch point (`userMessages` replaced
the text-filtered fork list). The copy sentence stays as is.

## Behavior table

| Action | Row | OpenCode | Pi |
|---|---|---|---|
| Edit & resend | user | stage + commit revert in place, same session id, files roll back | fork, new session, files untouched |
| Fork | user | new session before the prompt, composer seeded | same |
| Branch from here | answer | new session before the next prompt, or a copy at the tail | same |
| Copy | any | clipboard | clipboard |

Everything refuses while the agent is streaming, in a draft, or when the engine
has no entry for the chosen item, with the notice wording the host already uses.

## Edge cases

- The answer branched from is kept; everything after the next user prompt stays on
  the old branch. The old branch remains resumable in the sidebar.
- A branch that rewinds (never OpenCode's edit, but any future engine that rewinds
  on fork) would keep the same key; `transcripts.move(from, to, items)` replaces in
  place when the two keys are equal, so the host calls it unconditionally.
- At the tail, branch uses `clone`, so the old branch and the new copy both stay
  in the sidebar, the new one nested under the old by `parentId`.
- If OpenCode's stage fails (busy session, unknown message, transport), nothing is
  sent and the transcript is untouched; the error reaches the user through
  `guard`. If the commit fails after a successful stage, the adapter clears the
  staged revert (best effort) so the files come back, then throws.
- If the rewrite succeeds and the replacement prompt then fails, the conversation
  is already truncated and the files already rolled back — the same state OpenCode's
  own TUI leaves. The host reports the prompt error as it does for any prompt; it
  does not try to restore the tail, because the engine cannot (commit is final).
- The transcript's next-user-item rule is computed on loaded rows: a branch taken
  while older history is still unloaded cuts at the oldest loaded user row, which
  matches what the reader can see.
- An image-only or pin-only prompt is a normal branch point now; both engines
  accept it. A prompt whose row has no engine message at all (a locally typed
  prompt the engine rejected before recording it) is refused with the existing
  "no fork point for it" notice.

## Left to the builder

- The exact wording of the new notices and the hover labels.
- Whether `branchFrom` and `forkPrompt` share a helper or stay separate after the
  registry split.
- Test layout: new cases in `opencode-agent.spec.ts` (revert stage + commit, clone),
  `pi-rpc-agent` specs (clone command, rewrite delegation, `userMessages` on the
  active path), `session/service.spec.ts` (rewriteActive re-key vs no re-key,
  cloneActive), `session-controller.spec.ts` (edit keeps the key on a rewinding
  engine, branch cuts at the next prompt, tail branch clones, notices, a text-less
  prompt edits its own entry), `session-nav.spec.ts` (three icons),
  `transcript.spec.ts` (branch visibility and dispatch), `client.spec.ts` (the new
  wire message), and the fake gateways in `bot/service.spec.ts`,
  `session/service.spec.ts`, `agent-router.spec.ts` and
  `session-controller.spec.ts` (they implement `forkMessages`).
