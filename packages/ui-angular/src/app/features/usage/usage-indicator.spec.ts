import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { ContextUsage, SessionSpeed, TokenUsage } from '@morse/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageIndicator } from './usage-indicator';

/**
 * The session totals gained cache and speed cells after older sessions had
 * already been written. A session file from before then carries no speed at
 * all, and the panel must render `—` rather than `0/s` (which would claim the
 * model answered instantly) or a blank cell.
 */

function setup(inputs: {
  usage?: TokenUsage;
  speed?: SessionSpeed;
  contextUsage?: ContextUsage;
  variant?: 'full' | 'context';
}): { fixture: ComponentFixture<UsageIndicator>; host: HTMLElement } {
  TestBed.configureTestingModule({ imports: [UsageIndicator] });
  const fixture = TestBed.createComponent(UsageIndicator);
  fixture.componentRef.setInput('usage', inputs.usage);
  fixture.componentRef.setInput('speed', inputs.speed);
  fixture.componentRef.setInput('contextUsage', inputs.contextUsage);
  if (inputs.variant !== undefined) {
    fixture.componentRef.setInput('variant', inputs.variant);
  }
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement };
}

/** The value shown beside a labelled cell, wherever in the panel it sits. */
function cellValue(host: HTMLElement, label: string): string {
  const cell = [...host.querySelectorAll('.cell')].find(
    (node) => node.querySelector('.k')?.textContent?.trim() === label,
  );
  return cell?.querySelector('.v')?.textContent?.trim() ?? '';
}

describe('UsageIndicator placement', () => {
  afterEach(() => TestBed.resetTestingModule());

  /**
   * A trigger inside a scrolling pane is clipped by that pane, so the panel must
   * be placed against it rather than hanging off the trigger's left edge, which
   * is what ran it under the sidebar.
   */
  it('places the panel inside the pane instead of hanging off it', () => {
    const { fixture, host } = setup({ variant: 'context' });
    (host.querySelector('.mini') as HTMLButtonElement).click();
    fixture.detectChanges();

    const panel = host.querySelector('.panel') as HTMLElement;
    expect(panel.style.left).not.toBe('');
    expect(panel.style.maxWidth).toBe('320px');
    expect(panel.style.maxHeight).not.toBe('');
  });

  it('takes its scrim and panel away when the trigger is pressed again', () => {
    const { fixture, host } = setup({ variant: 'context' });
    (host.querySelector('.mini') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(host.querySelector('.panel')).not.toBeNull();

    (host.querySelector('.mini') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(host.querySelector('.panel')).toBeNull();
  });
});

describe('UsageIndicator session totals', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows em dashes for a session that predates the speed feature', () => {
    const usage: TokenUsage = {
      inputTokens: 12_000,
      outputTokens: 900,
      cacheReadTokens: 40_000,
      totalTokens: 52_900,
    };
    const { fixture, host } = setup({ usage });
    // Open the panel: the cells live behind the ring.
    (host.querySelector('.mini') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(cellValue(host, 'Cached')).toBe('40k');
    expect(cellValue(host, 'Miss')).toBe('12k');
    // No measurement on file: every speed cell reads em dash, not zero.
    expect(cellValue(host, 'Avg speed')).toBe('—');
    expect(cellValue(host, 'Peak speed')).toBe('—');
    expect(cellValue(host, 'Lowest speed')).toBe('—');
  });

  it('shows em dashes for an untouched session with no usage either', () => {
    const { fixture, host } = setup({});
    (host.querySelector('.mini') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(cellValue(host, 'Cached')).toBe('—');
    expect(cellValue(host, 'Miss')).toBe('—');
    expect(cellValue(host, 'Avg speed')).toBe('—');
    expect(cellValue(host, 'Peak speed')).toBe('—');
    expect(cellValue(host, 'Lowest speed')).toBe('—');
  });

  it('renders measured speeds once a session has them', () => {
    const { fixture, host } = setup({
      usage: { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 9_000, totalTokens: 10_500 },
      speed: { avgTokensPerSecond: 42.7, peakTokensPerSecond: 88.9, slowestTokensPerSecond: 11.25 },
    });
    (host.querySelector('.mini') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(cellValue(host, 'Avg speed')).toBe('42.7/s');
    expect(cellValue(host, 'Peak speed')).toBe('88.9/s');
    expect(cellValue(host, 'Lowest speed')).toBe('11.3/s');
  });
});

/**
 * Bot mode's panel is the budget and nothing else. A bot answers from its own
 * engine session, so message counts, cache, speed and cost describe a run of the
 * reader's work that does not exist here — the numbers arrived half-empty
 * (`ASSISTANT 0`, `COST –`) and read as a broken panel rather than as a budget.
 */
describe('UsageIndicator in bot mode', () => {
  const contextUsage: ContextUsage = {
    tokens: 233_000,
    contextWindow: 1_000_000,
    percent: 23.3,
  };

  afterEach(() => TestBed.resetTestingModule());

  function open(host: HTMLElement, fixture: ComponentFixture<UsageIndicator>): void {
    (host.querySelector('.mini') as HTMLButtonElement).click();
    fixture.detectChanges();
  }

  it('offers the pair a budget needs: spent and left', () => {
    const usage: TokenUsage = { inputTokens: 900, outputTokens: 100, totalTokens: 1_000 };
    const { fixture, host } = setup({ usage, contextUsage, variant: 'context' });
    open(host, fixture);

    expect(cellValue(host, 'Used')).toBe('233k');
    expect(cellValue(host, 'Remaining')).toBe('767k');
    // One row of two, not two of three: the window itself is on the bar above.
    expect(host.querySelector('.grid.pair')).toBeTruthy();
    expect(host.querySelector('.panel')?.textContent).toContain('233k / 1.0M');
  });

  it('leaves out the session economics a bot session cannot describe', () => {
    const usage: TokenUsage = { inputTokens: 900, outputTokens: 100, totalTokens: 1_000 };
    const { fixture, host } = setup({ usage, contextUsage, variant: 'context' });
    open(host, fixture);

    for (const label of ['Messages', 'User', 'Assistant', 'Tool calls', 'Cost', 'Output limit']) {
      expect(cellValue(host, label)).toBe('');
    }
    expect(host.textContent).not.toContain('Session totals');
    expect(host.textContent).not.toContain('Last assistant message');
  });

  it('says the remainder is unknown when the engine reports no tokens', () => {
    // Right after a compaction the engine reports a window and no count; a
    // remainder guessed from zero would claim the whole window is free.
    const { fixture, host } = setup({
      contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
      variant: 'context',
    });
    open(host, fixture);

    expect(cellValue(host, 'Used')).toBe('—');
    expect(cellValue(host, 'Remaining')).toBe('—');
  });

  it('keeps the whole panel for a code session', () => {
    const { fixture, host } = setup({
      usage: { inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500 },
      contextUsage,
    });
    open(host, fixture);

    expect(cellValue(host, 'User')).toBe('—');
    expect(host.textContent).toContain('Session totals');
    expect(host.textContent).toContain('Output limit');
  });
});
