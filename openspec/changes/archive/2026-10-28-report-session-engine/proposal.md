# Proposal

## Why

The composer's session-facts line labels a live OpenCode conversation `pi`. The session id it shows
is OpenCode's (`ses_…`), and the model provider says `opencode`, so the first fact is visibly wrong —
and switching engines, or having OpenCode installed beside pi, is the normal case for this host.
The engine already knows which kind it is; the view simply never asks.

## What Changes

- `SessionViewState.engine` stops being draft-only. For a running session it carries the kind of the
  engine that owns the session, so a frontend can label the session without falling back to the
  default engine.
- `AgentGateway` gains `readonly kind: string`. `Session` already declares it; the port was the one
  place that did not, so the registry could not answer "which engine is this?" from a gateway.
- `SessionRegistry.engineOf(key)` returns the owning kind for a hot session, and the host controller
  fills `view.engine` from it when projecting an active session.
- `AgentRouter` stops stamping a new non-default session with the default kind: `route()` takes the
  kind the session was actually created in, so the record and the in-memory gateway agree. This is
  what makes the reported engine correct for the first render as well as after a reload.
- The frontend keeps its current fallback for old hosts: absent `engine` still means "use the
  default engine", so a mixed-version pair keeps rendering something sensible rather than blank.
- Old sessions need no migration: a resumed session reports the engine its record names, which is
  how it was opened in the first place. Records already mis-stamped by the old router are repaired by
  the existing engine scan on the next reconcile, which protects running rows from a stale report.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `system/engine-routing`: adds the requirement that a running session reports the engine that owns
  it. The existing "a new session starts in the engine chosen for an empty session" requirement
  already says the record names the chosen engine; the router fix makes that true again for a
  non-default engine instead of changing the requirement.

## Impact

- `packages/agent`: `AgentGateway` contract (`kind`), already satisfied by `Session`.
- `packages/system`: `RoutedGateway` exposure, `AgentRouter.route()` kind propagation,
  `SessionRegistry.engineOf()`, `HostSessionController.currentState()`, and the view projection.
- `packages/protocol`: `SessionViewState.engine` doc comment loses its draft-only wording.
- `packages/ui-angular`: the composer keeps its fallback; its engine/mode spec stops encoding the
  buggy `pi` expectation for an OpenCode session.
- Tests: router creation for a non-default engine, registry `engineOf`, controller view state,
  view-state projection, and the composer facts line.
- No wire-version bump: the field already exists and is already optional. No new dependencies. A
  host that does not send it behaves exactly as today.
