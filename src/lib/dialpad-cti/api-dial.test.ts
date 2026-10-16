import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/errors/report', () => ({ reportError: vi.fn() }));

import { reportError } from '@/lib/errors/report';
import type { Json } from '@/lib/supabase/types';

import {
  buildDialpadDialBody,
  createDialpadHttpDialer,
  createStubDialpadDialer,
  dialpadDialUrl,
  readStubDialpadDials,
  resetStubDialpadDials,
  resolveDialpadDialKey,
  resolveDialpadHoursClock,
  resolveDialpadDialProvider,
  startDialpadApiCall,
  type DialpadDialFetch,
  type DialpadDialRequest,
  type DialpadDialResult,
  type DialpadDialer,
} from './api-dial';
import { classifyDialpadRpcError } from './contracts';
import {
  dialpadDenialMessage,
  type DialpadActor,
  type DialpadCallSlot,
  type DialpadConnectionView,
  type DialpadDispatchDb,
} from './dispatch';
import { DialpadDbError } from './event-processing';

const ORG = '11111111-1111-4111-8111-111111111111';
const REP = '22222222-2222-4222-8222-222222222222';
const PROPERTY = '33333333-3333-4333-8333-333333333333';
const CONTACT = '44444444-4444-4444-8444-444444444444';
const KEY = '55555555-5555-4555-8555-555555555555';
const KEY2 = '55555555-5555-4555-8555-555555555556';
const INTENT = '66666666-6666-4666-8666-666666666666';
const INTENT2 = '66666666-6666-4666-8666-666666666667';
const BINDING = '77777777-7777-4777-8777-777777777777';
const GRANT = '88888888-8888-4888-8888-888888888888';
const GRANT2 = '88888888-8888-4888-8888-888888888889';
const TOKEN = `sandra.dialpad.v1.${'b'.repeat(48)}`;
const API_KEY = 'k'.repeat(24);
const actor: DialpadActor = { orgId: ORG, userId: REP };
const env = { DIALPAD_CTI_DIRECTORY_KEY_A: API_KEY, DIALPAD_CTI_DIAL_KEY_X: 'd'.repeat(24) };
const input = { propertyId: PROPERTY, contactId: CONTACT, phoneSlot: null as unknown, idempotencyKey: KEY as unknown, confirmRedialOf: undefined as unknown };

const conn = (over: Partial<DialpadConnectionView> = {}): DialpadConnectionView => ({
  id: 'c', status: 'active', allowedOrigins: ['https://dialpad.com'], companyId: '42', directoryKeyRef: 'env:DIALPAD_CTI_DIRECTORY_KEY_A', dialEndpoint: 'initiate_call', dialKeyRef: null, ...over,
});
const prepared = (over: Record<string, Json> = {}): Json => ({
  intentId: INTENT, customData: TOKEN, status: 'prepared', preparedAt: '2026-09-29T10:00:00Z', expiresAt: '2026-09-29T10:10:00Z',
  destinationE164: '+18165440196', phoneSlot: 1, callerNumberE164: null, callerIdentityType: null, callerIdentityId: null,
  dialpadUserId: '5551234', propertyId: PROPERTY, contactId: CONTACT, assignmentEpisodeId: '99999999-9999-4999-8999-999999999999', replayed: false, ...over,
});
const authorized = (dial: Record<string, Json> = {}, intentId = INTENT): Json => ({
  status: 'authorized', intentId, expiresAt: '2026-09-29T10:10:00Z', dispatchAuthorizedAt: '2026-09-29T10:00:01Z',
  dial: { dialpadUserId: '5551234', phoneNumber: '+18165440196', customData: TOKEN, identityType: null, identityId: null, outboundCallerId: null, ...dial },
});
const slotsOk: DialpadCallSlot[] = [{ slot: 1, callable: true, reason: null }];

function fakeDb(over: Partial<DialpadDispatchDb> = {}): DialpadDispatchDb & { calls: string[] } {
  const calls: string[] = [];
  const track = <T extends unknown[], R>(name: string, fn: (...args: T) => Promise<R>) => (...args: T) => { calls.push(name); return fn(...args); };
  const db: DialpadDispatchDb = {
    loadConnection: track('loadConnection', async () => conn()),
    loadLiveBinding: track('loadLiveBinding', async () => ({ id: BINDING, status: 'verified' as const, dialpadUserId: '5551234' })),
    loadActiveGrants: track('loadActiveGrants', async () => []),
    loadTargetPhones: track('loadTargetPhones', async () => null),
    loadDispatchLoad: track('loadDispatchLoad', async () => ({ authorizedLastMinute: 0, unmatchedLast20s: 0 })),
    loadUnresolvedIntent: track('loadUnresolvedIntent', async () => null),
    loadCallSlots: track('loadCallSlots', async () => slotsOk),
    loadPropertyState: track('loadPropertyState', async () => ({ found: true, state: 'MO' })),
    claimBinding: track('claimBinding', async () => ({})),
    verifyBinding: track('verifyBinding', async () => ({})),
    prepareIntent: track('prepareIntent', async () => prepared()),
    authorizeDispatch: track('authorizeDispatch', async () => authorized()),
    cancelIntent: track('cancelIntent', async () => ({ intentId: INTENT, status: 'cancelled', replayed: false })),
    getCallStatus: track('getCallStatus', async () => ({})),
    ...over,
  };
  return Object.assign(db, { calls });
}

function fakeDialer(result: DialpadDialResult | (() => DialpadDialResult) = { kind: 'accepted', status: 200, providerCallId: '1' }) {
  const requests: DialpadDialRequest[] = [];
  const dialer: DialpadDialer = {
    async dial(request) {
      requests.push(request);
      return typeof result === 'function' ? result() : result;
    },
  };
  return { dialer, requests };
}

