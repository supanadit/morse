import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, HostListener, inject, signal, viewChild } from '@angular/core';
import type { AssistantTranscriptItem, PromptImage, UserTranscriptItem } from '@morse/protocol';
import {
  activeProcessKey,
  groupTranscriptItems,
  userMessageMarkdown,
  type TranscriptRow,
} from '../transcript-rows';
import { AnimationService } from '../../core/animation.service';
import { BootHandoff } from '../../core/boot-handoff';
import { Markdown } from '../../shared/markdown/markdown';
import { EnterDirective } from '../../shared/enter.directive';
import { ToolGroup } from '../tool-group/tool-group';
import { PromptRail, type RailPrompt } from '../prompt-rail/prompt-rail';
import { MorseService } from '../../core/morse.service';

/** Mime subtype -> file extension, for the chip label of a persisted image. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  png: 'png',
  jpeg: 'jpg',
  jpg: 'jpg',
  webp: 'webp',
  gif: 'gif',
  'svg+xml': 'svg',
  bmp: 'bmp',
  avif: 'avif',
};

/** One-line prompt preview for the navigator rail. */
const PREVIEW_MAX_CHARS = 160;
function previewPrompt(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > PREVIEW_MAX_CHARS ? `${single.slice(0, PREVIEW_MAX_CHARS)}…` : single;
}

