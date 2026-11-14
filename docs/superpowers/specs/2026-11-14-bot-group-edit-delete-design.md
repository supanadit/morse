# Bot group edit/delete and session cleanup

Date: 2026-11-14
Status: proposed

## Intent

Bot mode can create bots, DMs and groups, but a group can never be changed or removed. The
group's members are also fixed for the life of its sessions: no code path invalidates a bot's
engine session when membership changes. This adds group editing and deletion, and makes
deletion leave no orphaned Morse or engine state.

The rule the owner set:

- **New discussion stays as it is.** It clears Morse's pointer to each member's engine session
  and leaves the engine's own files on disk. Nothing about it changes.
- **Only deleting a group removes engine sessions.** A group delete is the one place Morse
  reaches into each member's engine storage and removes that conversation's session.
- **Deleting a bot removes everything of the bot's own.** Its directory (and therefore every
  engine session it ever had), its DM conversation and transcript, every group membership and
  every session reference that names it.
- **A bot deletion leaves a group alone unless the bot was its last member.** One member left
  removes the membership; zero members left deletes the group.

## What exists today

- A group is a `GroupRecord` plus a `ConversationRecord` with the same id, title, members, lead
  and chain cap. Both live in `<dataDir>/bot/registry.json`.
- Each conversation keeps one session reference per participating bot:
  `conversation.sessions[username] = { engineSessionId?, toldUpTo? }`. The engine's own session
  lives in that bot's `sessions/` directory.
- `createGroup` is the only group mutation (`bot/groupCreate`). The New group dialog creates
  from the roster and nothing can reopen it.
- `deleteBot` removes the bot directory and the DM transcript. It does not remove the bot from
  groups, and it leaves session references to a bot that no longer exists.
- `BotTranscriptStore.forget` already removes a conversation's transcript.

## Approaches considered

1. **Cascade inside `BotService` (chosen).** Group update/delete and bot deletion are service
   operations. Membership changes clear the removed bot's session pointer; group deletion asks
   each bot's engine factory for an optional engine-native session removal; bot deletion removes
   the whole bot tree.
2. **Delete only Morse state, never engine files.** Simple, but a deleted group would leave one
   orphaned session per member forever, which is the mess this change exists to remove.
3. **Delete engine files by walking the bot's `sessions/` directory from the service.** Rejected:
   the layout differs per engine (pi's JSONL buckets, OpenCode's server storage) and the service
   is engine-agnostic by rule.

## Design

### Wire and service surface

- Add `BotGroupUpdateInput { id, name, members, lead?, chainCap? }` and `bot/groupUpdate`.
- Add `bot/groupDelete` with `{ id }`.
- Add `updateGroup` and `deleteGroup` to `BotControllerPort`; the session controller delegates
  them through `runBotAction`, like the other mutations.
- Both answer with a fresh `bot/roster` push. No new response shape is needed.

### Editing a group

`updateGroup` validates exactly as create does: non-empty name, at least one member, every member
exists, and a lead is a member. It updates the group record and the conversation together.

- **Removed member:** drop its warm gateway for this conversation (if one is live), and delete
  `conversation.sessions[member]`. The engine's own session files stay on disk, exactly like New
  discussion. If the member is re-added later, the missing pointer makes the next turn open a
  fresh session instead of resuming the old one.
- **Added member:** guarantee the same fresh start by removing any stale pointer for that member
  before it joins.
- **Kept members:** their pointers and warm gateways are untouched. Changing the name, lead or
  chain cap never touches a session.
- A live round for that group is stopped before the membership changes, so a queue cannot deliver
  to a bot that just left. The UI also disables editing while the group is answering, mirroring
  Edit bot.

### Deleting a group

1. Stop the round in flight, if any, and drop every warm gateway for the conversation.
2. For each member with a stored `engineSessionId`, ask that bot's engine factory to remove the
   session (`removeSession`, below) and clear the reference.
3. Forget the conversation transcript.
4. Remove the `GroupRecord` and the `ConversationRecord`, save the registry, emit the roster.

Engine cleanup is best-effort: a failure is logged and the Morse records are still removed, so a
broken engine cannot leave an undeletable row. The roster push clears an open conversation the
UI no longer sees (already handled by `BotState.onRoster`).

### Deleting a bot

1. Stop every round that includes the bot.
2. Drop its warm gateways, dispose its factory, and remove its directory. This is what removes
   every engine session it owned — no per-session engine call is needed.
3. Forget its DM transcript and remove its DM conversation.
4. For every group: remove its username from `members` and `sessions`; clear `lead` when it was
   the lead.
5. If a group now has no members, delete that group too, forgetting its transcript. If it still
   has members, keep the group, its history and the remaining members' sessions.
6. Save the registry and emit the roster.

### Engine-native session removal

Extend the bot factory contract with an optional `removeSession(engineSessionId)`:

- **pi:** unlink the session file through `PiRpcSessionCatalog.remove` (the stored id is pi's
  session-file path, already confined to the bot's `sessions/` directory).
- **OpenCode:** delete through its session catalog (`DELETE /session/{id}`) using the factory's
  engine, starting it only if this is the first use after a host restart.
- **Any engine without the hook:** the pointer is cleared and the cleanup is reported in the log;
  the group deletion still succeeds.

### UI

- `MorseService.ui` gains `groupTarget: signal<string | null>`; `groupOpen` keeps its meaning.
- The New group dialog becomes the New/Edit group dialog. When `groupTarget` names a group it
  prefills name, members, lead and chain cap from the roster summary, and the title/action read
  “Edit group” / “Save changes”. Otherwise it behaves exactly as it does now.
- The group row's menu gains:
  - **Edit group…** — opens the dialog for that group.
  - **Delete group…** — asks for confirmation inside the menu, like Delete bot, then sends
    `bot/groupDelete`.
- Both entries are disabled while that group is answering, with the same “wait for the turn to
  end” title the bot menu uses.
- Adding a new group clears `groupTarget`; opening Edit sets it. Closing the dialog clears it.

## Non-goals

- No change to New discussion, and no engine session deletion on member removal or bot edit.
- No group duplication, archiving, export or history migration.
- No change to how editors or code-mode sessions are stored.

## Verification

- Service tests: update membership clears only the removed member's pointer and drops its gateway;
  adding a member starts it without a stale pointer; group delete removes transcript, records and
  calls engine removal for each stored session; bot delete removes groups only when emptied,
  clears leads and session references, and removes the bot tree.
- Wire/controller tests: both new messages reach the service and answer with a roster.
- UI tests: dialog prefills and submits an update; group menu edits, confirms and deletes;
  answers that arrive while the group is answering disable both actions.
