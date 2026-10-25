# Agent-agnostic sessions — delivery notes

The work that makes a Morse session independent of the pi harness has shipped. This file records the
decisions and traps worth keeping; the architecture lives in [`ARCHITECTURE.md`](ARCHITECTURE.md) and the
inventory in [`STATUS.md`](STATUS.md).

## What Morse owns, and what it does not

| Area | Owner now |
|---|---|
| Conversation content | **the engine** (pi's JSONL files, OpenCode's server storage) |
| Session identity | **Morse** — `deriveSessionId({engine, sessionId})`, stored in `MorseSessionRecord` |
| Session title | the engine when it names one; Morse derives it from the first prompt until then |
| Agent execution | the engine: a pi subprocess, or a shared OpenCode server |

The record holds metadata only: id, title, cwd, `engineRef`, timestamps, message count, parent. The transcript
is never duplicated.

## Decisions that landed

1. **The id is derived, not generated.** Two hosts that discover the same engine session mint the same Morse
   id with no lock and no coordination; `engineRef` carries the engine's own id so a resume returns to it.
2. **The router is the one resolution point.** `AgentRouter` wraps every gateway so `state().sessionId` is
   Morse's id, resolves a persisted id through the record to the owning engine, re-derives after a fork, and
   serves the sidebar from the index. The registry still keys on `state.sessionId`.
3. **The index is a file store, not a database.** `FileSessionStore` keeps one JSON per record
   (`records/<shard>/<id>.json`, atomic tmp+rename) and an append-only `index.jsonl` of `{token, record}` lines
   (last-wins on load; compacted past twice the record count). The token is the engine's last report marker, so
   reconcile skips unchanged sessions without reading transcripts.
4. **Reconcile on read, not at startup.** `ensureFresh()` runs behind a debounce and an in-flight guard, once
   per engine and scoped to its kind. A scan that throws leaves that engine's rows alone. A session Morse is
   currently running is protected from a report that omits it (the engine may still be writing its file): the
   first live implementation lost its own new session to exactly that race.
5. **Engine-only features are optional ports.** `AgentExtras` (`mcp`, `prompts`, `version`, `cli`) lives on
   `AgentIntegration`; the hosts read the default engine's extras. OpenCode supplies none, so the MCP editor,
   prompt editor and pi version notice are absent instead of dead UI.
6. **A form is its own interaction kind.** Several typed fields do not fit a select; `AgentFormRequest` travels
   the same contract/wire/panel path, and a host with native dialogs still sends it to the frontend.

## OpenCode specifics worth remembering

- One long-lived server, Basic auth, one global SSE stream. The adapter attaches (`MORSE_OPENCODE_URL` +
  password) or spawns `opencode serve --hostname 127.0.0.1 --port 0` and reads its announced address/password;
  only the spawned server is stopped with the host.
- The server's own names are used directly: events arrive under `data` (some builds `properties`), sessions have
  `location.directory`, messages page newest-first with `cursor.next` going older, thinking levels are model
  `variants` (`none` means `off`, `default` is a sentinel mapped to a real level), fork returns a new session,
  compaction takes no instructions.
- Prompts take `files: [{uri}]` (real paths), so images are written to a temp directory for the session's
  lifetime; pins become `@path[:start:end]` mentions in the prompt.
- Forms and permissions are pulled from the server's pending lists on connect and at execution boundaries, with
  the SSE events (`form.created`, `permission.asked`) as the primary source; the announced set keeps the two
  from showing a request twice.

## Known limitations

- A form's `when` list is ANDed by OpenCode; Morse's condition compares one field, so a multi-condition field
  is shown unconditionally (hiding a required field would strand the reader).
- An `external` form field (a browser handshake) becomes a "finished" checkbox; the frontend has no browser to
  open outside the host.
- OpenCode reports no message count on a session record, so its rows show `0` until the transcript replays.
- The OpenCode agent picker is deliberately not wired; the catalog is read but nothing in the session state
  carries selectable agents yet.
