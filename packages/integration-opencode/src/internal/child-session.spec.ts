import { describe, expect, it } from 'vitest';
import { childSessionOf } from './child-session.js';

/**
 * The engine-agnostic seam: a tool call that spawned a session links to it, so
 * the frontend can open the child's transcript from the row. The server names
 * the link in its metadata or input rather than a dedicated event, so the probe
 * accepts the shapes builds have used — and, crucially, refuses to guess on a
 * non-delegation tool, where a `sessionID` in the metadata can only ever mean
 * the parent.
 */
describe('childSessionOf', () => {
  it('reads a dedicated child key from the metadata', () => {
    expect(childSessionOf('read', { childSessionID: 'kid-1' })).toEqual({
      sessionId: 'kid-1',
    });
    expect(childSessionOf('read', { childID: 'kid-2' })).toEqual({
      sessionId: 'kid-2',
    });
  });

  it('reads the generic session key only for a delegation tool', () => {
    expect(childSessionOf('task', { sessionID: 'kid-3' })).toEqual({
      sessionId: 'kid-3',
    });
    expect(childSessionOf('task', { sessionId: 'kid-4', agent: 'scout' })).toEqual({
      sessionId: 'kid-4',
      agent: 'scout',
    });
    // A `read` whose metadata carries a sessionID is naming the parent session;
    // linking to it would make the row open the conversation it lives in.
    expect(childSessionOf('read', { sessionID: 'parent' })).toBeUndefined();
  });

  it('names the agent from the delegation input', () => {
    expect(childSessionOf('task', { childID: 'kid-5', subagentType: 'reviewer' })).toEqual({
      sessionId: 'kid-5',
      agent: 'reviewer',
    });
  });

  it('returns nothing without a usable id', () => {
    expect(childSessionOf('task', undefined)).toBeUndefined();
    expect(childSessionOf('task', { output: 'plain text' })).toBeUndefined();
    expect(childSessionOf('task', { sessionID: '' })).toBeUndefined();
  });
});
