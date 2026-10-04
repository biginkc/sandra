import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/errors/report', () => ({ reportError: vi.fn() }));

import type { Json } from '@/lib/supabase/types';

import { classifyDialpadRpcError } from './contracts';
import {
  cancelDialpadCall,
  dialpadDenialMessage,
  ensureDialpadBinding,
  getDialpadCallStatus,
  listDialpadCallTargets,
  loadDialpadCallingBootstrap,
  maskDialpadPhone,
  startDialpadCall,
  verifyDialpadBinding,
  type DialpadActor,
  type DialpadConnectionView,
  type DialpadDispatchDb,
} from './dispatch';
import { DialpadDbError } from './event-processing';

const ORG = '11111111-1111-4111-8111-111111111111';
const REP = '22222222-2222-4222-8222-222222222222';
const PROPERTY = '33333333-3333-4333-8333-333333333333';
const CONTACT = '44444444-4444-4444-8444-444444444444';
const KEY = '55555555-5555-4555-8555-555555555555';
const INTENT = '66666666-6666-4666-8666-666666666666';
const BINDING = '77777777-7777-4777-8777-777777777777';
const GRANT = '88888888-8888-4888-8888-888888888888';
const TOKEN = `sandra.dialpad.v1.${'b'.repeat(48)}`;
const actor: DialpadActor = { orgId: ORG, userId: REP };
const API_KEY = 'k'.repeat(24);

const prepared = (over: Record<string, Json> = {}): Json => ({
  intentId: INTENT, customData: TOKEN, status: 'prepared', preparedAt: '2026-09-29T10:00:00Z', expiresAt: '2026-09-29T10:10:00Z',
  destinationE164: '+18165440196', phoneSlot: 1, callerNumberE164: null, callerIdentityType: null, callerIdentityId: null,
  dialpadUserId: '5551234', propertyId: PROPERTY, contactId: CONTACT, assignmentEpisodeId: '99999999-9999-4999-8999-999999999999', replayed: false, ...over,
});
const authorized = (dial: Record<string, Json> = {}): Json => ({
  status: 'authorized', intentId: INTENT, expiresAt: '2026-09-29T10:10:00Z', dispatchAuthorizedAt: '2026-09-29T10:00:01Z',
  dial: { dialpadUserId: '5551234', phoneNumber: '+18165440196', customData: TOKEN, identityType: null, identityId: null, outboundCallerId: null, ...dial },
});

const conn = (over: Partial<DialpadConnectionView> = {}): DialpadConnectionView => ({
  id: 'c', status: 'active', allowedOrigins: ['https://dialpad.com'], companyId: '42', directoryKeyRef: 'env:DIALPAD_CTI_DIRECTORY_KEY_A', dialEndpoint: 'initiate_call', dialKeyRef: null, ...over,
});

function fakeDb(over: Partial<DialpadDispatchDb> = {}): DialpadDispatchDb & { calls: string[] } {
  const calls: string[] = [];
  const track = <T extends unknown[], R>(name: string, fn: (...args: T) => Promise<R>) => (...args: T) => { calls.push(name); return fn(...args); };
  const db: DialpadDispatchDb = {
    loadConnection: track('loadConnection', async () => conn()),
    loadLiveBinding: track('loadLiveBinding', async () => ({ id: BINDING, status: 'verified' as const, dialpadUserId: '5551234' })),
    loadActiveGrants: track('loadActiveGrants', async () => []),
    loadTargetPhones: track('loadTargetPhones', async () => ({ contactId: CONTACT, slots: [{ slot: 1 as const, raw: '(816) 544-0196' }] })),
    loadDispatchLoad: track('loadDispatchLoad', async () => ({ authorizedLastMinute: 0, unmatchedLast20s: 0 })),
    loadCallSlots: track('loadCallSlots', async () => [{ slot: 1 as const, callable: true, reason: null }]),
    claimBinding: track('claimBinding', async () => ({ bindingId: BINDING, status: 'pending', dialpadUserId: '5551234', replayed: false })),
    verifyBinding: track('verifyBinding', async () => ({ bindingId: BINDING, status: 'verified', replayed: false })),
    prepareIntent: track('prepareIntent', async () => prepared()),
    authorizeDispatch: track('authorizeDispatch', async () => authorized()),
    cancelIntent: track('cancelIntent', async () => ({ intentId: INTENT, status: 'cancelled', replayed: false })),
    getCallStatus: track('getCallStatus', async () => ({ intentId: INTENT, state: 'awaiting_provider', connected: false, propertyId: PROPERTY, expiresAt: '2026-09-29T10:10:00Z', dispatchAuthorizedAt: '2026-09-29T10:00:01Z' })),
    ...over,
  };
  return Object.assign(db, { calls });
}