// 17:00Z = 12:00 CDT: inside the 08:00-21:00 lead-local window for the default MO property.
const IN_WINDOW = new Date('2026-09-29T17:00:00Z');
const run = (db: DialpadDispatchDb, dialer: DialpadDialer, over: Partial<typeof input> = {}, at: Date = IN_WINDOW) =>
  startDialpadApiCall(db, dialer, actor, { ...input, ...over }, { env, now: () => at });

const baseRequest = (over: Partial<DialpadDialRequest> = {}): DialpadDialRequest => ({
  endpoint: 'initiate_call', apiKey: API_KEY, dialpadUserId: '5551234', phoneNumber: '+18165440196', customData: TOKEN, identity: null, outboundCallerId: null, ...over,
});

beforeEach(() => {
  vi.mocked(reportError).mockClear();
  resetStubDialpadDials();
});

describe('dialpadDialUrl and buildDialpadDialBody', () => {
  it('builds the initiate_call URL and body', () => {
    expect(dialpadDialUrl(baseRequest())).toBe('https://dialpad.com/api/v2/users/5551234/initiate_call');
    const body = buildDialpadDialBody(baseRequest({ outboundCallerId: '+18165550100' }));
    expect(Object.keys(JSON.parse(body))).toEqual(['phone_number', 'custom_data', 'outbound_caller_id']);
    expect(JSON.parse(body)).toEqual({ phone_number: '+18165440196', custom_data: TOKEN, outbound_caller_id: '+18165550100' });
  });
  it('omits outbound_caller_id when there is none', () => {
    expect(Object.keys(JSON.parse(buildDialpadDialBody(baseRequest())))).toEqual(['phone_number', 'custom_data']);
  });
  it('renders a group identity as an exact int64 integer with the mapped group_type and no outbound_caller_id', () => {
    const body = buildDialpadDialBody(baseRequest({ identity: { type: 'Office', id: '9007199254740993' } }));
    expect(body).toContain('"group_id":9007199254740993,');
    expect(body).toContain('"group_type":"office"');
    expect(body).not.toContain('outbound_caller_id');
    expect(buildDialpadDialBody(baseRequest({ identity: { type: 'OfficeGroup', id: '5' } }))).toContain('"group_type":"department"');
    expect(buildDialpadDialBody(baseRequest({ identity: { type: 'CallCenter', id: '5' } }))).toContain('"group_type":"callcenter"');
  });
  it('uses the /call endpoint with user_id first', () => {
    const request = baseRequest({ endpoint: 'call', dialpadUserId: '7000000000000000001' });
    expect(dialpadDialUrl(request)).toBe('https://dialpad.com/api/v2/call');
    expect(buildDialpadDialBody(request).startsWith('{"user_id":7000000000000000001,')).toBe(true);
  });
  it('throws on a caller identity together with an outbound caller id', () => {
    expect(() => buildDialpadDialBody(baseRequest({ identity: { type: 'Office', id: '5' }, outboundCallerId: '+18165550100' }))).toThrow();
  });
  it('throws on a bad phone, custom_data, ids or user id', () => {
    expect(() => buildDialpadDialBody(baseRequest({ phoneNumber: '8165440196' }))).toThrow();
    expect(() => buildDialpadDialBody(baseRequest({ customData: 'nope' }))).toThrow();
    expect(() => buildDialpadDialBody(baseRequest({ outboundCallerId: '123' }))).toThrow();
    expect(() => buildDialpadDialBody(baseRequest({ identity: { type: 'Office', id: '5,"x":1' } }))).toThrow();
    expect(() => dialpadDialUrl(baseRequest({ dialpadUserId: '../1' }))).toThrow();
    expect(() => buildDialpadDialBody(baseRequest({ endpoint: 'call', dialpadUserId: 'x' }))).toThrow();
  });
});

describe('createDialpadHttpDialer', () => {
  function fetchReturning(status: number, body = '', headers: Record<string, string> = {}) {
    const seen: { url: string; init: Parameters<DialpadDialFetch>[1] }[] = [];
    const fetchImpl: DialpadDialFetch = async (url, init) => {
      seen.push({ url, init });
      return { status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, text: async () => body };
    };
    return { seen, fetchImpl };
  }
  const dial = (f: ReturnType<typeof fetchReturning>) => createDialpadHttpDialer(f.fetchImpl).dial(baseRequest());

  it('accepts a 200 and parses the provider call id without rounding', async () => {
    const f = fetchReturning(200, '{"call_id":7000000000000000001}');
    expect(await dial(f)).toEqual({ kind: 'accepted', status: 200, providerCallId: '7000000000000000001' });
  });
  it('accepts with a null call id when the body has none', async () => {
    expect(await dial(fetchReturning(200, '{}'))).toEqual({ kind: 'accepted', status: 200, providerCallId: null });
  });
  it('maps 429 to rate_limited using Retry-After, defaulting to 60', async () => {
    expect(await dial(fetchReturning(429, '', { 'retry-after': '30' }))).toEqual({ kind: 'rejected', status: 429, reason: 'rate_limited', retryAfterSeconds: 30 });
    expect(await dial(fetchReturning(429))).toMatchObject({ kind: 'rejected', reason: 'rate_limited', retryAfterSeconds: 60 });
  });
  it.each([[401, 'unauthorized'], [403, 'forbidden'], [404, 'not_found'], [400, 'invalid']])('maps %i to %s', async (status, reason) => {
    expect(await dial(fetchReturning(status))).toEqual({ kind: 'rejected', status, reason, retryAfterSeconds: null });
  });
  it('treats 5xx and a thrown fetch as unknown', async () => {
    expect(await dial(fetchReturning(503))).toEqual({ kind: 'unknown' });
    expect(await createDialpadHttpDialer(async () => { throw new Error('timeout'); }).dial(baseRequest())).toEqual({ kind: 'unknown' });
  });
  it('sends POST with Bearer, JSON content type, redirect error, no-store and the exact body', async () => {
    const f = fetchReturning(200, '{}');
    await dial(f);
    const { url, init } = f.seen[0]!;
    expect(url).toBe('https://dialpad.com/api/v2/users/5551234/initiate_call');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.redirect).toBe('error');
    expect(init.cache).toBe('no-store');
    expect(init.body).toBe(buildDialpadDialBody(baseRequest()));
  });
});

