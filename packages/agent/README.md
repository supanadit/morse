# @morse/agent

The **harness contract**: what any coding-agent engine (`pi`, OpenCode, …) must expose so that
Morse can drive it without knowing which one it is.

Part of the [Morse](../../README.md) monorepo.

## The one rule

**This package never imports an application symbol.**

Nothing in here may name a session record, a session store, a session catalog, a reconcile policy, an
id scheme, `vscode`, NestJS, a `node:*` built-in, or `@morse/system`. If a type feels like it belongs
here but mentions Morse, it belongs in `@morse/system`.

### How that is enforced

By **`scripts/check-agent-boundary.mjs`**, which `npm run lint` runs first and CI therefore runs on
every push. It reads this package's source, strips comments, and fails on a specifier naming a
forbidden package — including a type-only import.

It is *not* enforced by the empty `dependencies` below. npm workspaces hoist every package into the
root `node_modules`, so `import type { MorseSessionRecord } from '@morse/system'` inside this package
would type-check cleanly even with no dependency declared. That was verified, not assumed — the
manifest field documents intent, the script does the work.

```json
"dependencies": {}
```

## What is in here

| Path | Contents |
|---|---|
| `src/domain/model.ts` | `ThinkingLevel`, `THINKING_LEVELS`, `ModelInput`, `MODEL_INPUTS`, `ModelRef`, `AgentCommand`, `NoticeLevel` |
| `src/domain/usage.ts` | `PromptImage`, `ChatPin`, `TokenUsage`, `ContextUsage`, `SessionCounts`, `SessionSpeed` |
| `src/domain/workspace.ts` | `WorkspaceRef` — every harness needs a working directory |
| `src/domain/agent/state.ts` | `AgentSessionState`, `AgentWidget`, `AgentStatus`, `AgentDiagnostic`, `JsonValue`, `ToolResultDetails` |
| `src/domain/agent/events.ts` | `AgentEvent` and its 13 event interfaces over `AgentEventBase` |
| `src/domain/agent/history.ts` | `AgentHistoryEntry`, `AgentMessageEntry`, `AgentToolEntry`, `AgentCompactionEntry` |
| `src/domain/agent/interaction.ts` | `AgentInteractionRequest` and its 4 request interfaces, `AgentInteractionResponse`, `AgentForkMessage`, `SelectOption` |
| `src/ports.ts` | `AgentGateway`, `AgentGatewayFactory`, `AgentHistoryPage`, `PromptMode`, `PromptDisposition`, `AgentEventListener` |
| `src/session.ts` | `abstract class Session` — one conversation, with the listener fan-out and the state every adapter must get right the same way |
| `src/engine.ts` | `abstract class SessionEngine` (`kind`, `factory`, optional `scan()`, `hasScan`) and `AgentSessionInfo` |

## How an adapter uses it

Extend `Session` for one conversation, extend `SessionEngine` for the harness, and implement
`scan()` only if the harness can enumerate its own stored sessions. Everything else — deriving
Morse's session ids, translating a report into a record, merging it into the index — happens in
`@morse/system`, so the adapter never learns that Morse has ids or an index.

```bash
npm run build -w @morse/agent
npm run check-types -w @morse/agent
node scripts/check-agent-boundary.mjs    # the real boundary check
```

See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) for where this sits relative to the other
packages.