const startInput = { propertyId: PROPERTY, contactId: CONTACT, phoneSlot: 1, grantId: null, idempotencyKey: KEY };
const forbidden = (detail: string) => new DialpadDbError(classifyDialpadRpcError({ code: '42501', details: detail }), '42501');

describe('loadDialpadCallingBootstrap', () => {
  it('is null without an active connection that allows the fixed Dialpad origin', async () => {
    expect(await loadDialpadCallingBootstrap(fakeDb({ loadConnection: async () => null }), actor)).toBeNull();
    expect(await loadDialpadCallingBootstrap(fakeDb({ loadConnection: async () => conn({ status: 'disabled' }) }), actor)).toBeNull();
    expect(await loadDialpadCallingBootstrap(fakeDb({ loadConnection: async () => conn({ allowedOrigins: ['https://example.com'] }) }), actor)).toBeNull();
  });
  it('reports binding none, pending and verified', async () => {
    expect(await loadDialpadCallingBootstrap(fakeDb({ loadLiveBinding: async () => null }), actor)).toEqual({ connectionId: 'c', binding: { status: 'none' }, grants: [] });
    expect(await loadDialpadCallingBootstrap(fakeDb({ loadLiveBinding: async () => ({ id: BINDING, status: 'pending' as const, dialpadUserId: '5551234' }) }), actor))
      .toMatchObject({ binding: { status: 'pending', dialpadUserId: '5551234' } });
    expect(await loadDialpadCallingBootstrap(fakeDb(), actor)).toMatchObject({ binding: { status: 'verified', dialpadUserId: '5551234' } });
  });
  it('includes grants and exposes no origins, recording or key reference', async () => {
    const grants = [{ id: GRANT, callerNumberE164: '+18165550100', identityType: null }];
    const bootstrap = await loadDialpadCallingBootstrap(fakeDb({ loadActiveGrants: async () => grants }), actor);
    expect(bootstrap?.grants).toEqual(grants);
    expect(bootstrap).not.toHaveProperty('allowedOrigins');
    expect(bootstrap).not.toHaveProperty('recording');
    expect(JSON.stringify(bootstrap)).not.toContain('DIALPAD_CTI_DIRECTORY_KEY');
  });

  it('does not reuse a verified binding stored for another authenticated actor', async () => {
    const jarrad = { orgId: ORG, userId: 'jarrad-user' };
    const gretchen = { orgId: ORG, userId: 'gretchen-user' };
    const loadLiveBinding = vi.fn(async (_orgId: string, userId: string) => userId === jarrad.userId
      ? { id: BINDING, status: 'verified' as const, dialpadUserId: '5551234' }
      : null);
    const prepareIntent = vi.fn(async () => prepared());
    const authorizeDispatch = vi.fn(async () => authorized());
    const db = fakeDb({ loadLiveBinding, prepareIntent, authorizeDispatch });

    await expect(loadDialpadCallingBootstrap(db, gretchen)).resolves.toMatchObject({
      binding: { status: 'none' },
    });
    await expect(loadDialpadCallingBootstrap(db, jarrad)).resolves.toMatchObject({
      binding: { status: 'verified', dialpadUserId: '5551234' },
    });

    const result = await startDialpadCall(db, gretchen, startInput);
    expect(result).toMatchObject({ ok: false, code: 'not_bound' });
    expect(prepareIntent).not.toHaveBeenCalled();
    expect(authorizeDispatch).not.toHaveBeenCalled();
    expect(loadLiveBinding).toHaveBeenCalledWith(ORG, gretchen.userId);
  });
});

