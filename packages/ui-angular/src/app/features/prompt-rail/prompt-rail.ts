import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  input,
  OnDestroy,
  output,
  signal,
  viewChild,
} from '@angular/core';

/** One prompt on the rail: the user message id and its one-line preview. */
export interface RailPrompt {
  id: string;
  preview: string;
}

/** Vertical pitch of one tick, in px. */
const TICK_PITCH = 12;
/** The tape shows a window of ticks; edge hover carousels the rest into view. */
const MAX_VISIBLE_TICKS = 30;
/** Distance from the tape's top/bottom that starts the carousel, in px. */
const EDGE_ZONE = 18;
const CAROUSEL_INTERVAL_MS = 80;
/** Tick lengths for the proximity wave around the pointer. */
const TICK_BASE = 10;
const TICK_ACTIVE = 14;
const TICK_FOCUS = 20;
/** How fast neighbours taper off from the focused tick. */
const PROXIMITY_FALLOFF = [1, 0.6, 0.35, 0.15];
/** Grace period before the preview hides, so the pointer can travel into it. */
const PANEL_HIDE_DELAY_MS = 160;

/**
 * The prompt navigator rail: one tick per user
 * message on a tape at the right edge of the transcript. Hovering scrubs the
 * tape and reveals a preview list; clicking a tick or a row jumps to that
 * prompt. Purely presentational — the transcript owns the scroll container and
 * tells the rail which prompt is active.
 */
@Component({
  selector: 'morse-prompt-rail',
  templateUrl: './prompt-rail.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './prompt-rail.css',
})
export class PromptRail implements OnDestroy {
  readonly prompts = input.required<RailPrompt[]>();
  /** The prompt currently under the reading line, owned by the transcript. */
  readonly activeId = input<string | null>(null);
  /** A tick or preview row was picked; the transcript scrolls to it. */
  readonly pick = output<string>();

  protected readonly tickPitch = TICK_PITCH;
  protected readonly hovered = signal<number | null>(null);
  private readonly windowStart = signal(0);

  private readonly track = viewChild<ElementRef<HTMLElement>>('track');
  private readonly previewList = viewChild<ElementRef<HTMLElement>>('previewList');

  private pointerY: number | null = null;
  private direction: 0 | 1 | -1 = 0;
  private carouselTimer: ReturnType<typeof setInterval> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly visibleCount = computed(() =>
    Math.min(this.prompts().length, MAX_VISIBLE_TICKS),
  );
  protected readonly maxWindowStart = computed(() =>
    Math.max(0, this.prompts().length - this.visibleCount()),
  );
  protected readonly clampedWindowStart = computed(() =>
    Math.min(this.windowStart(), this.maxWindowStart()),
  );
  protected readonly hasMoreAbove = computed(() => this.clampedWindowStart() > 0);
  protected readonly hasMoreBelow = computed(
    () => this.clampedWindowStart() + this.visibleCount() < this.prompts().length,
  );
  protected readonly activeIndex = computed(() => {
    const id = this.activeId();
    return id === null ? -1 : this.prompts().findIndex((prompt) => prompt.id === id);
  });
  /** Fade the tape at the edges only while there are hidden ticks beyond them. */
  protected readonly mask = computed(() => {
    const above = this.hasMoreAbove();
    const below = this.hasMoreBelow();
    if (!above && !below) {
      return undefined;
    }
    const top = above ? 'transparent, black 14%' : 'black';
    const bottom = below ? 'black 86%, transparent' : 'black';
    return `linear-gradient(to bottom, ${top}, ${bottom})`;
  });

  constructor() {
    // While the pointer is away, keep the active prompt centred on the tape.
    effect(() => {
      if (this.hovered() !== null) {
        return;
      }
      const total = this.prompts().length;
      const count = Math.min(total, MAX_VISIBLE_TICKS);
      const max = Math.max(0, total - count);
      const target = this.activeIndex() >= 0 ? this.activeIndex() : total - 1;
      this.windowStart.set(Math.max(0, Math.min(max, target - Math.floor(count / 2))));
    });

    // The highlighted preview row stays in the panel viewport while scrubbing.
    effect(() => {
      const index = this.hovered();
      this.previewList();
      if (index === null) {
        return;
      }
      setTimeout(() => this.revealRow(index), 0);
    });
  }

  ngOnDestroy(): void {
    this.stopCarousel();
    this.cancelHide();
  }

  /** Wave on focus: the focused tick stretches, its neighbours taper off. */
  protected tickWidth(index: number): number {
    const base = this.prompts()[index]?.id === this.activeId() ? TICK_ACTIVE : TICK_BASE;
    const focus = this.hovered();
    if (focus === null) {
      return base;
    }
    const factor = PROXIMITY_FALLOFF[Math.abs(index - focus)] ?? 0;
    return Math.round(base + (TICK_FOCUS - base) * factor);
  }

  protected onEnter(): void {
    this.cancelHide();
  }

