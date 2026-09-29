import { describe, expect, it } from 'vitest';

import {
  assessDialpadDirectoryIdentity,
  dialpadDirectoryVerificationRef,
  fetchDialpadDirectoryUser,
  parseClaimedDialpadUserId,
  parseDialpadDirectoryUser,
  resolveDialpadDirectoryKey,
  type DialpadDirectoryFetch,
  type DialpadDirectoryUser,
} from './directory';

const KEY = 'k'.repeat(24);
const user: DialpadDirectoryUser = { id: '5551234', companyId: '9007199254740993', state: 'active', emails: ['Rep@Example.com'] };

function responder(status: number, body: string): DialpadDirectoryFetch {
  return async () => ({ status, text: async () => body });
}

describe('resolveDialpadDirectoryKey', () => {
  it('resolves only the reserved env namespace', () => {
    const env = { DIALPAD_CTI_DIRECTORY_KEY_A: KEY, SUPABASE_SERVICE_ROLE_KEY: KEY, DIALPAD_CTI_DIRECTORY_KEY_SHORT: 'short' };
    expect(resolveDialpadDirectoryKey('env:DIALPAD_CTI_DIRECTORY_KEY_A', env)).toBe(KEY);
    expect(resolveDialpadDirectoryKey('env:SUPABASE_SERVICE_ROLE_KEY', env)).toBeNull();
    expect(resolveDialpadDirectoryKey('env:DIALPAD_CTI_DIRECTORY_KEY_SHORT', env)).toBeNull();
    expect(resolveDialpadDirectoryKey('env:DIALPAD_CTI_DIRECTORY_KEY_MISSING', env)).toBeNull();
    expect(resolveDialpadDirectoryKey(null, env)).toBeNull();
  });
});

describe('parseClaimedDialpadUserId', () => {
  it('accepts only exact positive JS-safe integers', () => {
    expect(parseClaimedDialpadUserId(5551234)).toBe('5551234');
    expect(parseClaimedDialpadUserId('5551234')).toBe('5551234');
    for (const bad of [0, -1, 1.5, 9007199254740993, '9007199254740993', '007', '1e3', ' 1', '', null, undefined, {}, NaN]) {
      expect(parseClaimedDialpadUserId(bad)).toBeNull();
    }
  });
});

describe('parseDialpadDirectoryUser', () => {
  it('keeps int64 ids exact', () => {
    const parsed = parseDialpadDirectoryUser('{"id": 5551234, "company_id": 9007199254740993, "office_id": 1, "state": "active", "emails": ["a@b.co"]}');
    expect(parsed).toEqual({ id: '5551234', companyId: '9007199254740993', state: 'active', emails: ['a@b.co'] });
  });
  it('rejects malformed, non-object and incomplete records', () => {
    for (const raw of ['', 'nope', '[]', '{"id":1}', '{"id":1,"company_id":2}', '{"id":"x","company_id":2,"state":"active"}']) {
      expect(parseDialpadDirectoryUser(raw)).toBeNull();
    }
  });
});

describe('fetchDialpadDirectoryUser', () => {
  it('calls the documented users endpoint with a bearer key, no redirects and no caching', async () => {
    let seen: { url: string; init: Parameters<DialpadDirectoryFetch>[1] } | null = null;
    const result = await fetchDialpadDirectoryUser({
      dialpadUserId: '5551234',
      apiKey: KEY,
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return { status: 200, text: async () => '{"id":5551234,"company_id":42,"state":"active","emails":["rep@example.com"]}' };
      },
    });
    expect(result).toEqual({ ok: true, user: { id: '5551234', companyId: '42', state: 'active', emails: ['rep@example.com'] } });
    expect(seen!.url).toBe('https://dialpad.com/api/v2/users/5551234');
    expect(seen!.init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store' });
    expect(seen!.init.headers.Authorization).toBe(`Bearer ${KEY}`);
  });
  it('maps failures without leaking the key', async () => {
    expect(await fetchDialpadDirectoryUser({ dialpadUserId: '1', apiKey: KEY, fetchImpl: responder(404, '') })).toEqual({ ok: false, reason: 'not_found' });
    expect(await fetchDialpadDirectoryUser({ dialpadUserId: '1', apiKey: KEY, fetchImpl: responder(401, '') })).toEqual({ ok: false, reason: 'rejected' });
    expect(await fetchDialpadDirectoryUser({ dialpadUserId: '1', apiKey: KEY, fetchImpl: responder(500, '') })).toEqual({ ok: false, reason: 'unavailable' });
    expect(await fetchDialpadDirectoryUser({ dialpadUserId: '1', apiKey: KEY, fetchImpl: responder(200, 'garbage') })).toEqual({ ok: false, reason: 'invalid_response' });
    const thrown = await fetchDialpadDirectoryUser({ dialpadUserId: '1', apiKey: KEY, fetchImpl: async () => { throw new Error(`boom ${KEY}`); } });
    expect(thrown).toEqual({ ok: false, reason: 'unavailable' });
    expect(await fetchDialpadDirectoryUser({ dialpadUserId: '../x', apiKey: KEY, fetchImpl: responder(200, '{}') })).toEqual({ ok: false, reason: 'invalid_response' });
  });
});

describe('assessDialpadDirectoryIdentity', () => {
  const base = { claimedDialpadUserId: '5551234', expectedCompanyId: '9007199254740993', sandraEmail: 'rep@example.com', sandraEmailConfirmed: true, user };
  it('accepts the claimed, active, same-company user with the confirmed email (case-insensitive)', () => {
    expect(assessDialpadDirectoryIdentity(base)).toEqual({ ok: true });
  });
  it.each([
    ['user_mismatch', { claimedDialpadUserId: '1' }],
    ['inactive', { user: { ...user, state: 'suspended' } }],
    ['company_mismatch', { expectedCompanyId: '42' }],
    ['company_mismatch', { expectedCompanyId: null }],
    ['email_unverified', { sandraEmailConfirmed: false }],
    ['email_unverified', { sandraEmail: null }],
    ['email_mismatch', { sandraEmail: 'other@example.com' }],
  ] as const)('rejects %s', (reason, override) => {
    expect(assessDialpadDirectoryIdentity({ ...base, ...override })).toEqual({ ok: false, reason });
  });
  it('stores only ids as verification evidence', () => {
    expect(dialpadDirectoryVerificationRef('42', '5551234')).toBe('dialpad-directory:42:5551234');
  });
});
