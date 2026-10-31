# Design

## Context

See `proposal.md` for the bug and `specs/system/engine-routing/spec.md` for the behavior contract.

The label has two independent defects, and fixing only one leaves a wrong value somewhere:

1. **The view omits the engine for a live session.** `draftSessionViewState()` sets `engine` from the
   draft's pick; `toSessionViewState()` — the projection used once a session exists — has no engine
   field at all. The composer then falls back to the engine marked `default`, which is pi on a host
   with both engines installed.
2. **The router stamps a new session with the default kind.** `AgentRouter.create()` resolves the
   chosen kind, creates the adapter in it, then calls `route(inner, { cwd })`. `route()` derives the
   wrapped kind from `record?.engineRef.engine ?? this.defaultKind`, so a new OpenCode session is
   wrapped with `kind: 'pi'`. That kind feeds the derived session id and the record's
   `engineRef.engine`, not just a label.

The engine kind is not missing from the system: adapters already declare `Session.kind`,
`RoutedGateway` already stores a kind, and the index record already carries the engine. The gap is
the contract (`AgentGateway` does not require `kind`) and one call site that substitutes the default.

## Goals / Non-Goals

**Goals:**

- A live session's view names its owning engine on the first render and after every reload.
- One source of truth for the kind: the gateway that drives the session.
- A new session created in a non-default engine is stamped with that engine in its record and its
  derived id.
- No wire bump and no blank facts line against an older host.

**Non-Goals:**

- Changing how the engine picker behaves, or making the engine mutable for a running session.
- Adding a new field to `AgentSessionState`. The engine's state describes the conversation; the kind
  identifies the adapter, and the gateway already knows it.
- Repairing old records with a bespoke migration command. The existing reconcile already does the
  repair (see Migration Plan).
- Showing a historical engine per transcript entry; the facts line is session-scoped.

## Decisions

### Put `kind` on the `AgentGateway` contract

`AgentGateway` gains `readonly kind: string`. `Session` already declares it abstract, so pi and
OpenCode need no change; only the test doubles and OpenCode's `ProbeGateway` must answer it.

Why: the registry holds gateways, not engines. Without the contract field it cannot answer "which
engine owns this session?" without either re-reading the record (I/O in a synchronous projection) or
threading the kind through `open()` (which is undefined when resuming). The gateway is created by the
engine's own factory, so it is the authoritative object for the session's lifetime, including a fork
that re-keys the session without a new gateway.

Alternatives considered:

- **Add `engine` to `AgentSessionState`.** Every adapter would repeat its own kind in every snapshot,
  and the state is defined by the harness contract, which deliberately contains no engine identity.
  Rejected.
- **Read the index record by session id in the controller.** The controller's projection is
  synchronous and already has the state; adding an async lookup per emit would race reloads. The
  record also does not exist yet for a just-created session. Rejected.
- **Store the kind in `HotSession` when it is opened.** On resume the caller passes no engine, so the
  value would have to be recovered from the record or the router; that is the same information the
  gateway already owns, duplicated. Rejected.

### `RoutedGateway` exposes the kind it already stores and loses the default fallback

`RoutedGateway` gets `readonly kind = options.kind`, and `AgentRouter.route()` requires an explicit
kind: `record.engineRef.engine` when resuming, the resolved `kind` when creating. The
`?? this.defaultKind` fallback is deleted.

Why: the fallback is the second defect. A new session must be wrapped with the kind whose factory
produced it; making `route()` require that value removes the only place where a non-default creation
could silently become the default. Resume keeps using the record, which is what makes a reopened
session stay with its owning engine even when the draft currently selects another.

### The controller supplies the engine to the view projection

`SessionRegistry.engineOf(key)` returns `hot.get(key)?.gateway.kind` (undefined for a cold key), and
`HostSessionController.currentState()` passes it to `toSessionViewState(state, meta, engine)`. The
projection sets `view.engine` only when a value is supplied. Drafts keep setting `engine` from
`draftEngine` through `draftSessionViewState()`.

Why put it in the projection rather than assign `view.engine` after the call: both draft and live
views then assemble the same field in one module, and the mapping stays a pure function a unit test
can cover. `SessionStateMeta` remains about lifecycle flags, not identity, so the engine travels as
its own argument.

Why not let the controller read `registry.active()`: it projects sessions other than the active one
(a pinned tab or a background drain), so the lookup must take the view's key.

### The frontend keeps its fallback

`composer.currentEngine()` stays `state.engine ?? default engine ?? ''`. A host that predates this
change sends no engine for a live session; the composer must keep rendering a label rather than an
empty fact. A new frontend with an old host therefore behaves exactly as today, and an old frontend
with a new host simply ignores the extra value.

### Mis-stamped legacy records repair through the existing reconcile

No data migration is written. A record created by the old router for an OpenCode session carries
`engine: 'pi'` and therefore a pi-derived Morse id. On the next host start or index refresh, the
OpenCode scan reports the real session under the OpenCode-derived id, and the pi scan finds the stale
row absent from its own report and removes it. The transient result is a duplicate row; the settled
result is the correct one. A row currently running is protected from removal by the running set.

This is also why the router fix matters beyond the label: until the record is re-stamped, resuming
that id routes to the pi factory with an OpenCode session id.

## Risks / Trade-offs

- **A mis-stamped record can be opened before the repair lands** → The stale row keeps the pi kind
  and fails to resume; a refresh (which `create()` already performs first) usually repairs it. The
  running set and the next reconcile converge on the correct row. Documented rather than hidden.
- **`AgentGateway.kind` breaks every hand-written test double at compile time** → That is the point:
  the compiler lists them. Add the small `kind` field to `FakeGateway` in `agent-router.spec.ts` and
  `service.spec.ts`, to `fakeGateway` in `session-controller.spec.ts`, and to OpenCode's
  `ProbeGateway` (which reports its factory's kind). No runtime change for adapters.
- **An engine can disappear while a session is hot** → The host still reports its kind, but the
  frontend cannot find a label for a kind absent from the engine list, so the fact is omitted rather
  than mislabelled. Accepted; removing a running engine is already a host-level error.
- **The fact is still a label, not a mode switch** → A reader sees the owning engine but cannot
  change it, which matches the existing rule that an engine is fixed once a session exists.
- **A session switch briefly projects a draft view** → `view.engine` is absent in that gap and the
  frontend falls back to the default. The gap already hides the engine picker; no new flicker is
  introduced.

## Migration Plan

1. Contract: add `kind` to `AgentGateway`; let the compiler surface the doubles and `ProbeGateway`.
2. Registry: expose `engineOf(key)`.
3. Controller and projection: set `view.engine` for a live session; keep the draft path untouched.
4. Router: pass the resolved kind into `route()`, expose it on `RoutedGateway`, and delete the
   `defaultKind` fallback.
5. Tests and docs: update the composer engine/mode spec that encodes the bug, and the
   `SessionViewState.engine` doc comment.

Rollback is safe at every step: `SessionViewState.engine` is already optional, so a reverted host
leaves the frontend on its fallback, and a reverted frontend ignores the new value. No stored format
changes, and the old mis-stamped rows are already repaired by reconcile.

## Open Questions

None that affect the specs or the task breakdown. Whether the composer should show the raw engine
kind when the engine is no longer reported is a display detail, not part of this change.