describe('verifyDialpadBinding (trusted path)', () => {
  const identity = { email: 'rep@example.com', emailConfirmed: true };
  const env = { DIALPAD_CTI_DIRECTORY_KEY_A: API_KEY };
  const directory = (body: string, status = 200) => async () => ({ status, text: async () => body });
  const record = '{"id":5551234,"company_id":42,"state":"active","emails":["rep@example.com"]}';

  it('claims then verifies only after the directory matches, recording id-only evidence', async () => {
    const db = fakeDb({ loadLiveBinding: async () => null });
    const verifyBinding = vi.spyOn(db, 'verifyBinding');
    const result = await verifyDialpadBinding(db, actor, identity, 5551234, { env, fetchImpl: directory(record) });
    expect(result).toEqual({ ok: true, dialpadUserId: '5551234', replayed: false });
    expect(verifyBinding).toHaveBeenCalledWith(BINDING, 'provider_directory', 'dialpad-directory:42:5551234');
    expect(db.calls.indexOf('claimBinding')).toBeGreaterThan(-1);
  });
  it.each([
    ['another company', '{"id":5551234,"company_id":43,"state":"active","emails":["rep@example.com"]}'],
    ['a different email', '{"id":5551234,"company_id":42,"state":"active","emails":["someone@example.com"]}'],
    ['a suspended user', '{"id":5551234,"company_id":42,"state":"suspended","emails":["rep@example.com"]}'],
    ['a different user id', '{"id":5551235,"company_id":42,"state":"active","emails":["rep@example.com"]}'],
  ])('writes nothing when the directory shows %s', async (_label, body) => {
    const db = fakeDb({ loadLiveBinding: async () => null });
    const result = await verifyDialpadBinding(db, actor, identity, 5551234, { env, fetchImpl: directory(body) });
    expect(result).toMatchObject({ ok: false, code: 'identity_mismatch' });
    expect(db.calls).not.toContain('claimBinding');
    expect(db.calls).not.toContain('verifyBinding');
  });
  it('rejects an unconfirmed Sandra email even when the directory lists it', async () => {
    const db = fakeDb({ loadLiveBinding: async () => null });
    const result = await verifyDialpadBinding(db, actor, { email: 'rep@example.com', emailConfirmed: false }, 5551234, { env, fetchImpl: directory(record) });
    expect(result).toMatchObject({ ok: false, code: 'identity_mismatch', reason: 'email_unverified' });
    expect(db.calls).not.toContain('claimBinding');
  });
  it('never verifies a browser claim on its own when verification is not configured', async () => {
    const db = fakeDb({ loadLiveBinding: async () => null });
    expect(await verifyDialpadBinding(db, actor, identity, 5551234, { env: {}, fetchImpl: directory(record) })).toMatchObject({ ok: false, code: 'not_configured' });
    const noCompany = fakeDb({ loadLiveBinding: async () => null, loadConnection: async () => conn({ companyId: null }) });
    expect(await verifyDialpadBinding(noCompany, actor, identity, 5551234, { env, fetchImpl: directory(record) })).toMatchObject({ ok: false, code: 'not_configured' });
    expect(db.calls).not.toContain('claimBinding');
  });
  it('rejects malformed or unsafe claims before any lookup', async () => {
    const db = fakeDb();
    for (const claim of ['abc', 9007199254740993, -1, null, {}]) {
      expect(await verifyDialpadBinding(db, actor, identity, claim, { env, fetchImpl: directory(record) })).toMatchObject({ ok: false, code: 'invalid_input' });
    }
    expect(db.calls).toEqual([]);
  });
  it('treats an outage as retryable and unknown users as a mismatch', async () => {
    const unavailable = fakeDb({ loadLiveBinding: async () => null });
    expect(await verifyDialpadBinding(unavailable, actor, identity, 5551234, { env, fetchImpl: directory('', 500) })).toMatchObject({ ok: false, code: 'unavailable' });
    expect(unavailable.calls).not.toContain('claimBinding');
    expect(await verifyDialpadBinding(fakeDb({ loadLiveBinding: async () => null }), actor, identity, 5551234, { env, fetchImpl: directory('', 404) })).toMatchObject({ ok: false, code: 'identity_mismatch' });
  });
  it('is idempotent for an already verified binding and refuses a different verified id', async () => {
    const db = fakeDb();
    expect(await verifyDialpadBinding(db, actor, identity, 5551234, { env, fetchImpl: directory(record) })).toEqual({ ok: true, dialpadUserId: '5551234', replayed: true });
    expect(await verifyDialpadBinding(db, actor, identity, 5559999, { env, fetchImpl: directory(record) })).toMatchObject({ ok: false, code: 'denied', denial: 'binding_exists' });
    expect(db.calls).not.toContain('claimBinding');
  });
  it('surfaces the database uniqueness denial', async () => {
    const db = fakeDb({ loadLiveBinding: async () => null, verifyBinding: async () => { throw forbidden('dialpad_user_already_bound'); } });
    expect(await verifyDialpadBinding(db, actor, identity, 5551234, { env, fetchImpl: directory(record) })).toMatchObject({ ok: false, code: 'denied', denial: 'dialpad_user_already_bound' });
  });
});

