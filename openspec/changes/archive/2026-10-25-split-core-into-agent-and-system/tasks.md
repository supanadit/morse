# Tasks

Baseline before this change: `npm test` = **85 files / 765 tests**; `check-types --workspaces`
clean; `tsc -p packages/ui-angular/tsconfig.app.json --noEmit` clean. Every verification below
compares against that.

## 1. Create the two packages

- [x] 1.1 Create `packages/agent/` with `package.json` (name `@morse/agent`, `private: true`,
  `type: module`, `dependencies: {}`), `tsconfig.json` copied from `packages/core`, and
  `src/index.ts`; verify `npm run build -w @morse/agent` succeeds on the empty barrel
- [x] 1.2 Create `packages/morse/` with `package.json` (`@morse/system`, `private: true`,
  `dependencies: { "@morse/agent": "*" }`), `tsconfig.json` copied from `packages/core`, and
  `src/index.ts`; verify `npm run build -w @morse/system` succeeds
- [x] 1.3 Add both to root `package.json` `build:libs` in dependency order —
  `protocol → agent → morse → host-runtime → adapter-pi-rpc` — and verify `npm install` links
  both under `node_modules/@morse/`

## 2. Move the harness contract into `@morse/agent`

Per design D3, this package must not import any Morse application symbol.

- [x] 2.1 Move `domain/model.ts`, `domain/usage.ts` (only `PromptImage`, `ChatPin`, `TokenUsage`,
  `ContextUsage`, `SessionCounts`, `SessionSpeed`), and `WorkspaceRef` out of
  `domain/session.ts` into `agent/src/domain/`; verify `npm run check-types -w @morse/agent` is
  clean and every symbol listed in design D3's `agent` rows is exported from `@morse/agent`
- [x] 2.2 Move `domain/agent/` (state, history, interaction, events) into `agent/src/domain/agent/`;
  verify `AgentEvent` still narrows and exhausts — add a temporary `const never: never = event`
  switch over all 13 variants, confirm `tsc` rejects a missing case, then remove it
- [x] 2.3 Move `session/ports.ts`'s harness half (`PromptMode`, `PromptDisposition`,
  `AgentGateway`, `AgentGatewayFactory`, `AgentEventListener`, `AgentHistoryPage`) into
  `agent/src/ports.ts`; verify no import in `packages/agent/src` names `SessionStore`,
  `SessionSource`, `MorseSessionRecord` or `reconcile`
- [x] 2.4 Move `session/session.ts` (`abstract class Session`, `SessionLogger`) into
  `agent/src/session.ts`; verify a throwaway subclass still compiles and that `state()` returns a
  copy — mutate a returned `availableModels` array and assert the next read is unchanged
- [x] 2.5 Move `session/engine.ts` into `agent/src/engine.ts` **removing `reconcile()` and the
  `catalog` member** (D7), adding `interface AgentSessionInfo` and changing `scan?()` to return
  `AgentSessionInfo[]`, keeping `kind`, `factory`, `get hasScan`; verify `hasScan` is `false`
  without `scan()` and `true` with it, that `AgentSessionInfo` references no Morse type, and that
  `grep -n "SessionCatalog\|MorseSessionRecord\|\.reconcile(" packages/agent/src` returns nothing
- [x] 2.6 Write `packages/agent/README.md` stating the one rule this package exists to enforce
  (no application logic) and naming what it must never import; verify every import in the file
  list it gives actually resolves

## 3. Move Morse's own logic into `@morse/system`

- [x] 3.1 Move `session/record.ts`, `session/identity.ts` into `morse/src/`, and add
  `toSessionRecord(kind, info): MorseSessionRecord` which owns the id, parent link, title fallback
  and version; verify `deriveSessionId` still yields a 14-character `[a-z0-9]+` id stable across two
  separate `node` processes, and that a test can build a record from a plain `AgentSessionInfo`
  literal with no adapter and no storage
- [x] 3.2 Move `session/ports.ts`'s Morse half (`SessionCatalog`, `SessionPage`, `SessionStore`,
  `SessionSource`, `DEFAULT_SESSIONS_PER_PROJECT`, `DEFAULT_SESSION_SEARCH_LIMIT`) into
  `morse/src/ports.ts`, leaving `SessionScanEntry` behind (3.3 deletes it); verify
  `npm run check-types -w @morse/system` is clean
- [x] 3.3 Move `session/reconcile.ts` into `morse/src/`, changing `planReconcile` and
  `reconcileSessions` to accept the harness's `AgentSessionInfo[]` and translate via
  `toSessionRecord`; delete `SessionScanEntry`; verify `planReconcile` still returns zero upserts
  for an unchanged token, still leaves another engine's records untouched, and that
  `grep -rn SessionScanEntry packages` returns nothing
- [x] 3.4 Move `session/service.ts` (`SessionRegistry`), `chat/` (`ChatService`, `ChatAgent`,
  `ChatAgentHolder`, `PromptOutcome`), `context/ports.ts`, `errors.ts`, `logger.ts` into
  `morse/src/`; verify `npm run check-types -w @morse/system` is clean
- [x] 3.5 Add `AgentIntegration` (`engine`, `factory`, `catalog`) to `morse/src/` and make
  `PiRpcEngine` implement it, with `SessionRegistryDeps.engine` optional and used only by
  `reconcile()`; verify both composition roots compile without changing how they read
  `adapter.factory` / `adapter.catalog`, and that
  `grep -rn "engine\.catalog\|engine\.factory" packages` still returns nothing
- [x] 3.6 Write `packages/morse/README.md` describing Morse's domain and use cases and pointing
  at `docs/ROADMAP.md` for the index work that is not yet built; verify the paths it names exist