describe('resolveDialpadDialProvider and the stub dialer', () => {
  it('honours the stub in preview or unset environments and ignores it in production', () => {
    expect(resolveDialpadDialProvider({ DIALPAD_DIAL_PROVIDER: 'stub', VERCEL_ENV: 'preview' })).toBe('stub');
    expect(resolveDialpadDialProvider({ DIALPAD_DIAL_PROVIDER: ' STUB ' })).toBe('stub');
    expect(resolveDialpadDialProvider({ DIALPAD_DIAL_PROVIDER: 'stub', VERCEL_ENV: 'production' })).toBe('live');
    expect(resolveDialpadDialProvider({})).toBe('live');
    expect(resolveDialpadDialProvider({ DIALPAD_DIAL_PROVIDER: 'live' })).toBe('live');
  });
  it('records the request and accepts without any fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const dialer = createStubDialpadDialer(() => new Date('2026-09-29T10:00:00Z'));
    const result = await dialer.dial(baseRequest({ outboundCallerId: '+18165550100' }));
    expect(result).toEqual({ kind: 'accepted', status: 200, providerCallId: null });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(readStubDialpadDials()).toEqual([{
      at: '2026-09-29T10:00:00.000Z', endpoint: 'initiate_call', dialpadUserId: '5551234', phoneNumber: '+18165440196', customData: TOKEN,
      outboundCallerId: '+18165550100', identity: null,
    }]);
    resetStubDialpadDials();
    expect(readStubDialpadDials()).toEqual([]);
  });
  it('still throws on an invalid body and records nothing', async () => {
    await expect(createStubDialpadDialer().dial(baseRequest({ phoneNumber: 'bad' }))).rejects.toThrow();
    expect(readStubDialpadDials()).toEqual([]);
  });
});

describe('resolveDialpadDialKey', () => {
  it('resolves a dialKeyRef in the DIAL namespace from env', () => {
    expect(resolveDialpadDialKey({ dialKeyRef: 'env:DIALPAD_CTI_DIAL_KEY_X', directoryKeyRef: null }, env)).toBe(env.DIALPAD_CTI_DIAL_KEY_X);
  });
  it('never falls back when the dialKeyRef is outside the namespace or unset in env', () => {
    expect(resolveDialpadDialKey({ dialKeyRef: 'env:DIALPAD_CTI_DIRECTORY_KEY_A', directoryKeyRef: 'env:DIALPAD_CTI_DIRECTORY_KEY_A' }, env)).toBeNull();
    expect(resolveDialpadDialKey({ dialKeyRef: 'env:SUPABASE_SERVICE_ROLE_KEY', directoryKeyRef: 'env:DIALPAD_CTI_DIRECTORY_KEY_A' }, { ...env, SUPABASE_SERVICE_ROLE_KEY: 'z'.repeat(30) })).toBeNull();
    expect(resolveDialpadDialKey({ dialKeyRef: 'env:DIALPAD_CTI_DIAL_KEY_MISSING', directoryKeyRef: 'env:DIALPAD_CTI_DIRECTORY_KEY_A' }, env)).toBeNull();
  });
  it('falls back to the directory key when there is no dialKeyRef', () => {
    expect(resolveDialpadDialKey({ dialKeyRef: null, directoryKeyRef: 'env:DIALPAD_CTI_DIRECTORY_KEY_A' }, env)).toBe(API_KEY);
    expect(resolveDialpadDialKey({ dialKeyRef: null, directoryKeyRef: null }, env)).toBeNull();
  });
});

