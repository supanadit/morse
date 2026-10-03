import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryHostTransport } from '@morse/ui-runtime';
import { App } from './app';
import { AttachmentStore } from './core/attachments';
import { MORSE_TRANSPORT } from './core/transport.token';

describe('App', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      // The mock host answers `client/ready` synchronously, so the view is
      // populated without VS Code or the NestJS server.
      providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new MemoryHostTransport() }],
    }).compileComponents();
  });

  it('renders the workspace reported by the host', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('mock-workspace');
  });

  it('shows the composer once the agent is ready', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.disabled).toBe(false);
  });

  it('hides a notice toast on its own', () => {
    vi.useFakeTimers();
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    TestBed.inject(AttachmentStore).say('info', '2 files attached');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.toast')?.textContent).toContain('2 files attached');

    vi.advanceTimersByTime(4_000);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.toast')).toBeNull();
  });

  /**
   * The footer must name the provider, not just the model: two providers can
   * expose the same display name, and the picked row must be the one the host
   * ends up selecting.
   */
  /**
   * Row 1 carries the live status (throughput, working, context indicator);
   * row 2 stays pure controls so the dropdowns and send button never move
   * while the numbers tick.
   */
  it('keeps usage on the status row above the model/thinking controls', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    const status = fixture.nativeElement.querySelector('.status-row') as HTMLElement;
    const controls = fixture.nativeElement.querySelector('.controls') as HTMLElement;
    expect(status.querySelector('morse-usage-indicator')).toBeTruthy();
    expect(controls.querySelector('morse-usage-indicator')).toBeNull();
    expect(controls.querySelector('.model-button')).toBeTruthy();
    expect(controls.querySelector('morse-thinking-picker')).toBeTruthy();
    // The live rate sits on the left of row 1; the ring stays on the right.
    expect(status.querySelector('.status-live .throughput')).toBeTruthy();
    expect(status.querySelector('.status-end morse-usage-indicator')).toBeTruthy();
  });

  it('shows the picked model with its provider and re-highlights it on reopen', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.model-button') as HTMLButtonElement).click();
    fixture.detectChanges();

    const rows = [...fixture.nativeElement.querySelectorAll('.row')] as HTMLElement[];
    (rows.find((row) => row.textContent?.includes('Mock Model (pro)')) as HTMLElement).click();
    fixture.detectChanges();

    const trigger = fixture.nativeElement.querySelector('.model-button') as HTMLElement;
    expect(trigger.querySelector('.provider')?.textContent?.trim()).toBe('mock-cloud');
    expect(trigger.querySelector('.label')?.textContent?.trim()).toBe('Mock Model (pro)');

    // Reopening highlights the active model, not the first row of the list.
    (trigger as HTMLButtonElement).click();
    fixture.detectChanges();
    const selected = fixture.nativeElement.querySelector(
      '.row[aria-current="true"]',
    ) as HTMLElement | null;
    expect(selected?.textContent).toContain('Mock Model (pro)');
    expect(selected?.classList.contains('active')).toBe(true);
  });
});
