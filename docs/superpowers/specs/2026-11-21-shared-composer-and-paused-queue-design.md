# Shared composer state and a paused queue

Date: 2026-11-21
Status: implemented

## Intent and why

Two complaints from using Morse from a phone and a desktop at the same time:

1. **The queue fires when it should wait.** `QueueDrain` sends the next queued follow-up as soon as
   the run settles — including the settle that a **Stop** just caused. The reader who stopped a bad
   answer gets the queued message fired into the same bad context before they can react. ZCode
   pauses the queue and offers Continue / Edit; the option to continue the interrupted answer
   instead of sending the queue is the behaviour wanted here.
2. **Nothing is shared between devices.** Each browser holds its own queue in memory, so it is lost
   on reload and closing the session tab deletes it (`WorkspaceTabs.close` →
   `QueuedPrompts.forgetOwner`). Drafts are written to `drafts.json`, but only read at boot and
   rewritten wholesale, so a second device never sees what the first is typing and can overwrite it.
   A stop is already shared (it aborts the one agent run), but the queue and the draft are not.

## Goals

- A run that ends **naturally** (`agent/run-end` reason `settled`) drains the queue, as today.
- A run the reader **stopped** pauses the queue. A run that **failed** (`error`, `agent/fatal`) pauses
  it too. Nothing is sent until the reader chooses.
- A compaction's internal abort (pi compacts by aborting the run in flight) is not a stop and must
  keep the queue moving — so the pause is attributed to an explicit Stop, not to the reason alone.
- The paused queue appears on every connected device, with the reason and two choices: continue the
  interrupted answer, or send the queued message now. Per-row Edit / Send / delete stay.
- The queue is host-owned and persisted: it survives a reload, a closed tab, a host restart, and is
  visible from any device, phone included.
- The composer's **text** is relayed live to other devices for the same session. A second device can
  pick up what the first was typing.
- Queue changes and the pause are one state owned by one host process — no two devices can drain the
  same item.

## Non-goals

- Multi-host or remote-host sync. This is one browser host with several clients.
- A collaborative editor. There is no cursor, selection or conflict merge; the last text write wins.
- Image attachments in the live draft. Base64 screenshots stay on the device that attached them and
  ride with the prompt when sent. Pinned files are part of a queue item, not of the live draft.
- Protecting one device's saved attachments from another device's whole-file `drafts.json` save.
  That is today's behaviour and stays; the live text relay makes the *text* converge, the
  attachments file remains last-writer-wins.
- Changing VS Code's queue or drafts. The extension host does not advertise the new capability and
  keeps today's local queue and `drafts.json` behaviour.
- Accounts, people, permissions. Every client on the host already shares the same machine.
- Starting a cold session on its own to drain a persisted queue. The queue waits for the session to
  be opened; no queued item spawns an agent by itself.

## Anti-goals

- A client draining the queue. One owner, or two devices race the same item.
- Losing a queue because a browser closed.
- Firing queued work into a stopped or crashed run without the reader asking.
- A second transcript or a second agent state. The queue only sends prompts; transcripts and
  engines stay as they are.

## Current state (what the design replaces)

- `QueuedPrompts` (ui-angular) — in-memory, per browser, dropped on tab close and reload.
- `QueueDrain` (ui-angular) — fires the head on every settle, including a stop.
- `HostSessionController.promptInBackground` — already knows how to prompt a hot session that is not
  in front; the host-side hub uses the same `ChatService`.
- `agent/run-end` carries `reason: 'settled' | 'aborted' | 'error'`. The reason alone is not the
  signal: a compaction aborts the run internally, so the pause is attributed to the controller's
  `chat/abort` command. `agent/fatal` covers a dead process.
- `drafts.json` — a whole-file, last-writer-wins snapshot, only read at boot.
- The server gives each WebSocket its own `HostSessionController` over a shared `SessionRegistry`,
  `ChatService`, and `SessionTranscriptStore`. `MorseSessionFactory` is the composition root and
  already broadcasts host-wide state for bot mode (one shared service, one feed per client).

## Approaches

**A. Host-owned composer state (chosen).** A `ComposerHub` in `@morse/system`, created once by the
server's composition root, owns each session's queue and pause flag and relays draft text. It
subscribes to the shared registry's `agent/run-end` (the one place that sees every session's end,
including background ones), persists its state under `MORSE_HOME`, and broadcasts changes to every
connected socket. Clients send commands; the hub is the only dispatcher. Adds one wire side channel
and one server service; the existing `HostSessionController` only routes the new messages.