describe('startDialpadApiCall', () => {
  it('dials and reports awaiting_provider with the chosen slot', async () => {
    const db = fakeDb();
    const { dialer, requests } = fakeDialer();
    expect(await run(db, dialer)).toEqual({ ok: true, intentId: INTENT, state: 'awaiting_provider', uncertain: false, phoneSlot: 1 });
    expect(requests).toEqual([{
      endpoint: 'initiate_call', apiKey: API_KEY, dialpadUserId: '5551234', phoneNumber: '+18165440196', customData: TOKEN, identity: null, outboundCallerId: null,
    }]);
    expect(db.calls).not.toContain('cancelIntent');
  });
  it('uses the dial key and endpoint from the connection', async () => {
    const { dialer, requests } = fakeDialer();
    await run(fakeDb({ loadConnection: async () => conn({ dialKeyRef: 'env:DIALPAD_CTI_DIAL_KEY_X', dialEndpoint: 'call' }) }), dialer);
    expect(requests[0]).toMatchObject({ endpoint: 'call', apiKey: env.DIALPAD_CTI_DIAL_KEY_X });
  });
  it('passes the first grant to prepare and uses its caller id on dial', async () => {
    const prepareIntent = vi.fn(async () => prepared({ callerNumberE164: '+18165550100' }));
    const db = fakeDb({
      loadActiveGrants: async () => [{ id: GRANT, callerNumberE164: '+18165550100', identityType: null }, { id: GRANT2, callerNumberE164: '+18165550101', identityType: null }],
      prepareIntent,
      authorizeDispatch: async () => authorized({ outboundCallerId: '+18165550100' }),
    });
    const { dialer, requests } = fakeDialer();
    await run(db, dialer);
    expect(prepareIntent).toHaveBeenCalledWith(expect.objectContaining({ grantId: GRANT, phoneSlot: 1, idempotencyKey: KEY, orgId: ORG, userId: REP }));
    expect(requests[0]!.outboundCallerId).toBe('+18165550100');
  });
  it('sends the group identity as text and drops the caller id', async () => {
    const db = fakeDb({
      loadActiveGrants: async () => [{ id: GRANT, callerNumberE164: '+18165550100', identityType: 'Office' }],
      prepareIntent: async () => prepared({ callerIdentityType: 'Office', callerIdentityId: '9007199254740993' }),
      authorizeDispatch: async () => authorized({ identityType: 'Office', identityId: '9007199254740993', outboundCallerId: '+18165550100' }),
    });
    const { dialer, requests } = fakeDialer();
    expect(await run(db, dialer)).toMatchObject({ ok: true, uncertain: false });
    expect(requests[0]).toMatchObject({ identity: { type: 'Office', id: '9007199254740993' }, outboundCallerId: null });
  });
  it('uses no grant and no caller id when the rep has none', async () => {
    const prepareIntent = vi.fn(async () => prepared());
    const { dialer, requests } = fakeDialer();
    await run(fakeDb({ prepareIntent }), dialer);
    expect(prepareIntent).toHaveBeenCalledWith(expect.objectContaining({ grantId: null }));
    expect(requests[0]!.outboundCallerId).toBeNull();
  });
  it('honours an explicit callable phone slot', async () => {
    const prepareIntent = vi.fn(async () => prepared({ phoneSlot: 2 }));
    const db = fakeDb({ prepareIntent, loadCallSlots: async () => [{ slot: 1, callable: false, reason: 'phone_dnc' }, { slot: 2, callable: true, reason: null }] });
    expect(await run(db, fakeDialer().dialer, { phoneSlot: 2 })).toMatchObject({ ok: true, phoneSlot: 2 });
    expect(prepareIntent).toHaveBeenCalledWith(expect.objectContaining({ phoneSlot: 2 }));
  });

  it('never dials again on the same key (already_dispatched)', async () => {
    const db = fakeDb({ authorizeDispatch: async () => ({ status: 'already_dispatched', intentId: INTENT, expiresAt: '2026-09-29T10:10:00Z', dispatchAuthorizedAt: '2026-09-29T10:00:01Z' }) });
    const { dialer, requests } = fakeDialer();
    expect(await run(db, dialer)).toEqual({ ok: true, intentId: INTENT, state: 'already_dispatched' });
    expect(requests).toHaveLength(0);
    expect(db.calls).not.toContain('cancelIntent');
  });

  it('denies with the mapped denial and no prepare or HTTP when no slot is callable', async () => {
    const db = fakeDb({ loadCallSlots: async () => [{ slot: 1, callable: false, reason: 'phone_dnc' }, { slot: 2, callable: false, reason: 'property_dnc' }] });
    const { dialer, requests } = fakeDialer();
    const result = await run(db, dialer);
    expect(result).toEqual({ ok: false, code: 'denied', message: dialpadDenialMessage('phone_dnc'), denial: 'phone_dnc', freshAttemptKey: true });
    expect(db.calls).not.toContain('prepareIntent');
    expect(requests).toHaveLength(0);
  });
  it.each([
    ['property_dnc', 'property_dnc_locked'], ['contact_dnc', 'contact_do_not_contact'], ['phone_dnc', 'phone_dnc'], ['invalid', 'phone_unavailable'],
  ] as const)('maps slot reason %s to denial %s', async (reason, denial) => {
    const result = await run(fakeDb({ loadCallSlots: async () => [{ slot: 1, callable: false, reason }] }), fakeDialer().dialer);
    expect(result).toMatchObject({ ok: false, code: 'denied', denial });
  });
  it('denies an explicit phone slot that is not callable, even when another slot is', async () => {
    const db = fakeDb({ loadCallSlots: async () => [{ slot: 1, callable: true, reason: null }, { slot: 2, callable: false, reason: 'phone_dnc' }] });
    const { dialer, requests } = fakeDialer();
    expect(await run(db, dialer, { phoneSlot: 2 })).toMatchObject({ ok: false, code: 'denied', denial: 'phone_dnc' });
    expect(db.calls).not.toContain('prepareIntent');
    expect(requests).toHaveLength(0);
  });
  it('denies a slot the contact does not have', async () => {
    const db = fakeDb();
    expect(await run(db, fakeDialer().dialer, { phoneSlot: 3 })).toMatchObject({ ok: false, code: 'denied', denial: 'phone_unavailable' });
  });
  it('does not dial when DNC is added between prepare and authorize', async () => {
    const db = fakeDb({ authorizeDispatch: async () => ({ status: 'denied', intentId: INTENT, denial: 'phone_dnc' }) });
    const { dialer, requests } = fakeDialer();
    expect(await run(db, dialer)).toMatchObject({ ok: false, code: 'denied', denial: 'phone_dnc' });
    expect(requests).toHaveLength(0);
  });

  it('cancels and offers a fresh key after a provider 429', async () => {
    const db = fakeDb();
    const { dialer } = fakeDialer({ kind: 'rejected', status: 429, reason: 'rate_limited', retryAfterSeconds: 30 });
    const result = await run(db, dialer);
    expect(result).toMatchObject({ ok: false, code: 'rate_limited', retryAfterSeconds: 30, freshAttemptKey: true });
    expect(db.calls).toContain('cancelIntent');
  });

  it('completes the 429 then new-key retry sequence with one accepted dial', async () => {
    const cancelled = new Set<string>();
    const intentByKey: Record<string, string> = { [KEY]: INTENT, [KEY2]: INTENT2 };
    const prepareIntent = vi.fn(async (args: { idempotencyKey: string }) => prepared({ intentId: intentByKey[args.idempotencyKey]! }));
    const cancelIntent = vi.fn(async (_o: string, _u: string, id: string) => { cancelled.add(id); return {}; });
    const authorizeDispatch = vi.fn(async (_o: string, _u: string, id: string) => (cancelled.has(id) ? { status: 'cancelled', intentId: id } : authorized({}, id)));
    const db = fakeDb({ prepareIntent, cancelIntent, authorizeDispatch });
    const results: DialpadDialResult[] = [
      { kind: 'rejected', status: 429, reason: 'rate_limited', retryAfterSeconds: 60 },
      { kind: 'accepted', status: 200, providerCallId: '1' },
    ];
    const { dialer, requests } = fakeDialer(() => results.shift()!);
    expect(await run(db, dialer)).toMatchObject({ ok: false, code: 'rate_limited', freshAttemptKey: true });
    expect(cancelIntent).toHaveBeenCalledWith(ORG, REP, INTENT);
    expect(await run(db, dialer, { idempotencyKey: KEY2 })).toEqual({ ok: true, intentId: INTENT2, state: 'awaiting_provider', uncertain: false, phoneSlot: 1 });
    expect(prepareIntent).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(2);
    expect(results).toHaveLength(0);
  });
  it('a same-key retry after the 429 is cancelled and never reaches the provider', async () => {
    const db = fakeDb({ authorizeDispatch: async () => ({ status: 'cancelled', intentId: INTENT }) });
    const { dialer, requests } = fakeDialer();
    expect(await run(db, dialer)).toMatchObject({ ok: false, code: 'cancelled' });
    expect(requests).toHaveLength(0);
  });

  it('keeps the intent on an unknown outcome and reports uncertain', async () => {
    const db = fakeDb();
    const { dialer } = fakeDialer({ kind: 'unknown' });
    expect(await run(db, dialer)).toEqual({ ok: true, intentId: INTENT, state: 'awaiting_provider', uncertain: true, phoneSlot: 1 });
    expect(db.calls).not.toContain('cancelIntent');
  });
  it('a retry with the same key after unknown is already_dispatched with no HTTP', async () => {
    let released = false;
    const db = fakeDb({
      authorizeDispatch: async () => {
        if (released) return { status: 'already_dispatched', intentId: INTENT, expiresAt: '2026-09-29T10:10:00Z', dispatchAuthorizedAt: '2026-09-29T10:00:01Z' };
        released = true;
        return authorized();
      },
    });
    const { dialer, requests } = fakeDialer({ kind: 'unknown' });
    await run(db, dialer);
    expect(await run(db, dialer)).toEqual({ ok: true, intentId: INTENT, state: 'already_dispatched' });
    expect(requests).toHaveLength(1);
  });

  it.each([400, 401, 403] as const)('cancels and reports provider_rejected on %i without leaking the key or body', async (status) => {
    const db = fakeDb();
    const reason = status === 400 ? 'invalid' : status === 401 ? 'unauthorized' : 'forbidden';
    const { dialer } = fakeDialer({ kind: 'rejected', status, reason, retryAfterSeconds: null });
    const result = await run(db, dialer);
    expect(result).toMatchObject({ ok: false, code: 'provider_rejected', freshAttemptKey: true });
    expect(db.calls).toContain('cancelIntent');
    expect(reportError).toHaveBeenCalledTimes(1);
    const [, options] = vi.mocked(reportError).mock.calls[0]!;
    expect(options).toMatchObject({ tags: { surface: 'dialpad_api_dial', reason, status: String(status) } });
    const payload = JSON.stringify(vi.mocked(reportError).mock.calls[0]![1]) + String((vi.mocked(reportError).mock.calls[0]![0] as Error).message);
    expect(payload).not.toContain(API_KEY);
    expect(payload).not.toContain(TOKEN);
    expect(payload).not.toContain('+18165440196');
  });

  it('counts the call as placed when the webhook matched before the rejection returned', async () => {
    const matched = new DialpadDbError(classifyDialpadRpcError({ code: '42501', details: 'intent_already_matched' }), '42501');
    const db = fakeDb({ cancelIntent: async () => { throw matched; } });
    const { dialer } = fakeDialer({ kind: 'rejected', status: 400, reason: 'invalid', retryAfterSeconds: null });
    expect(await run(db, dialer)).toEqual({ ok: true, intentId: INTENT, state: 'awaiting_provider', uncertain: false, phoneSlot: 1 });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('rate-limits before preparing when four dials were authorized in the last minute', async () => {
    const db = fakeDb({ loadDispatchLoad: async () => ({ authorizedLastMinute: 4, unmatchedLast20s: 0 }) });
    const { dialer, requests } = fakeDialer();
    expect(await run(db, dialer)).toMatchObject({ ok: false, code: 'rate_limited', freshAttemptKey: true, retryAfterSeconds: 60 });
    expect(db.calls).not.toContain('prepareIntent');
    expect(requests).toHaveLength(0);
  });
  it('asks the load query for the last 60 seconds', async () => {
    const loadDispatchLoad = vi.fn(async () => ({ authorizedLastMinute: 0, unmatchedLast20s: 0 }));
    await run(fakeDb({ loadDispatchLoad }), fakeDialer().dialer);
    expect(loadDispatchLoad).toHaveBeenCalledWith(ORG, REP, '2026-09-29T16:59:00.000Z');
  });
  it('refuses with call_in_flight when a dial is still unmatched', async () => {
    const db = fakeDb({ loadDispatchLoad: async () => ({ authorizedLastMinute: 1, unmatchedLast20s: 1 }) });
    const result = await run(db, fakeDialer().dialer);
    expect(result).toMatchObject({ ok: false, code: 'call_in_flight' });
    expect(result).not.toHaveProperty('freshAttemptKey');
    expect(db.calls).not.toContain('prepareIntent');
  });

  it.each([
    ['a dialKeyRef outside the namespace', conn({ dialKeyRef: 'env:SUPABASE_SERVICE_ROLE_KEY' })],
    ['a missing env value', conn({ dialKeyRef: 'env:DIALPAD_CTI_DIAL_KEY_NOPE' })],
    ['no directory key', conn({ directoryKeyRef: null })],
  ])('cancels and reports not_configured with %s', async (_label, connection) => {
    const db = fakeDb({ loadConnection: async () => connection });
    const { dialer, requests } = fakeDialer();
    expect(await run(db, dialer)).toMatchObject({ ok: false, code: 'not_configured' });
    expect(db.calls).toContain('cancelIntent');
    expect(requests).toHaveLength(0);
  });

  it('refuses an unbound rep before preparing', async () => {
    const db = fakeDb({ loadLiveBinding: async () => ({ id: BINDING, status: 'pending' as const, dialpadUserId: '5551234' }) });
    expect(await run(db, fakeDialer().dialer)).toMatchObject({ ok: false, code: 'not_bound' });
    expect(db.calls).not.toContain('prepareIntent');
  });
  it('refuses a connection without the Dialpad origin or one that is not active', async () => {
    const origin = fakeDb({ loadConnection: async () => conn({ allowedOrigins: ['https://example.com'] }) });
    expect(await run(origin, fakeDialer().dialer)).toMatchObject({ ok: false, code: 'origin_not_allowed' });
    expect(origin.calls).not.toContain('prepareIntent');
    expect(await run(fakeDb({ loadConnection: async () => conn({ status: 'disabled' }) }), fakeDialer().dialer)).toMatchObject({ ok: false, code: 'not_configured' });
  });

  it('rejects invalid input without touching the database', async () => {
    for (const bad of [{ propertyId: 'nope' }, { contactId: null }, { idempotencyKey: 'abc' }, { phoneSlot: 4 }, { phoneSlot: '1' }]) {
      const db = fakeDb();
      expect(await run(db, fakeDialer().dialer, bad as never)).toMatchObject({ ok: false, code: 'invalid_input' });
      expect(db.calls).toEqual([]);
    }
  });

  it('reports dialpad_unavailable and logs when the database throws', async () => {
    const db = fakeDb({ loadDispatchLoad: async () => { throw new Error('socket hang up'); } });
    const { dialer, requests } = fakeDialer();
    expect(await run(db, dialer)).toMatchObject({ ok: false, code: 'dialpad_unavailable' });
    expect(requests).toHaveLength(0);
    expect(reportError).toHaveBeenCalled();
    expect(vi.mocked(reportError).mock.calls[0]![1]).toMatchObject({ tags: { surface: 'dialpad_api_dial' } });
  });
});

describe('#809 acceptance matrix: server rows', () => {
  const unresolved = (over: Partial<{ intentId: string; idempotencyKey: string }> = {}) => async () => ({ intentId: INTENT2, idempotencyKey: KEY2, ...over });

  it('row 10: provider_rejected carries freshAttemptKey (proven non-dispatch)', async () => {
    const db = fakeDb();
    const { dialer } = fakeDialer({ kind: 'rejected', status: 400, reason: 'invalid', retryAfterSeconds: null });
    const result = await run(db, dialer);
    expect(result).toMatchObject({ ok: false, code: 'provider_rejected', freshAttemptKey: true });
    expect(db.calls).toContain('cancelIntent');
  });

  it('row 10: a missing dial key and an authorize denial also release the key', async () => {
    const noKey = fakeDb({ loadConnection: async () => conn({ directoryKeyRef: 'env:MISSING' }) });
    expect(await run(noKey, fakeDialer().dialer)).toMatchObject({ ok: false, code: 'not_configured', freshAttemptKey: true });
    const denied = fakeDb({ authorizeDispatch: async () => ({ status: 'denied', intentId: INTENT, denial: 'phone_dnc' }) });
    expect(await run(denied, fakeDialer().dialer)).toMatchObject({ ok: false, code: 'denied', freshAttemptKey: true });
  });

  it('row 12: refuses a new key while a prior authorized, unexpired, unmatched intent exists for the lead', async () => {
    const db = fakeDb({ loadUnresolvedIntent: unresolved() });
    const { dialer, requests } = fakeDialer();
    const result = await run(db, dialer);
    expect(result).toMatchObject({ ok: false, code: 'prior_call_unresolved', priorIntentId: INTENT2 });
    expect(result).not.toHaveProperty('freshAttemptKey');
    expect(db.calls).not.toContain('prepareIntent');
    expect(requests).toHaveLength(0);
  });

  it('row 12: a replay of the unresolved intent own key is not refused', async () => {
    const db = fakeDb({ loadUnresolvedIntent: unresolved({ idempotencyKey: KEY }), authorizeDispatch: async () => ({ status: 'already_dispatched', intentId: INTENT2, expiresAt: '2026-09-29T10:10:00Z', dispatchAuthorizedAt: '2026-09-29T10:00:01Z' }) });
    expect(await run(db, fakeDialer().dialer)).toMatchObject({ ok: true, state: 'already_dispatched' });
  });

  it('row 13: the redial is accepted only when confirmRedialOf is the newest unresolved intent', async () => {
    const ok = fakeDb({ loadUnresolvedIntent: unresolved() });
    const { dialer, requests } = fakeDialer();
    expect(await run(ok, dialer, { confirmRedialOf: INTENT2 })).toMatchObject({ ok: true, state: 'awaiting_provider' });
    expect(requests).toHaveLength(1);
    for (const stale of [INTENT, '99999999-9999-4999-8999-999999999999']) {
      const db = fakeDb({ loadUnresolvedIntent: unresolved() });
      const fresh = fakeDialer();
      expect(await run(db, fresh.dialer, { confirmRedialOf: stale })).toMatchObject({ ok: false, code: 'prior_call_unresolved', priorIntentId: INTENT2 });
      expect(fresh.requests).toHaveLength(0);
    }
    expect(await run(fakeDb(), fakeDialer().dialer, { confirmRedialOf: 'nope' })).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('row 14: the backstop is per lead; it asks only about the property being dialed and never blocks another lead', async () => {
    const loadUnresolvedIntent = vi.fn(async (_o: string, _u: string, property: string) => (property === PROPERTY ? { intentId: INTENT2, idempotencyKey: KEY2 } : null));
    const other = '33333333-3333-4333-8333-333333333334';
    const dialA = fakeDb({ loadUnresolvedIntent });
    expect(await run(dialA, fakeDialer().dialer)).toMatchObject({ ok: false, code: 'prior_call_unresolved' });
    const dialB = fakeDb({ loadUnresolvedIntent });
    expect(await run(dialB, fakeDialer().dialer, { propertyId: other, idempotencyKey: KEY2 })).toMatchObject({ ok: true });
    expect(loadUnresolvedIntent).toHaveBeenNthCalledWith(1, ORG, REP, PROPERTY, '2026-09-29T17:00:00.000Z');
    expect(loadUnresolvedIntent).toHaveBeenNthCalledWith(2, ORG, REP, other, '2026-09-29T17:00:00.000Z');
  });

  it('row 15: a replay of an expired key says the call may have rung, not that it was never sent', async () => {
    const db = fakeDb({ authorizeDispatch: async () => ({ status: 'expired', intentId: INTENT }) });
    const result = await run(db, fakeDialer().dialer);
    expect(result).toMatchObject({ ok: false, code: 'expired', message: 'No confirmation from Dialpad. Check the dialer before calling again.' });
    expect(result).not.toHaveProperty('freshAttemptKey');
  });

  it('row 16: a second click inside 20 s is refused with call_in_flight and no new intent', async () => {
    const db = fakeDb({ loadDispatchLoad: async () => ({ authorizedLastMinute: 1, unmatchedLast20s: 1 }) });
    expect(await run(db, fakeDialer().dialer, { idempotencyKey: KEY2 })).toMatchObject({ ok: false, code: 'call_in_flight' });
    expect(db.calls).not.toContain('prepareIntent');
  });
});

describe('startDialpadApiCall calling hours (lead-local 08:00-21:00)', () => {
  const NIGHT = new Date('2026-09-30T02:30:00Z'); // 21:30 CDT
  const quietCopy = 'Calling is unavailable during quiet hours.';
  const expectNothingDialed = (db: ReturnType<typeof fakeDb>, requests: DialpadDialRequest[]) => {
    expect(db.calls).not.toContain('prepareIntent');
    expect(db.calls).not.toContain('authorizeDispatch');
    expect(requests).toHaveLength(0);
  };

  it('dials inside the window', async () => {
    const db = fakeDb();
    const { dialer, requests } = fakeDialer();
    const result = await run(db, dialer);
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
  });
  it('refuses outside the window before prepare, authorize or any provider call', async () => {
    const db = fakeDb();
    const { dialer, requests } = fakeDialer();
    const result = await run(db, dialer, {}, NIGHT);
    expect(result).toMatchObject({ ok: false, code: 'denied', denial: 'outside_calling_hours', message: quietCopy, freshAttemptKey: true });
    expectNothingDialed(db, requests);
  });
  it('treats 21:00:00 as closed and 20:59:59 as open, and 07:59:59 as closed', async () => {
    const { dialer } = fakeDialer();
    expect((await run(fakeDb(), dialer, {}, new Date('2026-09-30T02:00:00Z'))).ok).toBe(false);
    expect((await run(fakeDb(), dialer, {}, new Date('2026-09-30T01:59:59Z'))).ok).toBe(true);
    expect((await run(fakeDb(), dialer, {}, new Date('2026-09-29T12:59:59Z'))).ok).toBe(false);
  });
  it('uses the property state zone (HI is open at 21:30 CDT)', async () => {
    const db = fakeDb({ loadPropertyState: async () => ({ found: true, state: 'HI' }) });
    expect((await run(db, fakeDialer().dialer, {}, NIGHT)).ok).toBe(true);
  });
  it.each([null, '', 'ZZ'])('fails closed for unknown state %s', async (state) => {
    const db = fakeDb({ loadPropertyState: async () => ({ found: true, state }) });
    const { dialer, requests } = fakeDialer();
    const result = await run(db, dialer);
    expect(result).toMatchObject({ ok: false, denial: 'outside_calling_hours' });
    expectNothingDialed(db, requests);
  });
  it('fails closed when the property is not found', async () => {
    const db = fakeDb({ loadPropertyState: async () => ({ found: false, state: null }) });
    const { dialer, requests } = fakeDialer();
    expect(await run(db, dialer)).toMatchObject({ ok: false, denial: 'outside_calling_hours' });
    expectNothingDialed(db, requests);
  });
  it('fails closed when the state lookup throws', async () => {
    const db = fakeDb({ loadPropertyState: async () => { throw new Error('boom'); } });
    const { dialer, requests } = fakeDialer();
    expect(await run(db, dialer)).toMatchObject({ ok: false, code: 'dialpad_unavailable' });
    expectNothingDialed(db, requests);
  });
  it('ignores E2E_QUIET_HOURS_NOW because the injected clock decides', async () => {
    vi.stubEnv('E2E_QUIET_HOURS_NOW', IN_WINDOW.toISOString());
    try {
      expect((await run(fakeDb(), fakeDialer().dialer, {}, NIGHT)).ok).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each(['loadActiveGrants', 'loadConnection', 'loadLiveBinding'] as const)(
    'passes at 20:59:59, closes during %s: no prepareIntent, no authorize, no provider call',
    async (hook) => {
      let t = new Date('2026-09-30T01:59:59Z').getTime(); // 20:59:59 CDT
      const base = fakeDb();
      const close = <R,>(fn: () => Promise<R>) => async () => { t = new Date('2026-09-30T02:00:01Z').getTime(); return fn(); };
      const over: Partial<DialpadDispatchDb> = {};
      if (hook === 'loadActiveGrants') over.loadActiveGrants = close(async () => []);
      if (hook === 'loadConnection') over.loadConnection = close(async () => conn());
      if (hook === 'loadLiveBinding') over.loadLiveBinding = close(async () => ({ id: BINDING, status: 'verified' as const, dialpadUserId: '5551234' }));
      const db = Object.assign(base, over);
      const { dialer, requests } = fakeDialer();
      const result = await startDialpadApiCall(db, dialer, actor, input, { env, now: () => new Date(t) });
      expect(result).toMatchObject({ ok: false, code: 'denied', denial: 'outside_calling_hours', freshAttemptKey: true });
      expect(db.calls).not.toContain('prepareIntent');
      expect(db.calls).not.toContain('authorizeDispatch');
      expect(requests).toHaveLength(0);
    },
  );
  it('closes between prepare and authorize: intent cancelled, no authorize, no provider call', async () => {
    let t = new Date('2026-09-30T01:59:59Z').getTime();
    const db = fakeDb({ prepareIntent: async () => { t = new Date('2026-09-30T02:00:01Z').getTime(); return prepared(); } });
    const { dialer, requests } = fakeDialer();
    const result = await startDialpadApiCall(db, dialer, actor, input, { env, now: () => new Date(t) });
    expect(result).toMatchObject({ ok: false, denial: 'outside_calling_hours' });
    expect(db.calls).toContain('cancelIntent');
    expect(db.calls).not.toContain('authorizeDispatch');
    expect(requests).toHaveLength(0);
  });
  it('re-checks the clock again after authorize: closes during loadConnection, intent cancelled, no provider call', async () => {
    let t = new Date('2026-09-30T01:59:59Z').getTime();
    const db = fakeDb({ loadConnection: async () => { const c = conn(); if (db.calls.includes('authorizeDispatch')) t = new Date('2026-09-30T02:00:01Z').getTime(); return c; } });
    const { dialer, requests } = fakeDialer();
    const result = await startDialpadApiCall(db, dialer, actor, input, { env, now: () => new Date(t) });
    expect(result).toMatchObject({ ok: false, denial: 'outside_calling_hours' });
    expect(db.calls).toContain('authorizeDispatch');
    expect(db.calls).toContain('cancelIntent');
    expect(requests).toHaveLength(0);
  });
});

describe('resolveDialpadHoursClock', () => {
  const PINNED = '2026-05-09T16:00:00.000Z';
  it('honours E2E_QUIET_HOURS_NOW only for the stub provider', () => {
    expect(resolveDialpadHoursClock({ DIALPAD_DIAL_PROVIDER: 'stub', E2E_QUIET_HOURS_NOW: PINNED })().toISOString()).toBe(PINNED);
  });
  it('production ignores the override even with the stub requested', () => {
    const before = Date.now();
    const got = resolveDialpadHoursClock({ VERCEL_ENV: 'production', DIALPAD_DIAL_PROVIDER: 'stub', E2E_QUIET_HOURS_NOW: PINNED })().getTime();
    expect(got).toBeGreaterThanOrEqual(before);
  });
  it('the live provider ignores the override', () => {
    const before = Date.now();
    expect(resolveDialpadHoursClock({ E2E_QUIET_HOURS_NOW: PINNED })().getTime()).toBeGreaterThanOrEqual(before);
  });
  it('a stub with a missing or invalid override uses real time', () => {
    const before = Date.now();
    expect(resolveDialpadHoursClock({ DIALPAD_DIAL_PROVIDER: 'stub' })().getTime()).toBeGreaterThanOrEqual(before);
    expect(resolveDialpadHoursClock({ DIALPAD_DIAL_PROVIDER: 'stub', E2E_QUIET_HOURS_NOW: 'nope' })().getTime()).toBeGreaterThanOrEqual(before);
  });
  it('startDialpadApiCall defaults to that clock: stub + in-window override dials, production at the same pinned time does not use it', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-30T02:30:00Z')); // 21:30 CDT, closed
      const stubEnv = { ...env, DIALPAD_DIAL_PROVIDER: 'stub', E2E_QUIET_HOURS_NOW: PINNED };
      const ok = await startDialpadApiCall(fakeDb(), fakeDialer().dialer, actor, input, { env: stubEnv });
      expect(ok.ok).toBe(true);
      const prod = await startDialpadApiCall(fakeDb(), fakeDialer().dialer, actor, input, { env: { ...stubEnv, VERCEL_ENV: 'production' } });
      expect(prod).toMatchObject({ ok: false, denial: 'outside_calling_hours' });
    } finally {
      vi.useRealTimers();
    }
  });
  describe('a pinned hours clock never leaks into rate or expiry', () => {
    const PINNED = '2026-05-09T16:00:00.000Z';
    const withClock = async (over: Partial<DialpadDispatchDb>) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-10-06T02:30:00Z')); // 21:30 CDT
        const db = fakeDb(over);
        const result = await startDialpadApiCall(db, fakeDialer().dialer, actor, input, { env: { ...env, DIALPAD_DIAL_PROVIDER: 'stub', E2E_QUIET_HOURS_NOW: PINNED } });
        return { db, result };
      } finally {
        vi.useRealTimers();
      }
    };
    it('U1: rate and unresolved queries use real time', async () => {
      const loadUnresolvedIntent = vi.fn(async () => null);
      const loadDispatchLoad = vi.fn(async () => ({ authorizedLastMinute: 0, unmatchedLast20s: 0 }));
      const { result } = await withClock({ loadUnresolvedIntent, loadDispatchLoad });
      expect(result.ok).toBe(true);
      expect((loadUnresolvedIntent.mock.calls as unknown as string[][])[0]![3]).toBe('2026-10-06T02:30:00.000Z');
      expect((loadDispatchLoad.mock.calls as unknown as string[][])[0]![2]).toBe('2026-10-06T02:29:00.000Z');
    });
    it('U2: an intent that expired a minute ago does not block a new key', async () => {
      const loadUnresolvedIntent = async (_o: string, _u: string, _p: string, nowIso: string) =>
        nowIso < '2026-10-06T02:29:00.000Z' ? { intentId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } : null;
      const { result } = await withClock({ loadUnresolvedIntent });
      expect(result).not.toMatchObject({ code: 'prior_call_unresolved' });
      expect(result.ok).toBe(true);
    });
    it('U3: old authorized dials are not counted as the last minute', async () => {
      const loadDispatchLoad = async (_o: string, _u: string, sinceIso: string) =>
        ({ authorizedLastMinute: sinceIso <= PINNED ? 4 : 0, unmatchedLast20s: 0 });
      const { result } = await withClock({ loadDispatchLoad });
      expect(result).not.toMatchObject({ code: 'rate_limited' });
      expect(result.ok).toBe(true);
    });
  });
});
