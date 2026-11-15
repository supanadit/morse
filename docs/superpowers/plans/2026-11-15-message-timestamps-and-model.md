# Message Timestamps and Per-Message Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every message in code mode and bot mode shows a wall-clock time, and every assistant answer in code mode names the model that produced it.

**Architecture:** The host stamps each live assistant transcript row with the session's model, remembered from `agent/state` in `SessionTranscriptStore` and written by `TranscriptProjector`. The frontend renders that identifier with the model catalog's display name (`GLM-5.3-Flash`), falling back to the raw value, beside an `HH:MM` clock.

**Tech Stack:** TypeScript, Angular 22 (zoneless signals), Vitest (system/ui-runtime), Angular `@angular/build:unit-test` (ui-angular).

**Spec:** `docs/superpowers/specs/2026-11-15-message-timestamps-and-model-design.md`

## Global Constraints

- `AssistantTranscriptItem.model` stays a plain string on the wire: the engine's identifier. No new wire shape.
- Timestamps are `HH:MM` via `toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })`; the tooltip is `toLocaleString()`. An `at` of `0` or less renders nothing at all.
- Bot mode gets timestamps only. No model label there.
- Tool steps and thinking notes get no wall-clock time; they keep elapsed durations.
- No new user preference or toggle.
- Conventional-commit messages (`feat:`, `fix:`, `docs:`, `test:`).

## Review Focus

1. **A transcript restored from history** — pi rows carry the bare id (`glm-5.3-flash`), OpenCode rows carry `provider/id`. Both must resolve to the catalog name; an id the catalog no longer has must render raw, never blank or `undefined`.
2. **A model switch mid-conversation** — rows written before the switch must keep the old model, rows after it show the new one.
3. **A session with no reported model** — only the clock renders: no empty separator, no "undefined".
4. **Rows with no timestamp (`at <= 0`)** — no clock, and no dangling `·` when a model is present.
5. **Bot mode lines** — a user line and a bot line each show their own time; the discussion divider keeps its full date.

---

### Task 1: Shared time and model-label helpers

**Files:**
- Create: `packages/ui-runtime/src/transcript/meta.ts`
- Modify: `packages/ui-runtime/src/index.ts` (add `export * from './transcript/meta.js';` after the `./transcript/usage.js` line)
- Test: `packages/ui-runtime/src/transcript/meta.spec.ts`

**Interfaces:**
- Consumes: `ModelOption` from `@morse/protocol`.
- Produces: `clockTime(at: number): string`, `fullTime(at: number): string`,
  `modelMeta(model: string | undefined, catalog: readonly ModelOption[]): ModelMeta | undefined`,
  `interface ModelMeta { label: string; title: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/ui-runtime/src/transcript/meta.spec.ts
import { describe, expect, it } from 'vitest';
import type { ModelOption } from '@morse/protocol';
import { clockTime, fullTime, modelMeta } from './meta.js';

const AT = Date.UTC(2026, 10, 15, 7, 42, 4);
const catalog: ModelOption[] = [
  { provider: 'zai', id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
  { provider: 'anthropic', id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
];

describe('clockTime / fullTime', () => {
  it('renders nothing for a missing timestamp', () => {
    expect(clockTime(0)).toBe('');
    expect(fullTime(-1)).toBe('');
  });

  it('renders the locale clock and the full stamp for a real timestamp', () => {
    expect(clockTime(AT)).toBe(
      new Date(AT).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    );
    expect(fullTime(AT)).toBe(new Date(AT).toLocaleString());
  });
});

describe('modelMeta', () => {
  it('resolves a bare id from pi history to the catalog name', () => {
    expect(modelMeta('glm-5.3-flash', catalog)).toEqual({
      label: 'GLM-5.3-Flash',
      title: 'zai/glm-5.3-flash',
    });
  });

  it('resolves a provider/id stamp from OpenCode history', () => {
    expect(modelMeta('anthropic/claude-sonnet-4', catalog)).toEqual({
      label: 'Claude Sonnet 4',
      title: 'anthropic/claude-sonnet-4',
    });
  });

  it('keeps an unknown id visible instead of blanking it', () => {
    expect(modelMeta('retired-model', catalog)).toEqual({
      label: 'retired-model',
      title: 'retired-model',
    });
  });

  it('reports nothing when the engine named no model', () => {
    expect(modelMeta(undefined, catalog)).toBeUndefined();
    expect(modelMeta('', catalog)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @morse/ui-runtime -- meta.spec`
Expected: FAIL — `Failed to resolve import "./meta.js"`.

- [ ] **Step 3: Implement the helpers**

