import { computed } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { HostToClientMessage, SessionViewState } from '@morse/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { MORSE_TRANSPORT } from './transport.token';
import { MorseService } from './morse.service';
import type { HostTransport, TransportKind, TransportStatus } from '@morse/ui-runtime';

/** A transport whose `toClient` lets a test push host messages by hand. */
class ScriptedTransport implements HostTransport {
  readonly kind: TransportKind = 'memory';
  private readonly listeners = new Set<(message: HostToClientMessage) => void>();
  private readonly statuses = new Set<(status: TransportStatus, detail?: string) => void>();
  readonly sent: unknown[] = [];
  connect(): void {}
  dispose(): void {}
  send(message: unknown): void {
    this.sent.push(message);
  }
  onMessage(listener: (message: HostToClientMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onStatus(listener: (status: TransportStatus, detail?: string) => void): () => void {
    this.statuses.add(listener);
    return () => this.statuses.delete(listener);
  }
  toClient(message: HostToClientMessage): void {
    for (const listener of [...this.listeners]) {
      listener(message);
    }
  }
}

function state(
  overrides: Partial<SessionViewState> & { workspace: SessionViewState['workspace'] },
) {
  return {
    streaming: false,
    busy: false,
    availableModels: [],
    availableThinkingLevels: [],
    availableCommands: [],
    ...overrides,
  } as SessionViewState;
}

/**
 * `MorseService.workspace` is read by effects that trigger I/O: the git panel
 * re-reads its repository list plus a history/status round trip per repository,
 * and the Explorer re-reads the tree. The host rebuilds that `workspace` object
 * on every `session/state` emit — which happens on every `agent/state` during a
 * run — so returning it straight through made those effects fire on every token.
 * On a project holding two dozen repositories that storm outran the 5s answer
 * timeout, and the panel reported that the host could not read its history.
 *
 * The computed must therefore be equal by *value*: unchanged in a run's emits,
 * and a new value only when the project actually changes.
 */
describe('MorseService.workspace stability', () => {
  afterEach(() => TestBed.resetTestingModule());

  function mount(transport: ScriptedTransport) {
    TestBed.configureTestingModule({
      providers: [{ provide: MORSE_TRANSPORT, useValue: transport }],
    });
    return TestBed.inject(MorseService);
  }

  it('keeps the same value across state emits for the same project', () => {
    const transport = new ScriptedTransport();
    const morse = mount(transport);
    const seen: unknown[] = [];

    for (let index = 0; index < 20; index += 1) {
      transport.toClient({
        type: 'session/state',
        payload: state({ workspace: { cwd: '/repo', name: 'repo' } }),
      });
      seen.push(morse.workspace());
    }

    const first = seen[0];
    expect(seen.every((value) => value === first)).toBe(true);
  });

  it('reports a new value only when the project actually changes', () => {
    const transport = new ScriptedTransport();
    const morse = mount(transport);

    transport.toClient({
      type: 'session/state',
      payload: state({ workspace: { cwd: '/repo', name: 'repo' } }),
    });
    const before = morse.workspace();
    transport.toClient({
      type: 'session/state',
      payload: state({ workspace: { cwd: '/other', name: 'other' } }),
    });

    expect(morse.workspace()).not.toBe(before);
    expect(morse.workspace().cwd).toBe('/other');
  });

  it('does not notify a dependent of an unchanged project', () => {
    const transport = new ScriptedTransport();
    const morse = mount(transport);
    let runs = 0;
    // Exactly what the git panel's effect does: read `workspace()` as a signal.
    const project = computed(() => {
      runs += 1;
      return morse.workspace().cwd;
    });

    transport.toClient({
      type: 'session/state',
      payload: state({ workspace: { cwd: '/repo', name: 'repo' } }),
    });
    const afterFirst = project();
    expect(afterFirst).toBe('/repo');

    // A run's emits change the streaming flag, not the project.
    for (let index = 0; index < 5; index += 1) {
      transport.toClient({
        type: 'session/state',
        payload: state({
          workspace: { cwd: '/repo', name: 'repo' },
          streaming: index % 2 === 0,
        }),
      });
    }

    expect(project()).toBe('/repo');
    // One evaluation: the emits left `workspace` equal, so the dependent never
    // went dirty and never recomputed.
    expect(runs).toBe(1);
  });
});
