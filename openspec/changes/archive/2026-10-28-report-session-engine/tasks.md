# Tasks

## 1. Contract and view shape

- [x] 1.1 Add `readonly kind: string` to `AgentGateway` in `packages/agent/src/ports.ts`, documented as the `AgentEngineRef.engine` value the session's records carry; verify `npm run check-types -w @morse/agent` and confirm `Session` already satisfies it.
- [x] 1.2 Update the `SessionViewState.engine` doc comment in `packages/protocol/src/dto/view.ts` from "the draft chose" to "the engine that owns this view, when the host can name it"; verify `npm run check-types -w @morse/protocol`.
- [x] 1.3 Give the type-checked gateways the new field: `FakeGateway` in `agent-router.spec.ts` and `service.spec.ts`, `fakeGateway` in `session-controller.spec.ts`, and OpenCode's private `ProbeGateway` (reporting its factory's kind); verify `npm run check-types` across the workspaces.

## 2. Router stamps the engine that created the session

- [x] 2.1 Make `AgentRouter.route()` require the kind: pass `record.engineRef.engine` on resume and the resolved `kind` on create, and remove the `?? this.defaultKind` fallback. Verify the existing `agent-router.spec.ts` suite still passes.
- [x] 2.2 Expose the carried kind as `RoutedGateway.kind` and have the gateway use it everywhere it currently reaches into `options.kind`; verify `npm run check-types -w @morse/system`.
- [x] 2.3 Add a router test with a second registered engine: a new session in the non-default engine must report that kind, write `engineRef.engine` as that kind, and derive a Morse id from that kind, not the default. Verify `npx vitest run src/session/agent-router.spec.ts`.
- [x] 2.4 Add a router test that resuming a recorded session reports the record's engine even when the default is a different kind, and that a forked gateway keeps the kind. Verify the same suite.
- [x] 2.5 Note in `docs/ARCHITECTURE.md` (the registry bullet list) that a new session is stamped with the engine that created it and an existing one keeps its record's engine; verify the prose matches the tested behavior.

## 3. Registry, view projection and controller

- [x] 3.1 Add `SessionRegistry.engineOf(key)` beside `stateOf`, returning the hot gateway's kind and `undefined` for a cold key; verify with `service.spec.ts` cases for a hot session, an unknown key and a closed session.
- [x] 3.2 Extend `toSessionViewState(state, meta, engine?)` to set `view.engine` only when a kind is supplied; verify `view-state.spec.ts` covers a supplied kind and an omitted one.
- [x] 3.3 Fill the engine in `HostSessionController.currentState()` for the running-session branch from `registry.engineOf(key)`, leaving the draft branch on `draftEngine`; verify with a `session-controller.spec.ts` test that a live OpenCode gateway yields `engine: 'opencode'` while a draft with another pick still yields the pick.
- [x] 3.4 Add a controller test that a session switch with no state yet does not invent an engine, so the existing switch-gap behavior is unchanged; verify the same suite.

## 4. Composer and docs

- [x] 4.1 Update `composer.engine-mode.spec.ts` so the running-session case sets `engine: 'opencode'` and expects the OpenCode label rather than `pi`; verify `npm run test -w @morse/ui-angular`.
- [x] 4.2 Add a composer case for an older host (`engine` absent) that still renders the default engine's label, locking the fallback; verify the same suite.
- [x] 4.3 Document in `docs/FRONTENDS.md` that the session-facts engine comes from the view and falls back to the default only when the host omits it; verify every touched statement matches the composer tests.

## 5. Integration checks

- [x] 5.1 Run `npm run check-types`, `npm run lint` and `npm run test:fast`; verify they pass with no new failures.
- [x] 5.2 In a host with pi installed and OpenCode configured, start a session in the empty composer with the engine picker set to OpenCode and verify the session facts read OpenCode, not pi, and still read OpenCode after a window reload.
- [x] 5.3 Restart the host against an index containing a session created by the old router and verify the refresh leaves one correctly stamped row that resumes into its owning engine.

## Workflow follow-up

- Archive the change after review so the new requirement lands in `system/engine-routing`.
- Keep `add-selection-columns` separate; the two changes touch no shared files.
