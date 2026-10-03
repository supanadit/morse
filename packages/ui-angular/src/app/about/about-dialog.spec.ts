import { TestBed } from '@angular/core/testing';
import { MemoryHostTransport } from '@morse/ui-runtime';
import { PROTOCOL_VERSION } from '@morse/protocol';
import { describe, expect, it } from 'vitest';
import { AboutDialog } from './about-dialog';
import { CREDITS } from './credits';
import { ShellState } from '../core/shell-state';
import { MORSE_TRANSPORT } from '../core/transport.token';

async function render(): Promise<HTMLElement> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [AboutDialog],
    // The in-memory host answers the handshake, so the identity strip is filled
    // without VS Code or the NestJS server.
    providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new MemoryHostTransport() }],
  }).compileComponents();
  const fixture = TestBed.createComponent(AboutDialog);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('AboutDialog', () => {
  it('lists every credited group, one licence badge per row', async () => {
    const host = await render();
    const text = host.textContent ?? '';
    const rows = CREDITS.flatMap((group) => group.entries);

    for (const group of CREDITS) {
      expect(text).toContain(group.title);
    }
    expect(host.querySelectorAll('.license')).toHaveLength(rows.length);
    expect(host.querySelectorAll('.role')).toHaveLength(rows.length);
  });

  it('links every row out of the panel instead of navigating it away', async () => {
    const host = await render();
    const rows = CREDITS.flatMap((group) => group.entries);
    const links = [...host.querySelectorAll<HTMLAnchorElement>('a.name')];

    expect(links).toHaveLength(rows.length);
    expect(
      links.every((link) => link.target === '_blank' && link.href.startsWith('https://')),
    ).toBe(true);
  });

  it('says which build and which wire the reader is looking at', async () => {
    const host = await render();

    // The memory host echoes the identity the client announced (a real host reads
    // it from the served manifest), so a frontend always shows a version here.
    expect(host.textContent).toContain('@morse/ui-angular');
    expect(host.textContent).toContain(String(PROTOCOL_VERSION));
    expect(host.textContent).toContain('server');
  });

  it('closes on Escape and on the backdrop, leaving the card alone', async () => {
    const host = await render();
    const shell = TestBed.inject(ShellState);

    shell.openAbout();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(shell.aboutOpen()).toBe(false);

    // Clicking a row must not count as clicking the backdrop.
    shell.openAbout();
    (host.querySelector('.modal-card a.name') as HTMLElement).click();
    expect(shell.aboutOpen()).toBe(true);

    (host.querySelector('.modal-layer') as HTMLElement).click();
    expect(shell.aboutOpen()).toBe(false);
  });
});
