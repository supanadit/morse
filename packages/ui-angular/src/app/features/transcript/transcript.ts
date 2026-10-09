import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, HostListener, inject, signal, viewChild } from '@angular/core';
import type { AssistantTranscriptItem, PromptImage, UserTranscriptItem } from '@morse/protocol';
import {
  activeProcessKey,
  groupTranscriptItems,
  pinNoteHint,
  userMessageMarkdown,
  type TranscriptRow,
} from '@morse/ui-runtime';
import { AnimationService } from '../../ui/animation.service';
import { BootHandoff } from '../../state/boot-handoff';
import { Markdown } from '../../ui/markdown/markdown';
import { EnterDirective } from '../../ui/enter.directive';
import { ToolGroup } from '../tool-group/tool-group';
import { PromptRail, type RailPrompt } from '../prompt-rail/prompt-rail';
import { NoteHoverDirective } from '../../ui/pin-annotation/note-hover.directive';
import { MorseService } from '../../host/morse.service';

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
  imports: [Markdown, ToolGroup, EnterDirective, PromptRail, NoteHoverDirective],
  templateUrl: './transcript.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './transcript.css',
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
  /**
   * The ⧉ pin button only exists where the host can read an editor selection
   * (the VS Code host). The browser has no editor, so the empty-state hint must
   * not promise a button that is not under the composer there.
   */
  protected readonly canPinSelection = computed(
    () => this.morse.capabilities()?.editorContext === true,
  );

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

  /** `L13-17` for a range, `L13` for a single line (a pin may carry no end). */
  protected pinRange(pin: { startLine?: number; endLine?: number }): string {
    if (pin.startLine === undefined) {
      return '';
    }
    return pin.endLine !== undefined && pin.endLine !== pin.startLine
      ? `L${pin.startLine}-${pin.endLine}`
      : `L${pin.startLine}`;
  }

  /** A pin chip's annotation: first line only as a hint, full text on hover. */
  protected readonly pinNoteHint = pinNoteHint;

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
