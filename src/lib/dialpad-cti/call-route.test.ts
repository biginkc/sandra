import { describe, expect, it, vi } from 'vitest';
import { decideDialpadCallRoute, loadDialpadCallRoute, type DialpadCallRouteDeps } from './call-route';
import type { DialpadCallingBootstrap } from './dispatch';

const bound: DialpadCallingBootstrap = { connectionId: 'c1', binding: { status: 'verified', dialpadUserId: 'd1' }, grants: [] };
const unbound: DialpadCallingBootstrap = { connectionId: 'c1', binding: { status: 'none' }, grants: [] };
const allOn = { clickToDialFlag: true, apiDialSchemaReady: true, bootstrap: bound, acquisitionsMember: true };

describe('decideDialpadCallRoute', () => {
  it('acquisitions member who is bound gets Dialpad', () => {
    expect(decideDialpadCallRoute(allOn)).toBe('dialpad');
  });
  it('acquisitions member with no live binding stays on Dialpad (the denial / connect prompt), never Telnyx', () => {
    expect(decideDialpadCallRoute({ ...allOn, bootstrap: unbound })).toBe('dialpad');
  });
  it('a non-acquisitions member gets Telnyx even when bound', () => {
    expect(decideDialpadCallRoute({ ...allOn, acquisitionsMember: false })).toBe('softphone');
  });
  it.each([
    ['flag off', { ...allOn, clickToDialFlag: false }],
    ['flag off, not acquisitions', { ...allOn, clickToDialFlag: false, acquisitionsMember: false }],
    ['api_dial schema not ready', { ...allOn, apiDialSchemaReady: false }],
    ['no active connection', { ...allOn, bootstrap: null }],
  ])('falls back to the softphone when %s', (_name, facts) => {
    expect(decideDialpadCallRoute(facts)).toBe('softphone');
  });
});

describe('loadDialpadCallRoute', () => {
  const deps = (over: Partial<DialpadCallRouteDeps> = {}): DialpadCallRouteDeps => ({
    isFlagOn: vi.fn(async () => true),
    isSchemaReady: vi.fn(async () => true),
    loadBootstrap: vi.fn(async () => bound),
    ...over,
  });

  it('is dialpad for a bound acquisitions member', async () => {
    expect(await loadDialpadCallRoute(deps(), 'org', 'user', true)).toBe('dialpad');
  });
  it('is dialpad for an unbound acquisitions member', async () => {
    expect(await loadDialpadCallRoute(deps({ loadBootstrap: async () => unbound }), 'org', 'user', true)).toBe('dialpad');
  });
  it('a bound non-acquisitions member gets the softphone and nothing is read', async () => {
    const d = deps();
    expect(await loadDialpadCallRoute(d, 'org', 'user', false)).toBe('softphone');
    expect(d.isFlagOn).not.toHaveBeenCalled();
    expect(d.loadBootstrap).not.toHaveBeenCalled();
  });
  it('flag off reads nothing else', async () => {
    const d = deps({ isFlagOn: vi.fn(async () => false) });
    expect(await loadDialpadCallRoute(d, 'org', 'user', true)).toBe('softphone');
    expect(d.isSchemaReady).not.toHaveBeenCalled();
    expect(d.loadBootstrap).not.toHaveBeenCalled();
  });
  it('schema not ready and no connection each give the softphone', async () => {
    expect(await loadDialpadCallRoute(deps({ isSchemaReady: async () => false }), 'o', 'u', true)).toBe('softphone');
    expect(await loadDialpadCallRoute(deps({ loadBootstrap: async () => null }), 'o', 'u', true)).toBe('softphone');
  });
  it('any failure reads as the softphone', async () => {
    expect(await loadDialpadCallRoute(deps({ isFlagOn: async () => { throw new Error('db'); } }), 'o', 'u', true)).toBe('softphone');
    expect(await loadDialpadCallRoute(deps({ loadBootstrap: async () => { throw new Error('db'); } }), 'o', 'u', true)).toBe('softphone');
  });
});
