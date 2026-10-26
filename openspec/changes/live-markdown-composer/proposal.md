# Proposal

## Why

The composer is a plain textarea: a draft that is mostly markdown — code blocks especially —
reads as a wall of raw text while typing, so the user cannot see what they are about to send.
The bundle already ships a markdown stack (`marked`, `highlight.js`) because the transcript
renders answers with it; the composer can show the same formatting live at zero new cost.

## What Changes

- The composer's editing surface becomes a live markdown view: while the user types, markdown is
  formatted in place — a ` ``` ` fence opens a tinted, syntax-highlighted code panel as they type,
  and inline code, emphasis, links, headings and lists are visibly distinct.
- The buffer stays exact markdown source. Fence characters are dimmed, never removed or rewritten:
  what the user sees styled is byte-for-byte what is sent and what drafts persist.
- The textarea remains the input surface. Everything the composer does today — Enter/Shift+Enter,
  `@` mentions, `/` commands, Esc restore, maximize, draft persistence, queueing — is untouched.
- **No new dependencies.** The paint layer reuses the markdown stack already in the bundle.

Out of scope: true WYSIWYG document editing (caret walking through rendered widgets, folding
fences away, reflowing blocks) — that needs an editor engine and is a different change. The
transcript's rendering is also untouched.

## Capabilities

### New Capabilities

- `ui/markdown-composer`: composing a prompt as markdown with live formatting in the composer —
  what gets formatted as it is typed, that the editing buffer always remains the exact source
  text, and that editing behavior (caret, IME, shortcuts, send) is unaffected by the formatting.

### Modified Capabilities

None — the composer input surface is not covered by any existing spec.

## Impact

- `packages/ui-angular/src/app/features/composer` — the textarea gains a formatting paint layer;
  input handling, drafts and shortcuts are unchanged.
- `packages/ui-angular/src/app/ui` — the mirror/highlight directive lives beside `markdown/`
  (the transcript renderer) and the other shared UI primitives.
- `packages/ui-runtime/src/render/markdown.ts` — may expose the token boundaries the paint layer
  needs (`marked` is already its dependency); no behavior change for the transcript.
- No protocol, agent, or system changes. No dependency or bundle-composition changes.
