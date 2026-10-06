import { TestBed } from '@angular/core/testing';
import { MemoryHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { MORSE_TRANSPORT } from './transport.token';
import { ViewState } from './view-state';

/**
 * The seam that keeps a half-written editor across a reload. It must use the
 * host's own store when the transport offers one (VS Code's webview state), and
 * drop a value when written as `undefined` so an added entry leaves no draft.
 */
describe('ViewState', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('keeps values in the host store and clears them on write(undefined)', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new MemoryHostTransport() }],
    });
    const view = TestBed.inject(ViewState);

    expect(view.read('mcp-editor')).toBeUndefined();
    view.write('mcp-editor', { name: 'filesystem' });
    expect(view.read('mcp-editor')).toEqual({ name: 'filesystem' });
    view.write('mcp-editor', undefined);
    expect(view.read('mcp-editor')).toBeUndefined();
  });

  it('namespaces keys, so two surfaces do not collide', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new MemoryHostTransport() }],
    });
    const view = TestBed.inject(ViewState);
    view.write('a', 1);
    view.write('b', 2);
    expect(view.read<number>('a')).toBe(1);
    expect(view.read<number>('b')).toBe(2);
    view.write('a', undefined);
    expect(view.read<number>('b')).toBe(2);
  });
});
