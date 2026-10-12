import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { SessionSpeed, TokenUsage } from '@morse/protocol';
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
}): { fixture: ComponentFixture<UsageIndicator>; host: HTMLElement } {
  TestBed.configureTestingModule({ imports: [UsageIndicator] });
  const fixture = TestBed.createComponent(UsageIndicator);
  fixture.componentRef.setInput('usage', inputs.usage);
  fixture.componentRef.setInput('speed', inputs.speed);
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