  protected onMove(event: MouseEvent): void {
    this.cancelHide();
    this.pointerY = event.clientY;
    const index = this.indexFromPointer(event.clientY);
    if (index !== null) {
      this.hovered.set(index);
    }
    this.updateCarousel(event.clientY);
  }

  protected onLeave(): void {
    this.pointerY = null;
    this.stopCarousel();
    this.scheduleHide();
  }

  protected onTrackClick(event: MouseEvent): void {
    const index = this.indexFromPointer(event.clientY);
    if (index !== null) {
      this.choose(index);
    }
  }

  protected stepWindow(direction: number): void {
    const step = Math.max(1, Math.floor(this.visibleCount() / 2));
    const next = Math.max(
      0,
      Math.min(this.maxWindowStart(), this.clampedWindowStart() + direction * step),
    );
    this.windowStart.set(next);
  }

  protected choose(index: number): void {
    const prompt = this.prompts()[index];
    if (!prompt) {
      return;
    }
    this.pick.emit(prompt.id);
    this.stopCarousel();
    this.hovered.set(null);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const total = this.prompts().length;
    if (total === 0) {
      return;
    }
    const current =
      this.hovered() ?? (this.activeIndex() >= 0 ? this.activeIndex() : total - 1);
    const moveTo = (index: number): void => {
      const next = Math.max(0, Math.min(total - 1, index));
      this.ensureWindowContains(next);
      this.hovered.set(next);
    };
    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        moveTo(current - 1);
        return;
      case 'ArrowDown':
        event.preventDefault();
        moveTo(current + 1);
        return;
      case 'Home':
        event.preventDefault();
        moveTo(0);
        return;
      case 'End':
        event.preventDefault();
        moveTo(total - 1);
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        this.choose(current);
        return;
      case 'Escape':
        event.preventDefault();
        this.hovered.set(null);
        return;
      default:
        return;
    }
  }

  /** The pointer's y maps straight to the nearest tick of the visible window. */
  private indexFromPointer(clientY: number): number | null {
    const track = this.track()?.nativeElement;
    const count = this.visibleCount();
    if (!track || count === 0) {
      return null;
    }
    const rect = track.getBoundingClientRect();
    const raw = Math.floor((clientY - rect.top) / TICK_PITCH);
    const relative = Math.max(0, Math.min(count - 1, raw));
    return Math.min(this.prompts().length - 1, this.clampedWindowStart() + relative);
  }

  /** Hovering the tape's edges carousels the window through the hidden ticks. */
  private updateCarousel(clientY: number): void {
    const track = this.track()?.nativeElement;
    if (!track) {
      return;
    }
    const rect = track.getBoundingClientRect();
    const y = clientY - rect.top;
    let direction: 0 | 1 | -1 = 0;
    if (y <= EDGE_ZONE && this.hasMoreAbove()) {
      direction = -1;
    } else if (y >= rect.height - EDGE_ZONE && this.hasMoreBelow()) {
      direction = 1;
    }
    this.direction = direction;
    if (direction === 0) {
      this.stopCarousel();
      return;
    }
    if (this.carouselTimer === null) {
      this.carouselTimer = setInterval(() => this.carouselStep(), CAROUSEL_INTERVAL_MS);
    }
  }

  private carouselStep(): void {
    if (this.direction === 0) {
      this.stopCarousel();
      return;
    }
    const current = this.clampedWindowStart();
    const next = Math.max(0, Math.min(this.maxWindowStart(), current + this.direction));
    if (next === current) {
      this.stopCarousel();
      return;
    }
    this.windowStart.set(next);
    if (this.pointerY !== null) {
      const index = this.indexFromPointer(this.pointerY);
      if (index !== null) {
        this.hovered.set(index);
      }
    }
  }

  private stopCarousel(): void {
    this.direction = 0;
    if (this.carouselTimer !== null) {
      clearInterval(this.carouselTimer);
      this.carouselTimer = null;
    }
  }

  private ensureWindowContains(index: number): void {
    const count = this.visibleCount();
    const max = this.maxWindowStart();
    const start = Math.min(this.clampedWindowStart(), max);
    if (index < start) {
      this.windowStart.set(index);
    } else if (index >= start + count) {
      this.windowStart.set(Math.min(max, index - count + 1));
    }
  }

  private scheduleHide(): void {
    this.cancelHide();
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.hovered.set(null);
    }, PANEL_HIDE_DELAY_MS);
  }

  private cancelHide(): void {
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  private revealRow(index: number): void {
    const list = this.previewList()?.nativeElement;
    const row = list?.children.item(index) as HTMLElement | null;
    if (!list || !row) {
      return;
    }
    const view = list.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    if (rect.top < view.top) {
      list.scrollTop -= view.top - rect.top;
    } else if (rect.bottom > view.bottom) {
      list.scrollTop += rect.bottom - view.bottom;
    }
  }
}