`packages/ui-runtime/src/transcript/meta.ts`: `clockTime` returns `''` when `at <= 0`, else the locale clock; `fullTime` returns `''` when `at <= 0`, else `new Date(at).toLocaleString()`. `modelMeta` returns `undefined` for an empty/absent string; otherwise it looks for `catalog.find((option) => option.id === model)`, and if that misses and `model` contains a `/`, splits at the **first** `/` into provider and id and looks that up. A hit yields `{ label: option.name, title: `${option.provider}/${option.id}` }`; a miss yields `{ label: model, title: model }`. Export `ModelMeta` as the shared shape, and add the barrel export.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @morse/ui-runtime -- meta.spec`
Expected: PASS (6 tests).

- [ ] **Step 5: Build the runtime so the Angular package sees the new export**

Run: `npm run build -w @morse/ui-runtime`
Expected: exits 0, `packages/ui-runtime/dist/transcript/meta.js` exists.

- [ ] **Step 6: Commit**

```bash
git add packages/ui-runtime/src/transcript/meta.ts packages/ui-runtime/src/transcript/meta.spec.ts packages/ui-runtime/src/index.ts
git commit -m "feat(ui-runtime): add message clock and model-label helpers"
```

---

### Task 2: The projector stamps the model on assistant rows

**Files:**
- Modify: `packages/system/src/host/transcript-projector.ts`
- Test: `packages/system/src/host/transcript-projector.spec.ts`

**Interfaces:**
- Consumes: `ModelRef` from `@morse/agent` (`{ provider, id, name, ... }`).
- Produces: `TranscriptProjector.setModel(model: ModelRef | undefined): void`.

- [ ] **Step 1: Write the failing tests**

Append a `describe('TranscriptProjector message model', ...)` block to the spec. Each test builds the projector with the existing `emit`/`now` pattern.

```ts
it('stamps the model the session was on when the row opened', () => {
  // setModel({ provider: 'zai', id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' })
  // apply({ type: 'agent/delta', channel: 'text', delta: 'hi' })
  // apply({ type: 'agent/message', text: 'hi', thinking: '' })
  // expect(projector.snapshot()).toEqual([expect.objectContaining({ kind: 'assistant', model: 'glm-5.3-flash' })])
});

it('leaves earlier rows on their own model when the session switches', () => {
  // model A -> message 1; model B -> message 2
  // expect(items[0].model).toBe('model-a'); expect(items[1].model).toBe('model-b')
});

it('backfills a streaming row when the model arrives after its first delta', () => {
  // apply delta first, then setModel; expect a transcript/update carrying model
});