## 4. Rewire the consumers

- [x] 4.1 Rewrite `packages/integration-pi` imports (40 symbols) between `@morse/agent` and
  `@morse/system`, and reduce `PiRpcEngine.scan()` to plain mapping onto `AgentSessionInfo[]` —
  it must no longer import `deriveSessionId` or build a record; verify
  `npm run check-types -w @morse/integration-pi` is clean,
  `grep -n "deriveSessionId\|MorseSessionRecord" packages/integration-pi/src` returns nothing, and
  `npm test -w @morse/integration-pi` still reports 181 tests
- [x] 4.2 Rewrite `packages/host` imports (23 symbols); verify
  `npm test -w @morse/host` still reports its previous count
- [x] 4.3 Rewrite `packages/extension` (7 symbols) and `packages/server` (5 symbols) imports; all
  of these are `morse` symbols — verify `npm run check-types -w @morse/extension` and
  `-w @morse/server` are clean
- [x] 4.4 Verify `packages/protocol`, `packages/ui-runtime` and `packages/ui-angular` were not
  touched: `grep -rn "@morse/core" packages/protocol packages/ui-runtime packages/ui-angular`
  returns nothing both before and after

## 5. Remove `@morse/core` and fix what named it

- [x] 5.1 Delete `packages/core/` and remove `@morse/core` from `build:libs`; verify
  `grep -rn "@morse/core" packages docs README.md` returns nothing
- [x] 5.2 Fix `packages/morse-web/build.mjs` — it bundles by folder path
  (`join(packagesRoot, 'core', 'dist', 'index.js')`, line 71) and a comment on line 18; verify
  `npm run build:web` succeeds, since a package-name grep cannot catch this
- [x] 5.3 Update `docs/ARCHITECTURE.md`: the package table, the layer diagram, the port table, and
  rules R1/R2/R6 all name `core`; verify every package named in the file exists under `packages/`
- [x] 5.4 Update root `README.md` if it names `core`; verify the build commands it prints run as
  written

## 6. Integration check

- [x] 6.1 Run `npm run check-types --workspaces` and `npx tsc -p
  packages/ui-angular/tsconfig.app.json --noEmit`; both clean, matching the baseline
- [x] 6.2 Run `npm run build` over all packages; verify all 10 succeed and
  `dist/index.js` exists for each of `agent`, `morse`, `protocol`, `host-runtime`,
  `adapter-pi-rpc`, `ui-runtime`
- [x] 6.3 Run `npm test` and confirm **85 files / 765 tests** — identical to the baseline, with no
  test body edited
- [x] 6.4 Add `scripts/check-agent-boundary.mjs` (house pattern: a standalone `node` script) that
  fails when `packages/agent/src` names `@morse/system`, an adapter/host package, a `node:` built-in
  or a host framework — because npm hoisting makes an empty `dependencies` unable to enforce it;
  wire it first in `npm run lint` so CI runs it; verify it exits 1 for `import type { X } from
  '@morse/system'` and for `import 'node:fs'`, exits 0 for a comment that merely mentions
  `@morse/system`, and exits 0 on the clean tree
- [x] 6.5 Keep `dependencies: {}` in `packages/agent/package.json` as a statement of intent and say
  so in its README; verify `node -p "JSON.stringify(require('./packages/agent/package.json').dependencies)"`
  prints `{}`, and that the README explains the boundary check is what actually enforces it

## 7. Rename the remaining imprecise packages

Folded in from what was going to be a separate change: the names are mechanical, but `grep` for a
package name does not find a folder path, so each rename has an extra check.

- [x] 7.1 `packages/adapter-pi-rpc` → `packages/integration-pi`, package
  `@morse/adapter-pi-rpc` → `@morse/integration-pi`; verify
  `grep -rn "adapter-pi-rpc" packages docs scripts .github README.md` returns nothing, and
  `npm test -w @morse/integration-pi` still reports 181 tests
- [x] 7.2 Fold `packages/host-runtime` into `packages/system/src/host/` (option B — not a package
  of its own); add `@morse/protocol` to `system`'s dependencies plus `types: ["node"]`,
  `exclude: ["src/**/*.spec.ts"]`, a `test` script, `vitest` and `@types/node`; verify
  `grep -rn "host-runtime" packages docs scripts .github README.md` returns nothing and
  `npm test -w @morse/system` reports the 89 tests that used to be `host-runtime`'s
- [x] 7.3 Fix the folder-path references a package-name grep cannot find —
  `packages/morse-web/build.mjs` (two `join(packagesRoot, …)` entries),
  `scripts/check-pi-coverage.mjs` (`packages/integration-pi/dist`), and
  `.github/workflows/pi-install-coverage.yml` (`paths:` filters); verify `npm run build:web`
  succeeds and `node scripts/check-pi-coverage.mjs` finds the adapter
- [x] 7.4 Update `docs/ARCHITECTURE.md` (arrow diagram, package table, layer list, R3/R4, the
  controller and transcript-store prose), `docs/FRONTENDS.md`, `docs/INSTALL.md`,
  `docs/PACKAGING.md`, and the two package READMEs; verify every package name in the file exists
  under `packages/`
- [x] 7.5 Regenerate `package-lock.json` and confirm `ls node_modules/@morse/` lists exactly
  `agent host integration-pi protocol server system ui-angular ui-runtime` — no `core`, no `morse`

## Workflow follow-up

- Archive this change after the branch's review requirements are satisfied.
- Note in `docs/ROADMAP.md` that 1.1 (`SessionStore` on disk) now lands in `@morse/system`.
