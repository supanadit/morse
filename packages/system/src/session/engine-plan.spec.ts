import { describe, expect, it } from 'vitest';
import { planEngineRegistration } from './engine-plan.js';

/**
 * The rule both hosts share: report the engines this machine can actually run,
 * and never leave a draft without a default when there is one to pick. What
 * matters here: an unresolvable engine disappears from the list (that is what
 * removes the composer's picker on an OpenCode-only machine), and a host that
 * resolved nothing reports nothing — the setup screen names the installs from
 * the host's own `engineSetup`, not from a made-up engine entry.
 */
describe('planEngineRegistration', () => {
  it('keeps both engines and honours the configured preference', () => {
    expect(
      planEngineRegistration([
        { kind: 'pi', available: true },
        { kind: 'opencode', available: true, preferred: true },
      ]),
    ).toEqual([
      { kind: 'pi', default: false },
      { kind: 'opencode', default: true },
    ]);
  });

  it('drops an engine that does not resolve, so no picker is offered', () => {
    expect(
      planEngineRegistration([
        { kind: 'pi', available: false, preferred: true },
        { kind: 'opencode', available: true },
      ]),
    ).toEqual([{ kind: 'opencode', default: true }]);
  });

  it('keeps the single available engine as the default', () => {
    expect(
      planEngineRegistration([
        { kind: 'pi', available: true, preferred: true },
        { kind: 'opencode', available: false },
      ]),
    ).toEqual([{ kind: 'pi', default: true }]);
  });

  it('falls back to the other engine when the preferred one is missing', () => {
    expect(
      planEngineRegistration([
        { kind: 'pi', available: false },
        { kind: 'opencode', available: true, preferred: true },
        { kind: 'other', available: true },
      ]),
    ).toEqual([
      { kind: 'opencode', default: true },
      { kind: 'other', default: false },
    ]);
  });

  it('plans nothing when nothing resolved — the setup screen names the installs', () => {
    expect(
      planEngineRegistration([
        { kind: 'pi', available: false, preferred: true },
        { kind: 'opencode', available: false },
      ]),
    ).toEqual([]);
  });

  it('plans nothing when the host considered no engine', () => {
    expect(planEngineRegistration([])).toEqual([]);
  });
});
