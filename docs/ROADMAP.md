# Roadmap — an agent-agnostic Morse

Goal: make a Morse session independent of the pi harness, so any engine (`pi`, OpenCode, …)
can drive the same session, sidebar and transcript.

## Done when

1. A session's id is Morse's, not a path into an engine's storage.
2. `~/.pi` deleted: the sidebar still lists every session with its title.
3. Two engines installed: a session reopens through the one that made it.
4. A session started with `pi` in a terminal shows up in Morse by itself.
5. No package above `adapter-*` names an engine.

None are true today. Details and traps: [`NOTES-AGENT-AGNOSTIC.md`](NOTES-AGENT-AGNOSTIC.md).

## Work items

No phases, no fixed order — each item stands on its own and can be picked up whenever it
becomes the useful thing to do. The one hard link is marked.

- **SessionStore on disk** — one JSON per session, sharded dirs, JSONL index + snapshot, in a global data dir.
- **Scan token** — `Math.trunc(updatedAt):count`. Cheap now; after an index exists it forces a full re-read.
- **pi import** — one-off, idempotent via a marker file, so existing sessions appear in the index.
- **Id becomes the key** — `sessionKey` = `record.id` across registry, transcripts and wire.
  *Pairs with tab migration: changing what `id` means without it loses restored tabs.*
- **Tab migration** — `workbench.json` tabs from old path-ids to new ids.
- **Reconcile at startup** — background, never on the `list()` path.
- **Delete the duplicates** — `SessionRegistry.absorb()`, `derivedTitle()`, the catalog's title fallback.
- **CapabilitySet** — per-engine `mcp`, `prompts`, `version`, `cli`, `fork`; `HostCapabilities` projects it.
- **Split the pi-only half** of `PiRpcAdapter` behind those ports, so hosts stop injecting the concrete type.
- **`adapter-opencode`** — a `Session` + `SessionEngine` of its own.
- **Frontend degrades per capability** instead of rendering dead rows.

## Not doing

- Morse will not own the transcript. Losing `~/.pi` still loses the conversation.
- Morse will not reimplement an agent loop.
- Not designed for millions of sessions; 10 000 per host is the ceiling worth optimising.
- No manual "sync" button — reconcile is automatic.

## Check

`npm run check-types --workspaces` clean, `npm test` at 85 files / 765 tests or better.
The honest test: `mv ~/.pi ~/.pi.bak`, restart, confirm the sidebar still lists and titles everything.