**B. Client-owned state with a host relay.** Keep each browser's queue and broadcast deltas. Rejected:
two devices can both dispatch the head, a closed browser loses the queue, and the "host restarted
while nobody was connected" case has no owner. It looks smaller and is not.

**C. Poll `drafts.json`.** Merge the file on a timer. Rejected: not realtime, and a whole-file merge
cannot tell which device's text is newer without tombstones and versions — a document protocol in a
scratch file.

A is the only shape that meets "visible on every device, persisted, one dispatcher". It also puts
the stop signal where the stop already lands, so every device sees the pause without a second
message.

## Design

### Host: `ComposerHub` (`packages/system/src/host/composer-hub.ts`)

Per session it holds:

```ts
interface SharedComposerPrompt {
  id: string;                 // host-assigned
  text: string;
  images?: PromptImage[];
  pins?: ChatPin[];
  compaction?: { instructions?: string };
}
interface SessionComposerState {
  queue: SharedComposerPrompt[];
  /** Absent when running normally; the reason the queue is paused otherwise. */
  paused?: 'stopped' | 'failed';
}
```

- **Run end.** On `agent/run-end` for a session:
  - an explicit Stop was requested (see below): if the queue is non-empty, `paused = 'stopped'`.
  - `error`: if the queue is non-empty, `paused = 'failed'`.
  - `settled`, and `aborted` without a Stop request (a compaction's internal abort, an engine
    change): if `paused` is absent and the queue is non-empty, dispatch the head.
  - `agent/fatal` behaves like `error`.
  Every change persists and broadcasts `composer/state`.
- **Stop attribution.** `aborted` is not enough: pi compacts by aborting the run in flight, and that
  must not pause the queue. The controller's `chat/abort` handler calls `hub.requestStop(sessionKey)`
  when the session is streaming; the hub holds that marker until that session's next `run-end`, so
  only the reader's Stop earns the pause. A Stop with no run in flight marks nothing.
- **Dispatch.** Shift the head, `chat.prompt(text, 'new', images, pins, sessionKey)` (or
  `chat.compact` for a compaction item), then `transcripts.userPrompt(...)` so every client viewing
  that session gets the user row. A per-session `dispatching` guard prevents two events draining
  twice. A prompt refused because the session is cold puts the item back at the head; it is not
  lost. It runs when the session is opened (`agent/ready`) or on the next `enqueue`, below.
- **Other drain triggers.** A run-end is not the only moment the head can be ready:
  - `enqueue` on a session that is idle (`!streaming && !busy`) and not paused dispatches the item
    immediately. This closes the race where the run settles between the keypress and the command
    arriving, and serves a queue added to an idle session from another device.
  - `agent/ready` for a session with a persisted queue and no pause dispatches the head, which is
    how a queue survives a host restart: it waits until that session is opened, then continues.
  A cold session's `send`/`continue` is refused; the item goes back and the hub broadcasts a notice
  saying the session has to be opened first.
- **Commands.**
  - `enqueue`: append. While paused it stays paused.
  - `remove`: remove; emptying the queue clears the pause.
  - `move`: reorder within the session (same rule as today).
  - `send`: remove that item and prompt it now — `steer` when the session is streaming, `new`
    otherwise; a compaction item compacts immediately. Clears the pause.
  - `continue`: clear the pause, then dispatch the head now.
  - `resume`: clear the pause only. Used by "continue the answer": the client sends a normal
    prompt through its own controller (which can restart an agent), and the next natural end drains
    the queue.
- **Manual prompts never clear the pause.** Only `continue`, `resume`, `send`, or an emptied queue
  do. A stop stays paused until the reader chooses.
- **Persistence.** `<MORSE_HOME>/composer.json`, versioned envelope via `workbench-store`'s slots,
  written atomically on every change (queue edits are user actions, not keystrokes — no debounce and
  no shutdown flush to lose), loaded at composition-root construction. Only sessions with a queue or
  a pause are stored. The cap matches the drafts file (32 MB).
