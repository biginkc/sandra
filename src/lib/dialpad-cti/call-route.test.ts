import { describe, expect, it, vi } from 'vitest';
import { decideDialpadCallRoute, loadDialpadCallRoute, type DialpadCallRouteDeps } from './call-route';
import type { DialpadCallingBootstrap } from './dispatch';

const bound: DialpadCallingBootstrap = { connectionId: 'c1', binding: { status: 'verified', dialpadUserId: 'd1' }, grants: [] };
const allOn = { clickToDialFlag: true, apiDialSchemaReady: true, bootstrap: bound };

describe('decideDialpadCallRoute', () => {
  it('routes to Dialpad only when every condition holds', () => {
    expect(decideDialpadCallRoute(allOn)).toBe('dialpad');
    expect(decideDialpadCallRoute({ ...allOn, bootstrap: { ...bound, binding: { status: 'pending', dialpadUserId: 'd1' } } })).toBe('dialpad');
  });
  it.each([
    ['flag off', { ...allOn, clickToDialFlag: false }],
    ['api_dial schema not ready', { ...allOn, apiDialSchemaReady: false }],
    ['no active connection', { ...allOn, bootstrap: null }],
    ['no live binding', { ...allOn, bootstrap: { ...bound, binding: { status: 'none' as const } } }],
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

  it('is dialpad when all server facts hold', async () => {
    expect(await loadDialpadCallRoute(deps(), 'org', 'user')).toBe('dialpad');
  });
  it('flag off reads nothing else', async () => {
    const d = deps({ isFlagOn: vi.fn(async () => false) });
    expect(await loadDialpadCallRoute(d, 'org', 'user')).toBe('softphone');
    expect(d.isSchemaReady).not.toHaveBeenCalled();
    expect(d.loadBootstrap).not.toHaveBeenCalled();
  });
  it('schema not ready, no connection, no binding each give the softphone', async () => {
    expect(await loadDialpadCallRoute(deps({ isSchemaReady: async () => false }), 'o', 'u')).toBe('softphone');
    expect(await loadDialpadCallRoute(deps({ loadBootstrap: async () => null }), 'o', 'u')).toBe('softphone');
    expect(await loadDialpadCallRoute(deps({ loadBootstrap: async () => ({ ...bound, binding: { status: 'none' } }) }), 'o', 'u')).toBe('softphone');
  });
  it('any failure reads as the softphone', async () => {
    expect(await loadDialpadCallRoute(deps({ isFlagOn: async () => { throw new Error('db'); } }), 'o', 'u')).toBe('softphone');
    expect(await loadDialpadCallRoute(deps({ loadBootstrap: async () => { throw new Error('db'); } }), 'o', 'u')).toBe('softphone');
  });
});