it('omits the field entirely when no model was reported', () => {
  // apply message without setModel; expect(item).not.toHaveProperty('model')
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @morse/system -- transcript-projector`
Expected: FAIL — `projector.setModel is not a function`.

- [ ] **Step 3: Implement `setModel` and the stamp**

In `transcript-projector.ts`: add `private model?: ModelRef;` and

```ts
setModel(model: ModelRef | undefined): void {
  this.model = model;
  if (model === undefined || this.assistantIndex < 0) return;
  const item = this.items[this.assistantIndex];
  if (item?.kind === 'assistant' && item.model === undefined) {
    item.model = model.id;
    this.updateItem(item);
  }
}
```

`ensureAssistant()` spreads `...(this.model === undefined ? {} : { model: this.model.id })` into the new item so the identifier is set when the row opens, not when the message ends.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @morse/system -- transcript-projector`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/system/src/host/transcript-projector.ts packages/system/src/host/transcript-projector.spec.ts
git commit -m "feat(system): stamp assistant transcript rows with the session model"
```

---

### Task 3: The store remembers the model per session and the controller feeds it

**Files:**
- Modify: `packages/system/src/host/transcript-store.ts`
- Modify: `packages/system/src/host/session-controller.ts`
- Test: `packages/system/src/host/transcript-store.spec.ts`
- Test: `packages/system/src/host/session-controller.spec.ts`

**Interfaces:**
- Consumes: `TranscriptProjector.setModel` from Task 2; `ModelRef` from `@morse/agent`.
- Produces: `SessionTranscriptStore.setModel(sessionKey: string, model: ModelRef | undefined): void`.

- [ ] **Step 1: Write the failing store tests**

```ts
it('stamps rows created after setModel, per session', () => {
  // store.setModel('s1', { provider: 'zai', id: 'glm-5.3-flash', name: 'GLM' })
  // store.userPrompt('s1', 'hello')
  // store.apply('s1', { type: 'agent/message', at: 2, text: 'hi', thinking: '' })
  // expect(store.items('s1').at(-1)).toMatchObject({ kind: 'assistant', model: 'glm-5.3-flash' })
  // s2's assistant row has no model
});

it('keeps the model for a projector created after setModel', () => {
  // store.setModel('s1', ref) BEFORE any prompt; then prompt + message
  // expect the assistant row to carry 'glm-5.3-flash'
});

it('drops the remembered model with the transcript', () => {
  // setModel, clear('s1'), then prompt + message on 's1'
  // expect the new assistant row not to have a model
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @morse/system -- transcript-store`
Expected: FAIL — `store.setModel is not a function`.

- [ ] **Step 3: Implement the store**

Add `private readonly models = new Map<string, ModelRef>();`. `setModel(sessionKey, model)` deletes the entry when the model is undefined, sets it otherwise, then forwards to `this.projectors.get(sessionKey)?.setModel(model)`. `projectorFor` calls `projector.setModel(this.models.get(sessionKey))` right after creating it. `clear` deletes `models` for the key; `dispose` clears the map; `move` carries the model from `fromKey` to `toKey` (delete after reading, re-set under the new key when it exists).

- [ ] **Step 4: Run the store tests to verify they pass**

Run: `npm run test -w @morse/system -- transcript-store`
Expected: PASS.

- [ ] **Step 5: Write the failing controller test**

In `session-controller.spec.ts`, add one test using a harness in the shape of `scheduledHost()` that keeps the `SessionTranscriptStore` it passes to `connect`:

```ts
it('feeds the session model to the transcript, in front or not', async () => {
  // agentState.model = { provider: 'zai', id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' }
  // emit({ type: 'agent/state', at: ..., state: { ...agentState } })
  // emit a delta + message for 'sess-1'
  // expect(transcripts.items('sess-1').at(-1)).toMatchObject({ kind: 'assistant', model: 'glm-5.3-flash' })
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm run test -w @morse/system -- session-controller`
Expected: FAIL — the assistant row has no `model`.

- [ ] **Step 7: Feed the model from the controller**

In the controller's agent-event handler, before the `if (sessionKey !== this.activeKey)` branch:

```ts
if (event.type === 'agent/state') {
  this.options.transcripts.setModel(sessionKey, event.state.model);
}
```

In `seedHistory` (the resume path around the existing `transcripts.seed(...)` call), also call
`this.options.transcripts.setModel(key, this.options.services.registry.stateOf(key)?.model)` before seeding, so a session whose state event arrived before this controller attached still stamps correctly.

- [ ] **Step 8: Run the controller and store tests to verify they pass**

Run: `npm run test -w @morse/system`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/system/src/host/transcript-store.ts packages/system/src/host/transcript-store.spec.ts packages/system/src/host/session-controller.ts packages/system/src/host/session-controller.spec.ts
git commit -m "feat(system): feed the session model into each transcript"
```

---

### Task 4: Code mode renders the clock and the model

**Files:**
- Modify: `packages/ui-angular/src/app/features/transcript/transcript.ts`
- Modify: `packages/ui-angular/src/app/features/transcript/transcript.html`
- Modify: `packages/ui-angular/src/app/features/transcript/transcript.css`
- Test: `packages/ui-angular/src/app/features/transcript/transcript.spec.ts`

**Interfaces:**
- Consumes: `clockTime`, `fullTime`, `modelMeta` from `@morse/ui-runtime` (Task 1); `AssistantTranscriptItem.model` (Task 2/3).
- Produces: nothing other tasks import.

- [ ] **Step 1: Write the failing tests**

Extend the spec's `viewState(streaming = false)` to `viewState(streaming = false, models: ModelOption[] = [])` so the harness can pass a catalog (`availableModels: models`). Add `describe('ChatTranscript message meta')` with these assertions:

```ts
it('shows the catalog name and clock under an assistant answer', () => {
  // items: [{ kind: 'assistant', id: 'a1', at: AT, text: 'an answer', thinking: '', streaming: false, model: 'glm-5.3-flash' }]
  // models: [{ provider: 'zai', id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' }]
  // expect(text).toContain(`GLM-5.3-Flash · ${clockTime(AT)}`)
});

it('shows an unknown model id raw instead of hiding it', () => {
  // model: 'retired-model' -> text contains `retired-model · ${clockTime(AT)}`
});

it('shows only the clock when the engine reported no model', () => {
  // no model -> the assistant row's `.stamp` textContent equals clockTime(AT) exactly
});

it('drops a missing timestamp without leaving a dangling separator', () => {
  // at: 0, model: 'glm-5.3-flash' -> `.stamp` textContent is 'GLM-5.3-Flash',
  // and does not contain '·'
});

it('stamps notice and compaction rows', () => {
  // notice + compaction items with at: AT -> each row's `.stamp`/`.sep-stamp`
  // textContent equals clockTime(AT)
});
```

Import `clockTime` from `@morse/ui-runtime` in the spec.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @morse/ui-angular -- --watch=false`
Expected: FAIL — no `.stamp` in assistant/notice rows.

- [ ] **Step 3: Implement the component helpers**

In `transcript.ts`, import the three helpers. Replace `stamp`'s body with `clockTime(at)` and add:

```ts
protected stampTitle(at: number): string { return fullTime(at); }

protected meta(item: AssistantTranscriptItem): { label: string; title: string } | undefined {
  const clock = clockTime(item.at);
  const model = modelMeta(item.model, this.morse.state().availableModels);
  if (clock.length === 0 && model === undefined) return undefined;
  const label = model === undefined ? clock : clock.length === 0 ? model.label : `${model.label} · ${clock}`;
  const title = [model?.title, fullTime(item.at)].filter((part) => part !== undefined && part.length > 0).join(' · ');
  return { label, title };
}
```

- [ ] **Step 4: Render it**

In `transcript.html`:
- Assistant actions row: after the copy button, `@if (meta(row.item); as m) { <span class="stamp" [title]="m.title">{{ m.label }}</span> }`.
- Notice row: after the `<pre>`, `<span class="stamp" [title]="stampTitle(row.item.at)">{{ stamp(row.item.at) }}</span>` (rendered only when `stamp(...)` is non-empty via the same `@if` pattern).
- Compaction divider: inside the button, after the last `sep-line`, `<span class="sep-stamp" [title]="stampTitle(row.item.at)">{{ stamp(row.item.at) }}</span>`.
- User bubble stamp gains `[title]="stampTitle(row.item.at)"`.

In `transcript.css`: `.assistant-actions { justify-content: flex-end; gap: 8px; }`, and one `.stamp` rule (11px, `--morse-fg-muted`, `white-space: nowrap`) reused by all three surfaces; the notice stamp sits on its own right-aligned line.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -w @morse/ui-angular -- --watch=false`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ui-angular/src/app/features/transcript/
git commit -m "feat(ui): show the clock and the answering model under each message"
```

---

### Task 5: Bot mode renders the clock on every line

**Files:**
- Modify: `packages/ui-angular/src/app/features/bot-chat/bot-chat.ts`
- Modify: `packages/ui-angular/src/app/features/bot-chat/bot-chat.html`
- Modify: `packages/ui-angular/src/app/features/bot-chat/bot-chat.css`
- Test: `packages/ui-angular/src/app/features/bot-chat/bot-chat.spec.ts`

**Interfaces:**
- Consumes: `clockTime`, `fullTime` from `@morse/ui-runtime` (Task 1).
- Produces: nothing other tasks import.

- [ ] **Step 1: Write the failing test**

```ts
it('stamps every line, reader and bot alike', async () => {
  // open the DM with entries: user 'hello' at AT, bot 'hi' at AT + 60_000
  // expect host.querySelectorAll('time.when').length to be 2
  // expect the first textContent to be clockTime(AT) and its title fullTime(AT)
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w @morse/ui-angular -- --watch=false`
Expected: FAIL — zero `time.when`.

- [ ] **Step 3: Implement the stamps**

In `bot-chat.ts`, add `protected clock(at: number): string { return clockTime(at); }` and `protected fullStamp(at: number): string { return fullTime(at); }`, keeping `stamp`/`when` for the divider. In `bot-chat.html`, after the user bubble's `<morse-markdown>` add
`<time class="when" [attr.datetime]="stamp(entry.at)" [title]="fullStamp(entry.at)">{{ clock(entry.at) }}</time>`,
and the same element after the bot's `<div class="text">` inside `.body`. In `bot-chat.css`, add `.when { font-size: 11px; color: var(--morse-fg-muted); }`, right-aligned inside the user bubble and left-aligned under a bot's text.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @morse/ui-angular -- --watch=false`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui-angular/src/app/features/bot-chat/
git commit -m "feat(ui): stamp bot-mode lines with their time"
```

---

### Task 6: Document it and verify the workspace

**Files:**
- Modify: `docs/STATUS.md` (the `### The conversation` bullets)
- Modify: `docs/superpowers/specs/2026-11-15-message-timestamps-and-model-design.md` (status line)

- [ ] **Step 1: Add the STATUS bullets**

Under `### The conversation`, add one bullet for the clock (both modes) and one for the per-answer model label, naming the fallback: the engine's id when the catalog does not know it.

- [ ] **Step 2: Mark the spec implemented**

Change `Status: proposed` to `Status: implemented` in the design doc.

- [ ] **Step 3: Run the full suite**

Run: `npm run test:fast`
Expected: every workspace green, including `@morse/ui-angular`.

- [ ] **Step 4: Type-check and lint**

Run: `npm run check-types && npm run lint`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add docs/STATUS.md docs/superpowers/specs/2026-11-15-message-timestamps-and-model-design.md
git commit -m "docs: record message timestamps and per-answer model labels"
```