- **Broadcast.** `subscribe(listener)` / `unsubscribe`. `MorseSessionFactory` adds each socket's
  emit on `createFor` and removes it on `release`; the hub's emit goes to all. On `client/ready`,
  the controller emits `composer/state` for every stored session and `composer/draft` for every
  session whose live text the hub is holding, so a device that connects mid-sentence sees what the
  first one is typing. Client boot never pushes restored `drafts.json` text back: only real input
  sends `composer/draft`.
- **Forget.** Deleting a session drops its state and persists.

### Wire (additive; no `PROTOCOL_VERSION` bump)

Host → client:

```ts
| { type: 'composer/state'; payload: { sessionId; queue: SharedComposerPrompt[]; paused?: 'stopped' | 'failed' } }
| { type: 'composer/draft'; payload: { sessionId; text; origin } }   // relayed keystrokes
```

Client → host:

```ts
| { type: 'composer/draft'; payload: { sessionId; text; origin } }
| { type: 'composer/queue'; payload:
    | { sessionId; action: 'enqueue'; item: { text; images?; pins?; compaction? } }
    | { sessionId; action: 'remove'; itemId: string }
    | { sessionId; action: 'move'; itemId: string; targetId: string }
    | { sessionId; action: 'send'; itemId: string }
    | { sessionId; action: 'continue' }
    | { sessionId; action: 'resume' } }
```

`origin` is a random per-page id. The hub echoes it; the sender ignores its own text echo, so typing
never round-trips. Queue broadcasts carry no text, so they cannot revert a newer keystroke.

### Capability and the fallback

`HostCapabilities.sharedComposer?: boolean`; the server host sets it, VS Code does not. Without it
the frontend keeps `QueuedPrompts` + `QueueDrain` exactly as today (single webview, no second
device). With it:

- A `ComposerSync` service applies `composer/state` to `QueuedPrompts` (new `replaceSession`,
  `paused`, `pausedReason`), and `composer/draft` to `ComposerDrafts` (new keyed `setFor`). Own
  origin is skipped.
- The composer's queue actions call `ComposerSync` (send commands) instead of mutating the store;
  the store updates from the broadcast, so every device shows the same order and ids.
- Draft input calls `ComposerSync.draft(text)` (debounced 250 ms) after the local
  `drafts.setText`.
- `QueueDrain` returns immediately when the capability is on; the host owns dispatch.
- `WorkspaceTabs.close` no longer forgets the queue on a shared host: the host keeps it, and
  reopening the session shows it again.

### UI (composer queue panel)

Above the queue rows, when `paused` is set:

```
┌ The queue is paused — the run was stopped.            [Continue answer] [Send queued] ┐
```

- "stopped" says *stopped*; "failed" says *failed*.
- **Continue answer** sends `Continue from where you stopped.` through the normal prompt path and
  then `resume`; the continued run's natural end drains the queue.
- **Send queued** sends `continue` (clear pause, dispatch the head now).
- Row Edit pulls the item into the local composer (text, images, pins) and removes it host-side;
  Send/Steer and delete stay as today.
- The banner hides when the queue is empty (the hub clears the pause then).

### Draft text persistence

The live relay is in-memory. Reload persistence stays with `drafts.json`: all connected devices
converge on the same text through the relay, so the whole-file save is consistent. A device that
was offline for a long time can boot with an older file, but the hub's live text overrides it as
soon as it connects. Attachments remain per device in the same file.

## Constraints

- `system` stays engine-agnostic; the hub uses `ChatService`/`SessionRegistry` only.
- No new user setting. The draft-relay debounce and the 32 MB cap are constants.
- The queue payload is bounded by the same cap as drafts; a client that pushes past it gets a
  refused save and the previous file stays.
- The hub never reads or rewrites an engine transcript; it only adds the user row for a prompt it
  sent.

## What is left to the builder

- The exact draft-relay debounce (250 ms suggested).
- Test layout: hub unit tests with a temp `dataDir` and fake chat/transcript/registry (natural
  drain, Stop pause, compaction abort does **not** pause, error pause, continue/resume/send,
  enqueue-on-idle, cold refusal keeps the item, persistence round-trip); protocol round-trip tests;
  `ComposerSync` tests (own-origin skip, apply remote text, paused banner); composer UI tests
  (banner actions, fallback path unchanged); server factory test that `composer/queue` reaches the
  hub and that the snapshot flushes on `client/ready`.