@Component({
  selector: 'morse-chat-transcript',
  imports: [Markdown, ToolGroup, EnterDirective, PromptRail],
  templateUrl: './chat-transcript.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        position: relative;
      }
      /*
       * Flex, not a percentage height: a percentage does not resolve inside a
       * flex item, so the transcript would grow with its content and never
       * scroll — which also made "follow the output" impossible.
       */
      .transcript {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 18px 16px 6px;
        scrollbar-gutter: stable;
      }
      /* Sits outside the scroll container so it stays put while reading. */
      .latest {
        position: absolute;
        right: 18px;
        bottom: 10px;
        padding: 3px 12px;
        border: 1px solid var(--morse-border);
        border-radius: 999px;
        background: var(--morse-badge-bg, var(--morse-hover));
        color: var(--morse-badge-fg, var(--morse-fg));
        font-size: 11.5px;
        box-shadow: 0 4px 12px rgb(0 0 0 / 25%);
        cursor: pointer;
      }
      .latest:hover {
        background: var(--morse-active);
      }
      .inner {
        width: 100%;
        max-width: 780px;
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      /* An empty session centres its hero in the reading area. */
      .inner.blank {
        min-height: 100%;
        justify-content: center;
      }
      .user {
        align-self: flex-end;
        max-width: 88%;
        padding: 8px 12px;
        border-radius: var(--morse-radius-lg);
        border-bottom-right-radius: 4px;
        background: var(--morse-bubble);
        border: 1px solid var(--morse-border);
      }
      /*
       * Meta row under the message, mirroring the assistant's actions row.
       * No gap: the actions collapse to zero width while idle, so the
       * timestamp sits flush right on its own instead of leaving an empty hole
       * where the buttons would be. They expand on hover or keyboard focus
       * (still rendered, so they stay reachable).
       */
      .user-head {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0;
        min-height: 14px;
        margin-top: 4px;
      }
      .user .user-head .copy-msg {
        width: 0;
        margin: 0;
        padding: 0;
        overflow: hidden;
        opacity: 0;
      }
      .user:hover .user-head .copy-msg,
      .user .user-head .copy-msg:focus-visible {
        width: auto;
        padding: 0 4px;
        margin-left: 6px;
        overflow: visible;
        opacity: 1;
      }
      .user .stamp {
        font-size: 11px;
        color: var(--morse-fg-muted);
      }
      .assistant-actions {
        display: flex;
        justify-content: flex-start;
        min-height: 16px;
        margin-top: -2px;
      }
      /* The answer's copy button mirrors the user bubble: revealed on hover. */
      .assistant .copy-msg {
        padding: 1px 7px;
        border: 1px solid transparent;
      }
      .assistant:hover .copy-msg,
      .assistant .copy-msg:focus-visible,
      .assistant .copy-msg.revealed {
        opacity: 1;
      }
      .copy-msg {
        padding: 0 4px;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg-muted);
        font-size: 11px;
        line-height: 1.2;
        cursor: pointer;
        opacity: 0;
        transition: opacity 140ms ease;
      }
      .user:hover .copy-msg,
      .copy-msg:focus-visible {
        opacity: 1;
      }
      .copy-msg:hover {
        color: var(--morse-fg);
        background: var(--morse-hover);
      }
      /* The fork glyph is an inline SVG; keep it on the same baseline as ✎/⧉. */
      .copy-msg svg {
        display: block;
      }
      .older {
        display: flex;
        justify-content: center;
        padding: 2px 0 8px;
      }
      .older-label {
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .older-button {
        padding: 3px 12px;
        border: 1px solid var(--morse-border);
        border-radius: 999px;
        background: var(--morse-panel, var(--morse-bg));
        color: var(--morse-fg);
        font-size: 11px;
        cursor: pointer;
      }
      .older-button:hover {
        background: var(--morse-hover);
      }
      .start {
        display: flex;
        align-items: center;
        gap: 10px;
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .start::before,
      .start::after {
        content: '';
        flex: 1;
        height: 1px;
        background: var(--morse-border);
      }
      .start span {
        white-space: nowrap;
      }
      /* The compaction boundary: same hairline as the start marker, with a
         badge that opens the summary the agent actually carries. */
      .compaction {
        margin: 10px 0 14px;
      }
      .compaction-sep {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 3px 0;
        border: none;
        background: none;
        color: var(--morse-fg-muted);
        font-size: 11px;
        cursor: pointer;
      }
      .compaction-sep .sep-line {
        flex: 1;
        height: 1px;
        background: var(--morse-border);
      }
      .compaction-sep .sep-label {
        white-space: nowrap;
        padding: 1px 10px;
        border: 1px solid var(--morse-border);
        border-radius: 999px;
        background: var(--morse-hover);
        font-family: var(--morse-font-mono, monospace);
        font-size: 10.5px;
      }
      .compaction-sep .sep-tokens {
        white-space: nowrap;
        font-size: 10.5px;
        color: var(--morse-fg-dim, var(--morse-fg-muted));
      }
      .compaction-sep:hover .sep-label {
        color: var(--morse-fg);
        background: var(--morse-active);
      }
      .compaction-summary {
        margin-top: 8px;
        padding: 10px 12px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-panel, var(--morse-bg));
        font-size: 13px;
      }
      .user .user-text {
        margin: 0;
        word-break: break-word;
        font-family: var(--morse-font);
        line-height: 1.55;
      }
      /*
       * A prompt runs through the same markdown pipeline as the answer, so a
       * fenced code block in it reads like code. Only the margins are tightened:
       * a bubble is not a document.
       */
      .user .user-text .md p {
        margin: 0 0 0.5em;
      }
      /* Inline editor: the bubble keeps its shape, only the text swaps out. */
      .user-edit {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: min(420px, 60vw);
      }
      .user .edit-input {
        width: 100%;
        box-sizing: border-box;
        resize: vertical;
        min-height: 60px;
        padding: 7px 9px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-panel, var(--morse-bg));
        color: var(--morse-fg);
        font-family: var(--morse-font);
        font-size: inherit;
        line-height: 1.55;
      }
      .user .edit-input:focus {
        outline: none;
        border-color: var(--morse-accent);
      }
      .user-edit .edit-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 6px;
      }
      .user-edit .edit-hint {
        margin-right: auto;
        font-size: 10.5px;
        color: var(--morse-fg-muted);
      }
      .user-edit .edit-cancel,
      .user-edit .edit-send {
        padding: 3px 10px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg);
        font-size: 11.5px;
        cursor: pointer;
      }
      .user-edit .edit-send {
        border-color: var(--morse-accent);
        background: var(--morse-accent);
        color: #fff;
      }
      .user-edit .edit-send:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .user-edit .edit-cancel:hover {
        background: var(--morse-hover);
      }
      /*
       * Attachment chips pinned to the message. Every chip is the same fixed
       * width, so a wrapped row reads as neatly stacked cards instead of an
       * uneven jumble, and a long name just ellipsises inside its chip.
       */
      .user-attachments {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        margin: 2px 0 6px;
        padding: 0;
        list-style: none;
      }
      .user-attachments .mention-pin {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 2px 7px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-hover);
        font-size: 11.5px;
        width: 220px;
        max-width: 100%;
      }
      .user-attachments .mention-pin .name {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .user-attachments .mention-pin .lines {
        flex: none;
        padding: 0 5px;
        border-radius: 999px;
        background: var(--morse-active);
        color: var(--morse-fg-muted);
        font-size: 10.5px;
        font-family: var(--morse-font-mono);
        /* One chip, one line: "41-58" must never break across two rows. */
        white-space: nowrap;
      }
      .user-attachments .mention-pin .pin-icon {
        flex: none;
        font-size: 11px;
        color: var(--morse-accent);
      }
      /*
       * Image attachments read as thumbnails, not labeled chips: a compact
       * square that shows the picture itself (the name lives in the tooltip
       * and stays reachable through the full-size view on click). This keeps
       * a stack of screenshots as small as an emoji row in the message.
       */
      .user-attachments .image-chip {
        display: inline-flex;
        min-width: 0;
      }
      .user-attachments .image-chip-button {
        display: inline-flex;
        width: 30px;
        height: 30px;
        padding: 0;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-hover);
        overflow: hidden;
        cursor: pointer;
      }
      .user-attachments .image-chip-button:hover {
        border-color: color-mix(in srgb, var(--morse-accent) 45%, var(--morse-border));
        background: var(--morse-active);
      }
      .user-attachments .image-chip-button img {
        width: 100%;
        height: 100%;
        display: block;
        object-fit: cover;
        border-radius: calc(var(--morse-radius-sm) - 1px);
      }
      /* Full-size view when a chip is clicked; the thumbnail alone is too small. */
      .image-overlay {
        position: fixed;
        inset: 0;
        z-index: 60;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 32px;
        background: rgb(0 0 0 / 62%);
      }
      .image-frame {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin: 0;
        max-width: min(880px, 92vw);
        max-height: 92vh;
      }
      .image-frame img {
        max-width: 100%;
        max-height: calc(92vh - 40px);
        object-fit: contain;
        border-radius: var(--morse-radius-md);
        background: var(--morse-panel);
      }
      .image-frame figcaption {
        color: var(--morse-badge-fg, #fff);
        font-size: 11.5px;
        text-align: center;
      }
      .image-close {
        position: absolute;
        top: 14px;
        right: 18px;
        width: 28px;
        height: 28px;
        border: 0;
        border-radius: 50%;
        background: rgb(0 0 0 / 45%);
        color: #fff;
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
      }
      .image-close:hover {
        background: rgb(0 0 0 / 70%);
      }
      /*
       * Mention tokens typed into the message render as inline file chips,
       * matching the attachment chips above the message. They are atomic:
       * long paths never break mid-token to the next line (that is what left
       * "erp-inventory-worker-" orphaned pills across a row) — a chip that
       * does not fit ellipsises instead. The label carries the file name plus
       * the typed line range; the tooltip keeps the full path.
       *
       * The chip is deliberately a two-layer box, and the outer one is an
       * inline-FLEX container on purpose: Chromium gives an inline-block whose
       * content is a block (or clipped) level the bottom-edge baseline, which
       * is what floated the pill above the text line. A flex container takes
       * its baseline from the first flex item instead — the label's own text
       * baseline — so the chip sits on the same line as the words around it.
       * Clipping (ellipsis for an overlong name) stays on the inner label.
       */
      .user .user-text .mention {
        display: inline-flex;
        align-items: baseline;
        max-width: 100%;
        vertical-align: baseline;
        padding: 0;
        border: 1px solid color-mix(in srgb, var(--morse-accent) 30%, transparent);
        border-radius: var(--morse-radius-sm);
        background: color-mix(in srgb, var(--morse-accent) 12%, transparent);
        color: color-mix(in srgb, var(--morse-accent) 75%, var(--morse-fg));
        cursor: pointer;
      }
      .user .user-text .mention .mention-label {
        display: block;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: 0 6px 1px;
        font-family: var(--morse-font-mono);
        font-size: 11px;
      }
      .user .user-text .mention:hover {
        border-color: color-mix(in srgb, var(--morse-accent) 60%, transparent);
        background: color-mix(in srgb, var(--morse-accent) 20%, transparent);
      }
      .assistant {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .assistant .who {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.02em;
        color: var(--morse-fg-muted);
      }
      .assistant morse-markdown ::ng-deep .md {
        line-height: 1.6;
      }
      .notice {
        padding: 8px 10px;
        border-left: 2px solid var(--morse-info);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-hover);
        font-size: 12px;
        color: var(--morse-fg-muted);
      }
      .notice.warn {
        border-color: var(--morse-warn);
      }
      .notice pre {
        margin: 0;
        font-family: inherit;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .notice.error {
        border-color: var(--morse-error);
        color: var(--morse-fg);
      }
      .notice.success {
        border-color: var(--morse-success);
      }
      /*
       * Empty-state hero: the same Morse mark the cold-start splash flies in,
       * so the logo arrives instead of being replaced by a paragraph.
       */
      .hero {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        max-width: 460px;
        margin: 0 auto;
        padding: 28px 14px;
        text-align: center;
      }
      .hero-stage {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 104px;
        height: 104px;
        margin-bottom: 2px;
      }
      .hero-glow {
        position: absolute;
        width: 104px;
        height: 104px;
        border-radius: 50%;
        background: radial-gradient(
          circle,
          color-mix(in srgb, var(--morse-accent) 38%, transparent) 0%,
          transparent 66%
        );
        filter: blur(3px);
        animation: hero-breathe 3.6s ease-in-out infinite;
      }
      .hero-mark {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      .hero-dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: var(--morse-fg);
        box-shadow: 0 0 13px color-mix(in srgb, var(--morse-fg) 45%, transparent);
        animation: hero-hop 3.6s ease-in-out infinite;
      }
      .hero-dot:nth-child(2) {
        animation-delay: 0.14s;
      }
      .hero-dash {
        width: 34px;
        height: 12px;
        border-radius: 999px;
        background: var(--morse-fg);
        box-shadow: 0 0 13px color-mix(in srgb, var(--morse-fg) 45%, transparent);
        animation: hero-hop-dash 3.6s ease-in-out infinite;
        animation-delay: 0.3s;
      }
      .hero-wordmark {
        display: flex;
        font-size: 26px;
        font-weight: 650;
        line-height: 1;
        /*
         * Painted from a gradient (not a flat colour) so a sheen can sweep the
         * glyphs: the top layer is the highlight, the bottom the real text.
         */
        background-image:
          linear-gradient(
            100deg,
            transparent 38%,
            color-mix(in srgb, var(--morse-fg) 45%, #fff) 50%,
            transparent 62%
          ),
          linear-gradient(var(--morse-fg), var(--morse-fg));
        background-size: 260% 100%, 100% 100%;
        background-repeat: no-repeat;
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
        animation: hero-shimmer 3.6s ease-in-out infinite;
      }
      .hero-letter {
        display: inline-block;
      }
      .hero-tagline {
        font-size: 10px;
        letter-spacing: 0.34em;
        text-transform: uppercase;
        color: var(--morse-fg-muted);
      }
      .hero-hint,
      .hero-tips {
        margin: 0;
        color: var(--morse-fg-muted);
        line-height: 1.65;
      }
      .hero-hint {
        margin-top: 12px;
      }
      .hero-tips em {
        font-style: normal;
        color: var(--morse-fg);
        background: var(--morse-hover);
        border: 1px solid var(--morse-border);
        border-radius: 999px;
        padding: 1px 8px;
        white-space: nowrap;
      }
      .hero-key {
        font-family: var(--morse-font-mono);
        color: var(--morse-fg);
      }
      @keyframes hero-breathe {
        0%,
        100% {
          opacity: 0.75;
          transform: scale(0.96);
        }
        50% {
          opacity: 1;
          transform: scale(1.04);
        }
      }
      /* A Morse tap — dot dot dash — once per cycle, then rest. */
      @keyframes hero-hop {
        0%,
        14%,
        100% {
          transform: translateY(0);
        }
        7% {
          transform: translateY(-8px);
        }
      }
      @keyframes hero-hop-dash {
        0%,
        16%,
        100% {
          transform: translateY(0) scale(1, 1);
        }
        8% {
          transform: translateY(-6px) scale(1.08, 0.88);
        }
      }
      @keyframes hero-shimmer {
        0%,
        38% {
          background-position: 140% 0, 0 0;
        }
        62%,
        100% {
          background-position: -45% 0, 0 0;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .hero-glow,
        .hero-dot,
        .hero-dash,
        .hero-wordmark {
          animation: none;
        }
        .hero-wordmark {
          background-image: none;
          color: var(--morse-fg);
        }
      }
      .cursor {
        display: inline-block;
        width: 7px;
        height: 14px;
        vertical-align: text-bottom;
        background: var(--morse-accent);
        animation: blink 1s step-start infinite;
      }
      @keyframes blink {
        50% {
          opacity: 0;
        }
      }
    `,
  ],
})
export class ChatTranscript {
  private readonly morse = inject(MorseService);
  private readonly animation = inject(AnimationService);
  private readonly handoff = inject(BootHandoff);
  private readonly scrollHost = viewChild.required<ElementRef<HTMLElement>>('scroll');
  private readonly inner = viewChild<ElementRef<HTMLElement>>('inner');
  private readonly heroMark = viewChild<ElementRef<HTMLElement>>('heroMark');

  /** The empty-state wordmark, split so the reveal can stagger if we want it to. */
  protected readonly heroLetters = ['M', 'o', 'r', 's', 'e'];

  protected readonly copiedId = signal<string | null>(null);
  /** The image opened full-size from its chip, if any. */
  protected readonly preview = signal<{ src: string; label: string } | null>(null);
  /** The user message being edited in place, if any. */
  protected readonly editingId = signal<string | null>(null);
  /** Draft of the inline editor for the message being edited. */
  protected readonly editingText = signal('');
  /** True while the reader is at the bottom, so new output auto-follows. */
  protected readonly pinned = signal(true);
  /**
   * True while a run is in progress, so the timeline opens once and closes once.
   * `busy` is excluded: that flag covers session switches, which must not expand
   * old timelines.
   */
  protected readonly working = computed(() => this.morse.state().streaming);
  protected readonly rows = computed<TranscriptRow[]>(() =>
    groupTranscriptItems(this.morse.items()),
  );
  /**
   * Key of the newest process row. While a run is going, only that timeline
   * stays open: every earlier section collapses as soon as a new one starts, so
   * a long turn shows one open timeline instead of a wall of them.
   */
  protected readonly activeProcess = computed(() => activeProcessKey(this.rows()));
  /** One tick per user message, for the prompt navigator rail. */
  protected readonly railPrompts = computed<RailPrompt[]>(() =>
    this.rows()
      .filter((row): row is Extract<TranscriptRow, { kind: 'user' }> => row.kind === 'user')
      .map((row) => ({ id: row.item.id, preview: previewPrompt(row.item.text) })),
  );
  /** The user prompt currently under the reading line, for the rail. */
  protected readonly activePromptId = signal<string | null>(null);
  /** Row key of the expanded "Compacted" summary, one at a time. */
  protected readonly expandedCompaction = signal<string | null>(null);

  protected toggleCompaction(key: string): void {
    this.expandedCompaction.update((open) => (open === key ? null : key));
  }

  protected formatTokens(tokens: number): string {
    return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
      tokens,
    );
  }
  /** True when older transcript entries can still be loaded. */
  protected readonly hasOlderHistory = computed(() => this.morse.hasOlderHistory());
  /** True while the host is fetching the previous history page. */
  protected readonly loadingOlderHistory = computed(() => this.morse.loadingOlderHistory());
  /** Guards against recomputing the scroll spy on every scroll event. */
  private activePending = false;  /** Distance from the bottom, kept so a history prepend does not move the view. */
  private bottomDistance = 0;
  /** False when the transcript had no scrollbar, so there is nothing to anchor. */
  private anchorScroll = false;
  /** First item id / length, to tell a prepend apart from a session switch. */
  private previousFirstId: string | undefined;
  private previousSessionId: string | undefined;
  private previousLength = 0;

  constructor() {
    // Content grows after animations settle (markdown, code, tool rows), so the
    // bottom is tracked with an observer instead of a single post-render jump.
    effect((onCleanup) => {
      const target = this.inner()?.nativeElement;
      if (!target || typeof ResizeObserver === 'undefined') {
        return;
      }
      const observer = new ResizeObserver(() => {
        if (this.pinned()) {
          this.afterRender(() => this.scrollToBottom());
        }
      });
      observer.observe(target);
      onCleanup(() => observer.disconnect());
    });

    effect(() => {
      this.rows();
      if (this.pinned()) {
        this.afterRender(() => this.scrollToBottom());
      }
    });

    // A gentle cue when a run starts, instead of an empty pause.
    effect(() => {
      const rows = this.rows();
      if (rows.at(-1)?.kind === 'user') {
        this.animation.pulse(this.inner()?.nativeElement ?? null);
      }
    });

    // Tell the cold-start splash where the empty-state logo lives, so it can
    // land there instead of fading out somewhere else. Cleared as soon as the
    // transcript has content and the hero is gone.
    effect(() => {
      const empty = this.rows().length === 0;
      this.afterRender(() => {
        const mark = this.heroMark()?.nativeElement;
        if (!empty || !mark) {
          this.handoff.aim(null);
          return;
        }
        const rect = mark.getBoundingClientRect();
        this.handoff.aim({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          width: rect.width,
          height: rect.height,
        });
      });
    });

    // The rail's active tick follows the transcript: recompute it whenever the
    // rows grow or collapse, not only on a scroll event (short conversations
    // never scroll, and their last prompt must still read as active).
    effect(() => {
      this.railPrompts();
      this.afterRender(() => this.updateActivePrompt());
    });

    // A history page is inserted in front. Anchor the reader to the content they
    // were looking at by restoring the distance from the bottom after the render.
    effect(() => {
      const sessionId = this.morse.state().sessionId;
      const items = this.morse.items();
      const first = items[0]?.id;
      const prepended =
        sessionId === this.previousSessionId &&
        this.previousFirstId !== undefined &&
        first !== this.previousFirstId &&
        items.length > this.previousLength;
      this.previousSessionId = sessionId;
      this.previousFirstId = first;
      this.previousLength = items.length;
      if (prepended) {
        this.afterRender(() => this.restoreBottomDistance());
      }
    });
  }

  /**
   * Runs after the DOM has been updated by this change.
   *
   * Deliberately not `requestAnimationFrame`: frames are paused in a hidden
   * document — a background VS Code webview, a headless screenshot — so the
   * transcript would never follow new output there.
   */
  private afterRender(action: () => void): void {
    setTimeout(action, 0);
  }

  protected onScroll(event: Event): void {
    const target = event.target as HTMLElement;
    const distance = target.scrollHeight - target.scrollTop - target.clientHeight;
    this.pinned.set(distance < 48);
    this.bottomDistance = distance;
    this.anchorScroll = distance > 0;
    // Reading line: reaching the top is the cue for the previous history page.
    if (target.scrollTop < 80 && this.hasOlderHistory() && !this.loadingOlderHistory()) {
      this.morse.loadOlderHistory();
    }
    this.updateActivePrompt();
  }

  /** Manual "load older" (the top button), same as the scroll trigger. */
  protected loadOlder(): void {
    const target = this.scrollHost().nativeElement;
    this.bottomDistance = target.scrollHeight - target.scrollTop - target.clientHeight;
    this.anchorScroll = this.bottomDistance > 0;
    this.morse.loadOlderHistory();
  }

  /** Puts the viewport back where it was before a history page was prepended. */
  private restoreBottomDistance(): void {
    if (!this.anchorScroll) {
      return;
    }
    const target = this.scrollHost().nativeElement;
    const max = Math.max(0, target.scrollHeight - target.clientHeight);
    const top = target.scrollHeight - target.clientHeight - this.bottomDistance;
    target.scrollTop = Math.max(0, Math.min(max, top));
  }

  /**
   * Recomputes the active prompt, coalescing rapid scroll events: reading every
   * prompt's rect on each event would force a layout per wheel tick.
   */
  private updateActivePrompt(): void {
    if (this.activePending) {
      return;
    }
    this.activePending = true;
    this.afterRender(() => {
      this.activePending = false;
      this.computeActivePrompt();
    });
  }

  /**
   * The active prompt is the last one whose top edge has passed a reading line
   * below the container top — a monotonic rule that stays stable while reading
   * inside a long turn.
   */
  private computeActivePrompt(): void {
    const container = this.scrollHost().nativeElement;
    const nodes = container.querySelectorAll<HTMLElement>('[data-prompt-id]');
    if (nodes.length === 0) {
      this.activePromptId.set(null);
      return;
    }
    const readLine = container.getBoundingClientRect().top + 100;
    let active = nodes[0]?.dataset['promptId'] ?? null;
    for (const node of Array.from(nodes)) {
      if (node.getBoundingClientRect().top <= readLine) {
        active = node.dataset['promptId'] ?? active;
      } else {
        break;
      }
    }
    // At the very bottom the last prompt is active even if its top never
    // crossed the reading line (the bottom spacer is part of the pinned zone).
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distance <= Math.max(48, container.clientHeight * 0.1)) {
      active = nodes[nodes.length - 1]?.dataset['promptId'] ?? active;
    }
    this.activePromptId.set(active);
  }

  /** Jumps to a prompt the rail picked, leaving it just below the top edge. */
  protected scrollToPrompt(id: string): void {
    const container = this.scrollHost().nativeElement;
    const node = container.querySelector<HTMLElement>(`[data-prompt-id="${id}"]`);
    if (!node) {
      return;
    }
    const top =
      node.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop -
      12;
    // Jumping to an earlier prompt is not following the live output.
    this.pinned.set(false);
    if (this.animation.isEnabled && typeof container.scrollTo === 'function') {
      container.scrollTo({ top, behavior: 'smooth' });
    } else {
      container.scrollTop = top;
    }
    this.activePromptId.set(id);
  }

  protected jumpToLatest(): void {
    this.pinned.set(true);
    this.scrollToBottom(true);
  }

  private scrollToBottom(smooth = false): void {
    const target = this.scrollHost().nativeElement;
    const canAnimate =
      smooth &&
      this.animation.isEnabled &&
      typeof target.scrollTo === 'function' &&
      (typeof document === 'undefined' || document.visibilityState === 'visible');
    if (canAnimate) {
      target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' });
    } else {
      // Assigning scrollTop keeps this working in jsdom during unit tests too.
      target.scrollTop = target.scrollHeight;
    }
  }

  protected stamp(at: number): string {
    if (at <= 0) {
      return '';
    }
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /** The prompt as markdown, with its `@mentions` turned into chips. */
  protected userMarkdown(item: UserTranscriptItem): string {
    return userMessageMarkdown(item.text);
  }

  /** The pin chips attached to a message (`@path[:start-end]` references). */
  protected pinsOf(item: UserTranscriptItem): UserTranscriptItem['pins'] {
    return item.pins;
  }

  /**
   * A chip label carries the file name only — in a transcript, a directory chain
   * pushes out what actually identifies the file. The hover tooltip keeps the
   * full workspace-relative path. (Mention chips are built in
   * `userMessageMarkdown`, which uses the same rule.)
   */
  protected basename(path: string): string {
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return cut === -1 ? path : path.slice(cut + 1);
  }

  protected thumb(image: PromptImage): string {
    return `data:${image.mimeType};base64,${image.data}`;
  }

  /**
   * A chip label for a persisted image. The wire only carries the base64 data
   * and mime type (pi's own format), so the name is derived from the type.
   */
  protected imageName(image: PromptImage, index: number): string {
    const subtype = image.mimeType.split('/')[1]?.toLowerCase() ?? '';
    const ext = IMAGE_EXTENSIONS[subtype] ?? (subtype.replace(/[^a-z0-9]/g, '') || 'png');
    return index === 0 ? `image.${ext}` : `image-${index + 1}.${ext}`;
  }

  protected openImage(image: PromptImage, index: number): void {
    this.preview.set({ src: this.thumb(image), label: this.imageName(image, index) });
  }

  protected closeImage(): void {
    this.preview.set(null);
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.preview() !== null) {
      this.closeImage();
      return;
    }
    if (this.editingId() !== null) {
      this.cancelEdit();
    }
  }

  /**
   * Editing a past prompt is offered only when the host can fork the
   * conversation, and never while the agent is mid-run (the fork would race it).
   */
  protected canEdit(): boolean {
    return this.morse.capabilities()?.editMessage === true && this.morse.state().streaming !== true;
  }

  /**
   * Forking is the same pi primitive as editing — a new branch before this
   * message — so it needs the same host support and, like edit, must not race a
   * running turn. It differs in outcome: nothing is sent, and the host hands the
   * forked prompt back to the composer to continue the branch.
   */
  protected canFork(): boolean {
    return this.morse.capabilities()?.forkMessage === true && this.morse.state().streaming !== true;
  }

  /** Branches a new session before this message; the host seeds the composer. */
  protected fork(item: UserTranscriptItem): void {
    this.morse.forkMessage(item.id);
  }

  /** Opens the inline editor for a user message, seeded with its text. */
  protected startEdit(item: UserTranscriptItem): void {
    this.editingId.set(item.id);
    this.editingText.set(item.text);
    this.afterRender(() => {
      const box = this.scrollHost().nativeElement.querySelector<HTMLTextAreaElement>('.edit-input');
      box?.focus();
      const end = box?.value.length ?? 0;
      box?.setSelectionRange(end, end);
    });
  }

  protected cancelEdit(): void {
    this.editingId.set(null);
    this.editingText.set('');
  }

  protected onEditInput(event: Event): void {
    this.editingText.set((event.target as HTMLTextAreaElement).value);
  }

  protected onEditKeydown(event: KeyboardEvent, item: UserTranscriptItem): void {
    // Same convention as the composer: Enter sends, Shift+Enter breaks the line.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.submitEdit(item);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelEdit();
    }
  }

  /** Sends the edited text; the host forks the conversation before this turn. */
  protected submitEdit(item: UserTranscriptItem): void {
    const text = this.editingText().trim();
    if (text.length === 0) {
      return;
    }
    this.morse.editMessage(item.id, text);
    this.cancelEdit();
  }

  /** Opening a mention reveals the file, when the host knows how. */
  protected openMention(path: string): void {
    if (this.morse.capabilities()?.revealFile === true) {
      void this.morse.requestHostCommand('revealFile', { path }).catch(() => undefined);
    }
  }

  /** Copying includes the pin mentions, like the prompt the agent received. */
  protected copyText(item: UserTranscriptItem): string {
    const pins = item.pins ?? [];
    if (pins.length === 0) {
      return item.text;
    }
    const mentions = pins
      .map((pin) => `${pin.path}${pin.startLine !== undefined ? `:${pin.startLine}-${pin.endLine ?? pin.startLine}` : ''}`)
      .map((token) => `@${token}`)
      .join('\n');
    return item.text.trim().length > 0 ? `${item.text}\n\n${mentions}` : mentions;
  }

  protected copy(item: UserTranscriptItem): void {
    this.copyRaw(item.id, this.copyText(item));
  }

  /** Copies the model's answer verbatim (the markdown source it produced). */
  protected copyAssistant(item: AssistantTranscriptItem): void {
    this.copyRaw(item.id, item.text);
  }

  private copyRaw(id: string, text: string): void {
    void navigator.clipboard?.writeText(text);
    this.copiedId.set(id);
    setTimeout(() => {
      if (this.copiedId() === id) {
        this.copiedId.set(null);
      }
    }, 1200);
  }
}