describe('startDialpadCall', () => {
  it('prepares then authorizes and releases the frozen payload once', async () => {
    const db = fakeDb();
    const result = await startDialpadCall(db, actor, startInput);
    expect(result).toEqual({
      ok: true, dispatched: true, intentId: INTENT, expiresAt: '2026-09-29T10:10:00Z',
      dial: { dialpadUserId: '5551234', phoneNumber: '+18165440196', customData: TOKEN, identityType: null, identityId: null, identityIdText: null, outboundCallerId: null },
    });
    expect(db.calls.filter((name) => name === 'prepareIntent')).toHaveLength(1);
    expect(db.calls.filter((name) => name === 'authorizeDispatch')).toHaveLength(1);
  });
  it('passes only the authenticated org and rep to the database', async () => {
    const prepareIntent = vi.fn(async () => prepared());
    const authorizeDispatch = vi.fn(async () => authorized());
    await startDialpadCall(fakeDb({ prepareIntent, authorizeDispatch }), actor, { ...startInput, grantId: GRANT });
    expect(prepareIntent).toHaveBeenCalledWith({ orgId: ORG, userId: REP, propertyId: PROPERTY, contactId: CONTACT, phoneSlot: 1, idempotencyKey: KEY, grantId: GRANT });
    expect(authorizeDispatch).toHaveBeenCalledWith(ORG, REP, INTENT);
  });
  it('a retry of the same key never releases the payload again', async () => {
    let released = false;
    const db = fakeDb({
      authorizeDispatch: async () => {
        if (released) return { status: 'already_dispatched', intentId: INTENT, expiresAt: '2026-09-29T10:10:00Z', dispatchAuthorizedAt: '2026-09-29T10:00:01Z' };
        released = true;
        return authorized();
      },
      prepareIntent: async () => prepared({ replayed: released }),
    });
    const first = await startDialpadCall(db, actor, startInput);
    const retry = await startDialpadCall(db, actor, startInput);
    const again = await startDialpadCall(db, actor, startInput);
    expect(first).toMatchObject({ ok: true, dispatched: true });
    expect(retry).toEqual({ ok: true, dispatched: false, intentId: INTENT });
    expect(again).toEqual({ ok: true, dispatched: false, intentId: INTENT });
  });
  it('sends the identity as a number and an outbound caller id when there is none', async () => {
    const withIdentity = await startDialpadCall(
      fakeDb({ prepareIntent: async () => prepared({ callerIdentityType: 'Office', callerIdentityId: '1234567' }), authorizeDispatch: async () => authorized({ identityType: 'Office', identityId: '1234567' }) }),
      actor, startInput);
    expect(withIdentity).toMatchObject({ dispatched: true, dial: { identityType: 'Office', identityId: 1234567, identityIdText: '1234567', outboundCallerId: null } });
    const withNumber = await startDialpadCall(fakeDb({ authorizeDispatch: async () => authorized({ outboundCallerId: '+18165550100' }) }), actor, startInput);
    expect(withNumber).toMatchObject({ dial: { outboundCallerId: '+18165550100', identityType: null } });
  });
  it('cancels instead of dialing when the caller identity is not a JS-safe integer', async () => {
    const db = fakeDb({ prepareIntent: async () => prepared({ callerIdentityType: 'Office', callerIdentityId: '9007199254740993' }) });
    const result = await startDialpadCall(db, actor, startInput);
    expect(result).toMatchObject({ ok: false, code: 'unsupported_caller_identity' });
    expect(db.calls).toContain('cancelIntent');
    expect(db.calls).not.toContain('authorizeDispatch');
  });
  it('accepts a large identity id with allowLargeIdentityIds, keeping the exact text', async () => {
    const db = fakeDb({
      prepareIntent: async () => prepared({ callerIdentityType: 'Office', callerIdentityId: '9007199254740993' }),
      authorizeDispatch: async () => authorized({ identityType: 'Office', identityId: '9007199254740993' }),
    });
    const result = await startDialpadCall(db, actor, startInput, { allowLargeIdentityIds: true });
    expect(result).toMatchObject({ ok: true, dispatched: true, dial: { identityType: 'Office', identityId: null, identityIdText: '9007199254740993' } });
    expect(db.calls).not.toContain('cancelIntent');
  });
  it('carries the frozen dialpadUserId on the dial release', async () => {
    const result = await startDialpadCall(fakeDb({ authorizeDispatch: async () => authorized({ dialpadUserId: '7000000000000000001' }) }), actor, startInput);
    expect(result).toMatchObject({ dispatched: true, dial: { dialpadUserId: '7000000000000000001' } });
  });
  it.each([
    ['propertyId', { propertyId: 'nope' }],
    ['contactId', { contactId: null }],
    ['phoneSlot 4', { phoneSlot: 4 }],
    ['phoneSlot string', { phoneSlot: '1' }],
    ['idempotencyKey', { idempotencyKey: 'abc' }],
    ['grantId', { grantId: 'abc' }],
  ])('rejects invalid %s without touching the database', async (_label, override) => {
    const db = fakeDb();
    expect(await startDialpadCall(db, actor, { ...startInput, ...override })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(db.calls).toEqual([]);
  });
  it('requires an active connection, the allowed origin and a verified binding before preparing', async () => {
    const inactive = fakeDb({ loadConnection: async () => conn({ status: 'disabled', allowedOrigins: ['https://dialpad.com'], companyId: null, directoryKeyRef: null }) });
    expect(await startDialpadCall(inactive, actor, startInput)).toMatchObject({ ok: false, code: 'not_configured' });
    const badOrigin = fakeDb({ loadConnection: async () => conn({ status: 'active', allowedOrigins: ['https://example.com'], companyId: null, directoryKeyRef: null }) });
    expect(await startDialpadCall(badOrigin, actor, startInput)).toMatchObject({ ok: false, code: 'origin_not_allowed' });
    for (const binding of [null, { id: BINDING, status: 'pending' as const, dialpadUserId: '5551234' }]) {
      const db = fakeDb({ loadLiveBinding: async () => binding });
      expect(await startDialpadCall(db, actor, startInput)).toMatchObject({ ok: false, code: 'not_bound' });
      expect(db.calls).not.toContain('prepareIntent');
    }
  });
  it.each(['phone_dnc', 'not_assigned_rep', 'caller_grant_unavailable', 'contact_do_not_contact'] as const)('maps the %s denial from authorize to a message and no payload', async (denial) => {
    const result = await startDialpadCall(fakeDb({ authorizeDispatch: async () => ({ status: 'denied', intentId: INTENT, denial }) }), actor, startInput);
    expect(result).toEqual({ ok: false, code: 'denied', message: dialpadDenialMessage(denial), denial });
  });
  it.each(['cancelled', 'matched', 'expired'] as const)('never dials a %s intent', async (status) => {
    const result = await startDialpadCall(fakeDb({ authorizeDispatch: async () => ({ status, intentId: INTENT }) }), actor, startInput);
    expect(result).toMatchObject({ ok: false, code: status });
    expect(result).not.toHaveProperty('dial');
  });
  it('maps prepare denials and reports outages as not dialed', async () => {
    expect(await startDialpadCall(fakeDb({ prepareIntent: async () => { throw forbidden('phone_dnc'); } }), actor, startInput))
      .toMatchObject({ ok: false, code: 'denied', denial: 'phone_dnc' });
    expect(await startDialpadCall(fakeDb({ authorizeDispatch: async () => { throw new Error('socket hang up'); } }), actor, startInput))
      .toMatchObject({ ok: false, code: 'unavailable' });
    expect(await startDialpadCall(fakeDb({ prepareIntent: async () => { throw new DialpadDbError({ kind: 'idempotency_conflict' }, '40001'); } }), actor, startInput))
      .toMatchObject({ ok: false, code: 'invalid_input' });
  });
  it('rejects a malformed authorize response instead of dialing', async () => {
    expect(await startDialpadCall(fakeDb({ authorizeDispatch: async () => ({ status: 'authorized', intentId: INTENT, dial: { phoneNumber: '+1', customData: 'bad' } }) }), actor, startInput))
      .toMatchObject({ ok: false, code: 'unavailable' });
  });
});

describe('call targets, status and cancel', () => {
  it('lists masked phone slots and grants only for an assigned, callable lead', async () => {
    const grants = [{ id: GRANT, callerNumberE164: '+18165550100', identityType: null }];
    const result = await listDialpadCallTargets(fakeDb({ loadActiveGrants: async () => grants }), actor, { propertyId: PROPERTY, contactId: CONTACT });
    expect(result).toEqual({ ok: true, contactId: CONTACT, phones: [{ slot: 1, masked: '••• ••• 0196' }], grants });
    expect(JSON.stringify(result)).not.toContain('544');
    expect(await listDialpadCallTargets(fakeDb({ loadTargetPhones: async () => null }), actor, { propertyId: PROPERTY, contactId: CONTACT })).toMatchObject({ ok: false, code: 'denied' });
    expect(await listDialpadCallTargets(fakeDb(), actor, { propertyId: 'x', contactId: CONTACT })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(maskDialpadPhone('12')).toBe('••••');
  });
  it('derives status from the database, never from client input', async () => {
    const getCallStatus = vi.fn(async () => ({ intentId: INTENT, state: 'connected', connected: true, propertyId: PROPERTY, expiresAt: '2026-09-29T10:10:00Z', dispatchAuthorizedAt: '2026-09-29T10:00:01Z', callActivityId: 'a', attemptId: 'b', startedAt: '2026-09-29T10:00:05Z', endedAt: null, durationSeconds: null, talkDurationSeconds: null }));
    const result = await getDialpadCallStatus(fakeDb({ getCallStatus }), actor, INTENT);
    expect(result).toMatchObject({ ok: true, status: { state: 'connected', connected: true } });
    expect(getCallStatus).toHaveBeenCalledWith(ORG, REP, INTENT);
    expect(await getDialpadCallStatus(fakeDb(), actor, 'nope')).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await getDialpadCallStatus(fakeDb({ getCallStatus: async () => ({ intentId: INTENT, state: 'connected', propertyId: PROPERTY, expiresAt: 'x' }) }), actor, INTENT)).toMatchObject({ ok: false, code: 'unavailable' });
  });
  it('scopes cancel to the authenticated rep', async () => {
    const cancelIntent = vi.fn(async () => ({}));
    expect(await cancelDialpadCall(fakeDb({ cancelIntent }), actor, INTENT)).toEqual({ ok: true });
    expect(cancelIntent).toHaveBeenCalledWith(ORG, REP, INTENT);
    expect(await cancelDialpadCall(fakeDb({ cancelIntent: async () => { throw new DialpadDbError({ kind: 'not_found' }, 'P0002'); } }), actor, INTENT)).toMatchObject({ ok: false, code: 'invalid_input' });
  });
  it('rejects a status that omits the connected flag rather than guessing', async () => {
    const getCallStatus = vi.fn(async () => ({ intentId: INTENT, state: 'dialing', propertyId: PROPERTY, expiresAt: '2026-09-29T10:10:00Z', dispatchAuthorizedAt: null, callActivityId: null, attemptId: null, startedAt: null, endedAt: null, durationSeconds: null, talkDurationSeconds: null }) as never);
    expect(await getDialpadCallStatus(fakeDb({ getCallStatus }), actor, INTENT)).toMatchObject({ ok: false });
  });
});

describe('ensureDialpadBinding', () => {
  const identity = { email: 'Rep@Example.com', emailConfirmed: true };
  const env = { DIALPAD_CTI_DIRECTORY_KEY_A: API_KEY };
  const record = (over: Record<string, string> = {}) => `{"id":${over.id ?? '5551234'},"company_id":${over.company ?? '42'},"state":${over.state ?? '"active"'},"emails":["rep@example.com"]}`;
  // The email lookup returns the list; verifyDialpadBinding then re-reads the single user by id.
  const spyFetch = (status: number, body: string) => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      if (/\/users\/\d+$/.test(url)) {
        const first = (JSON.parse(body.replace(/("(?:id|company_id)":)(\d+)/g, '$1"$2"')) as unknown);
        const list = Array.isArray(first) ? first : (first as { items?: unknown[] }).items ?? [];
        const raw = body.match(/\{[^{}]*\}/)?.[0] ?? '{}';
        return { status: list.length ? 200 : 404, text: async () => raw };
      }
      return { status, text: async () => body };
    };
    return { calls, fetchImpl };
  };

  it('returns an already verified binding without any directory call', async () => {
    const http = spyFetch(200, '[]');
    const result = await ensureDialpadBinding(fakeDb(), actor, identity, { env, fetchImpl: http.fetchImpl });
    expect(result).toEqual({ ok: true, dialpadUserId: '5551234', status: 'verified', created: false });
    expect(http.calls).toEqual([]);
  });
  it('looks the email up, claims and verifies', async () => {
    const db = fakeDb({ loadLiveBinding: async () => null });
    const claim = vi.spyOn(db, 'claimBinding');
    const verify = vi.spyOn(db, 'verifyBinding');
    const http = spyFetch(200, `{"items":[${record()}]}`);
    const result = await ensureDialpadBinding(db, actor, identity, { env, fetchImpl: http.fetchImpl });
    expect(result).toEqual({ ok: true, dialpadUserId: '5551234', status: 'verified', created: true });
    expect(http.calls[0]).toContain('/api/v2/users?email=rep%40example.com');
    expect(claim).toHaveBeenCalledWith(ORG, REP, '5551234');
    expect(verify).toHaveBeenCalledWith(BINDING, 'provider_directory', 'dialpad-directory:42:5551234');
  });
  it('refuses an unconfirmed or missing email with no HTTP', async () => {
    for (const bad of [{ email: 'rep@example.com', emailConfirmed: false }, { email: null, emailConfirmed: true }]) {
      const http = spyFetch(200, '[]');
      const result = await ensureDialpadBinding(fakeDb({ loadLiveBinding: async () => null }), actor, bad, { env, fetchImpl: http.fetchImpl });
      expect(result).toMatchObject({ ok: false, code: 'identity_mismatch', reason: 'email_unverified' });
      expect(http.calls).toEqual([]);
    }
  });
  it('maps a directory miss to user_not_found and two users to ambiguous', async () => {
    const db = () => fakeDb({ loadLiveBinding: async () => null });
    expect(await ensureDialpadBinding(db(), actor, identity, { env, fetchImpl: spyFetch(404, '').fetchImpl })).toMatchObject({ ok: false, code: 'identity_mismatch', reason: 'user_not_found' });
    const claimDb = db();
    const two = `[${record()},${record({ id: '5551235' })}]`;
    expect(await ensureDialpadBinding(claimDb, actor, identity, { env, fetchImpl: spyFetch(200, two).fetchImpl })).toMatchObject({ ok: false, code: 'identity_mismatch', reason: 'ambiguous' });
    expect(claimDb.calls).not.toContain('claimBinding');
  });
  it('passes company mismatch and inactive reasons through from verifyDialpadBinding', async () => {
    const wrongCompany = fakeDb({ loadLiveBinding: async () => null });
    expect(await ensureDialpadBinding(wrongCompany, actor, identity, { env, fetchImpl: spyFetch(200, `[${record({ company: '43' })}]`).fetchImpl })).toMatchObject({ ok: false, code: 'identity_mismatch', reason: 'company_mismatch' });
    expect(wrongCompany.calls).not.toContain('claimBinding');
    const inactive = fakeDb({ loadLiveBinding: async () => null });
    expect(await ensureDialpadBinding(inactive, actor, identity, { env, fetchImpl: spyFetch(200, `[${record({ state: '"suspended"' })}]`).fetchImpl })).toMatchObject({ ok: false, code: 'identity_mismatch', reason: 'inactive' });
    expect(inactive.calls).not.toContain('verifyBinding');
  });
  it('reports a directory outage as unavailable', async () => {
    expect(await ensureDialpadBinding(fakeDb({ loadLiveBinding: async () => null }), actor, identity, { env, fetchImpl: spyFetch(503, '').fetchImpl })).toMatchObject({ ok: false, code: 'unavailable' });
    expect(await ensureDialpadBinding(fakeDb({ loadLiveBinding: async () => null }), actor, identity, { env, fetchImpl: spyFetch(401, '').fetchImpl })).toMatchObject({ ok: false, code: 'unavailable' });
  });
  it('needs an active connection and a configured directory key', async () => {
    const http = spyFetch(200, '[]');
    expect(await ensureDialpadBinding(fakeDb({ loadConnection: async () => conn({ status: 'disabled' }) }), actor, identity, { env, fetchImpl: http.fetchImpl })).toMatchObject({ ok: false, code: 'not_configured' });
    expect(await ensureDialpadBinding(fakeDb({ loadConnection: async () => null }), actor, identity, { env, fetchImpl: http.fetchImpl })).toMatchObject({ ok: false, code: 'not_configured' });
    expect(await ensureDialpadBinding(fakeDb({ loadLiveBinding: async () => null }), actor, identity, { env: {}, fetchImpl: http.fetchImpl })).toMatchObject({ ok: false, code: 'not_configured' });
    expect(http.calls).toEqual([]);
  });
});
