# @morse/adapter-pi-rpc

The **driven adapter** that runs the [pi](https://github.com/earendil-works/pi) coding agent as an RPC
subprocess and implements the `@morse/core` ports against it.

Part of the [Morse](../../README.md) monorepo. It spawns `pi --mode rpc`; it never imports `pi` at
runtime (the agent and its ~400 MB of dependencies stay pi's own process).

## What is in here

| File | Contents |
|---|---|
| `src/create-pi-rpc-adapter.ts` | `createPiRpcAdapter()` — wires the factory, catalog and MCP adapter into the ports both hosts consume |
| `src/pi-rpc-agent.ts` | `PiRpcAgent` — one session: `get_state`, prompt/steer/follow-up, model & thinking levels, compaction, history, stats |
| `src/pi-rpc-agent-factory.ts` | Spawns agents, and the session-less probe used for the empty draft |
| `src/pi-rpc-session-catalog.ts` | Lists/resumes/deletes persisted sessions (with the size+mtime scan cache) |
| `src/pi-mcp.ts` | `PiMcp` — lists server state via `pi mcp list --json` and edits `mcp.json` (add/remove/enable, per-project overrides) |
| `src/internal/rpc-client.ts`, `internal/jsonl-framer.ts` | JSONL framing (split on LF only, strip CR) and command/response correlation |
| `src/internal/event-mapping.ts` | pi session events → Morse agent events |
| `src/internal/resolve-pi.ts` | Resolves the `pi` binary / node entry, and `resolvePiCli` for shell subcommands |
| `src/internal/spawn-env.ts` | Strips `NODE_CHANNEL_FD` from a spawn's env (a `node --watch` parent would otherwise break the child) |

## Spawning

`resolvePi()` builds the RPC args (`--mode rpc`, session dir/path, extra args); `resolvePiCli()` is
for `pi mcp …`, which must run the real CLI rather than the RPC entry. Every external `pi` gets a
[`cleanSpawnEnv`](src/internal/spawn-env.ts) so an inherited IPC channel never kills it.

```bash
npm run test -w @morse/adapter-pi-rpc
npm run check-types -w @morse/adapter-pi-rpc
```
