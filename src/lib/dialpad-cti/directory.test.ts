import { describe, expect, it } from 'vitest';

import {
  assessDialpadDirectoryIdentity,
  dialpadDirectoryVerificationRef,
  fetchDialpadDirectoryUser,
  findDialpadDirectoryUserByEmail,
  parseClaimedDialpadUserId,
  parseDialpadDirectoryUser,
  parseDialpadDirectoryUsers,
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

// Shape per the official Dialpad "Get a user" reference (GET /api/v2/users/{id}): every field is optional and
// nullable except voicemail and onboarding_completed; id/company_id/office_id are int64; state is one of
// active | cancelled | deleted | pending | suspended; emails is an array of strings.
describe('parseDialpadDirectoryUser against the documented user schema', () => {
  const documented = (over: Record<string, string> = {}) => `{
    "id": ${over.id ?? '5551234'}, "company_id": ${over.company_id ?? '9007199254740993'}, "office_id": 9007199254740995,
    "state": ${over.state ?? '"active"'}, "emails": ${over.emails ?? '["Rep@Example.com"]'},
    "first_name": "Maria", "last_name": null, "display_name": "Maria", "is_super_admin": false, "is_admin": false,
    "job_title": null, "phone_numbers": ["+18165550100"], "extension": "1234", "do_not_disturb": false,
    "is_on_duty": true, "on_duty_status": "available", "license": "talk",
    "voicemail": {"bluetooth_voicemail": false, "voicemail_greeting": null}, "onboarding_completed": true
  }`;
  it('reads id, company_id, state and emails without rounding int64 values, ignoring the rest', () => {
    expect(parseDialpadDirectoryUser(documented())).toEqual({ id: '5551234', companyId: '9007199254740993', state: 'active', emails: ['Rep@Example.com'] });
  });
  it.each(['cancelled', 'deleted', 'pending', 'suspended'])('parses the %s state so the identity check can refuse it', (state) => {
    const user = parseDialpadDirectoryUser(documented({ state: JSON.stringify(state) }))!;
    expect(user.state).toBe(state);
    expect(assessDialpadDirectoryIdentity({ claimedDialpadUserId: '5551234', expectedCompanyId: '9007199254740993', sandraEmail: 'rep@example.com', sandraEmailConfirmed: true, user })).toEqual({ ok: false, reason: 'inactive' });
  });
  it('treats null emails as no emails, so a match is impossible', () => {
    const user = parseDialpadDirectoryUser(documented({ emails: 'null' }))!;
    expect(user.emails).toEqual([]);
    expect(assessDialpadDirectoryIdentity({ claimedDialpadUserId: '5551234', expectedCompanyId: '9007199254740993', sandraEmail: 'rep@example.com', sandraEmailConfirmed: true, user })).toEqual({ ok: false, reason: 'email_mismatch' });
  });
  it('matches the confirmed Sandra email case-insensitively', () => {
    const user = parseDialpadDirectoryUser(documented())!;
    expect(assessDialpadDirectoryIdentity({ claimedDialpadUserId: '5551234', expectedCompanyId: '9007199254740993', sandraEmail: 'rep@example.com', sandraEmailConfirmed: true, user })).toEqual({ ok: true });
  });
  it('fails closed when the documented-nullable identity fields are null', () => {
    expect(parseDialpadDirectoryUser(documented({ id: 'null' }))).toBeNull();
    expect(parseDialpadDirectoryUser(documented({ company_id: 'null' }))).toBeNull();
    expect(parseDialpadDirectoryUser(documented({ state: 'null' }))).toBeNull();
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

describe('findDialpadDirectoryUserByEmail', () => {
  const rec = (id: string, emails: string[], company = '42') => `{"id":${id},"company_id":${company},"state":"active","emails":${JSON.stringify(emails)}}`;
  const find = (fetchImpl: DialpadDirectoryFetch, email = 'Rep@Example.com') => findDialpadDirectoryUserByEmail({ email, apiKey: KEY, fetchImpl });

  it('returns the single match from an items envelope and from a bare array', async () => {
    const expected = { ok: true, user: { id: '5551234', companyId: '42', state: 'active', emails: ['rep@example.com'] } };
    expect(await find(responder(200, `{"items":[${rec('5551234', ['rep@example.com'])}]}`))).toEqual(expected);
    expect(await find(responder(200, `[${rec('5551234', ['rep@example.com'])}]`))).toEqual(expected);
  });
  it('maps statuses', async () => {
    expect(await find(responder(404, ''))).toEqual({ ok: false, reason: 'not_found' });
    expect(await find(responder(401, ''))).toEqual({ ok: false, reason: 'rejected' });
    expect(await find(responder(403, ''))).toEqual({ ok: false, reason: 'rejected' });
    expect(await find(responder(500, ''))).toEqual({ ok: false, reason: 'unavailable' });
    expect(await find(responder(503, ''))).toEqual({ ok: false, reason: 'unavailable' });
    expect(await find(async () => { throw new Error('boom'); })).toEqual({ ok: false, reason: 'unavailable' });
  });
  it('treats invalid JSON and a non-list body as invalid_response', async () => {
    expect(await find(responder(200, 'garbage'))).toEqual({ ok: false, reason: 'invalid_response' });
    expect(await find(responder(200, '{"foo":1}'))).toEqual({ ok: false, reason: 'invalid_response' });
    expect(await find(responder(200, ''))).toEqual({ ok: false, reason: 'invalid_response' });
  });
  it('refuses to guess when two users carry the email', async () => {
    const body = `[${rec('5551234', ['rep@example.com'])},${rec('5551235', ['REP@example.com'])}]`;
    expect(await find(responder(200, body))).toEqual({ ok: false, reason: 'invalid_response' });
  });
  it('is not_found when a 200 list has no record with the email', async () => {
    expect(await find(responder(200, `[${rec('5551234', ['someone@example.com'])}]`))).toEqual({ ok: false, reason: 'not_found' });
    expect(await find(responder(200, '[]'))).toEqual({ ok: false, reason: 'not_found' });
  });
  it('picks the matching record out of a mixed list', async () => {
    const body = `[${rec('1', ['other@example.com'])},${rec('2', ['rep@example.com'])}]`;
    expect(await find(responder(200, body))).toMatchObject({ ok: true, user: { id: '2' } });
  });
  it('keeps int64 ids exact', async () => {
    const result = await find(responder(200, `[${rec('9007199254740993', ['rep@example.com'], '9007199254740995')}]`));
    expect(result).toMatchObject({ ok: true, user: { id: '9007199254740993', companyId: '9007199254740995' } });
  });
  it('uses GET with the encoded email, Bearer key, no redirects and no caching', async () => {
    let seen: { url: string; init: Parameters<DialpadDirectoryFetch>[1] } | null = null;
    await find(async (url, init) => { seen = { url, init }; return { status: 200, text: async () => '[]' }; }, '  A+b@Example.com ');
    expect(seen!.url).toBe('https://dialpad.com/api/v2/users?email=a%2Bb%40example.com');
    expect(seen!.init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store' });
    expect(seen!.init.headers.Authorization).toBe(`Bearer ${KEY}`);
  });
  it('rejects an unusable email without any request', async () => {
    let called = false;
    const fetchImpl: DialpadDirectoryFetch = async () => { called = true; return { status: 200, text: async () => '[]' }; };
    expect(await find(fetchImpl, '')).toEqual({ ok: false, reason: 'invalid_response' });
    expect(await find(fetchImpl, 'no-at-sign')).toEqual({ ok: false, reason: 'invalid_response' });
    expect(called).toBe(false);
  });
});

describe('parseDialpadDirectoryUsers', () => {
  it('returns null when any item is malformed', () => {
    expect(parseDialpadDirectoryUsers('[{"id":1}]')).toBeNull();
    expect(parseDialpadDirectoryUsers('{"items":"x"}')).toBeNull();
  });
});
