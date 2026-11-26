import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MemoryHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { MorseService } from '../../host/morse.service';
import { AdminPanel } from './admin-panel';

const users = [
  { id: 'u1', username: 'adit', name: 'Adit Pratama', email: 'adit@example.com', role: 'admin', createdAt: 1 },
  { id: 'u2', username: 'bob', name: 'Bob Builder', email: 'bob@example.com', role: 'regular', createdAt: 2 },
];

async function render(): Promise<{ fixture: ComponentFixture<AdminPanel>; host: HTMLElement; morse: MorseService }> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [AdminPanel],
    providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new MemoryHostTransport() }],
  }).compileComponents();
  const morse = TestBed.inject(MorseService);
  const command = vi.spyOn(morse, 'requestHostCommand').mockImplementation(async (name) =>
    name === 'adminUsers' ? users : { ok: true },
  );
  const fixture = TestBed.createComponent(AdminPanel);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  // The refresh call above is the only list read before a test takes over.
  command.mockClear();
  return { fixture, host: fixture.nativeElement as HTMLElement, morse };
}

describe('AdminPanel', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows names and emails, and filters the roster by them', async () => {
    const { fixture, host } = await render();
    expect(host.querySelectorAll('.trow')).toHaveLength(2);
    expect(host.textContent).toContain('Adit Pratama');
    expect(host.textContent).toContain('bob@example.com');

    const search = host.querySelector('input[type="search"]') as HTMLInputElement;
    search.value = 'builder';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(host.querySelectorAll('.trow')).toHaveLength(1);
    expect(host.textContent).toContain('Bob Builder');
  });

  it('edits a profile and sends a new password through the admin command', async () => {
    const { fixture, host, morse } = await render();
    (host.querySelectorAll('.trow .text')[0] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(host.querySelector('.member-form')).not.toBeNull();

    const panel = fixture.componentInstance as unknown as {
      formName: { set(value: string): void };
      formPassword: { set(value: string): void };
      save(): Promise<void>;
    };
    panel.formName.set('Adit P.');
    panel.formPassword.set('newsecret9');
    await panel.save();

    expect(morse.requestHostCommand).toHaveBeenCalledWith('adminUpdateUser', {
      userId: 'u1',
      name: 'Adit P.',
      email: 'adit@example.com',
      role: 'admin',
      password: 'newsecret9',
    });
  });

  it('changes a role only from the edit dialog, never from the table', async () => {
    const { fixture, host, morse } = await render();
    expect(host.querySelector('.table select')).toBeNull();

    // The second row is Bob; his Edit button is the only way into his form.
    const bobRow = host.querySelectorAll('.trow')[1] as HTMLElement;
    (bobRow.querySelector('.text') as HTMLButtonElement).click();
    fixture.detectChanges();
    const options = [...host.querySelectorAll('.seg .seg-option')] as HTMLButtonElement[];
    expect(options.map((one) => one.textContent?.trim())).toEqual(['Member', 'Admin']);
    const admin = options[1]!;
    admin.click();
    fixture.detectChanges();
    expect(admin.getAttribute('aria-pressed')).toBe('true');

    const panel = fixture.componentInstance as unknown as { save(): Promise<void> };
    await panel.save();
    expect(morse.requestHostCommand).toHaveBeenCalledWith(
      'adminUpdateUser',
      expect.objectContaining({ userId: 'u2', role: 'admin' }),
    );
  });
});
