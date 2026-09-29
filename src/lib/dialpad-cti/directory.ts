/**
 * Trusted Dialpad identity verification. The browser-relayed `user_id` from the
 * Mini Dialer's `user_authentication` message is only a claim. This module
 * checks it against Dialpad's own user directory (GET /api/v2/users/{id},
 * documented in the Dialpad API "usersget" reference) and requires the record
 * to belong to the org's Dialpad company and to carry the authenticated Sandra
 * user's verified email. Dialpad ids are int64, so the raw response text is
 * rewritten to quote them before JSON.parse can round them.
 */

export const DIALPAD_API_ORIGIN = 'https://dialpad.com';
const DIRECTORY_KEY_REF = /^env:(DIALPAD_CTI_DIRECTORY_KEY_[A-Z0-9_]{1,80})$/;
const MIN_KEY_LENGTH = 16;
const DIGITS = /^[0-9]{1,20}$/;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_RESPONSE_CHARS = 262_144;

export type DialpadDirectoryEnv = Readonly<Record<string, string | undefined>>;

/** `directory_api_key_ref` is a name, never a value; only the DIALPAD_CTI_DIRECTORY_KEY_ namespace resolves. */
export function resolveDialpadDirectoryKey(ref: string | null | undefined, env: DialpadDirectoryEnv): string | null {
  const match = ref ? DIRECTORY_KEY_REF.exec(ref) : null;
  if (!match) return null;
  const value = env[match[1]!];
  return typeof value === 'string' && value.length >= MIN_KEY_LENGTH ? value : null;
}

/** A Dialpad id as the browser may relay it: a positive JS-safe integer, as a canonical decimal string. */
export function parseClaimedDialpadUserId(value: unknown): string | null {
  const text = typeof value === 'number' ? (Number.isSafeInteger(value) ? String(value) : null) : typeof value === 'string' ? value : null;
  if (text === null || !/^[1-9][0-9]{0,15}$/.test(text)) return null;
  return Number.isSafeInteger(Number(text)) && String(Number(text)) === text ? text : null;
}

export interface DialpadDirectoryUser {
  id: string;
  companyId: string;
  state: string;
  emails: string[];
}

export type DialpadDirectoryFailure = 'not_found' | 'rejected' | 'unavailable' | 'invalid_response';

export type DialpadDirectoryResult = { ok: true; user: DialpadDirectoryUser } | { ok: false; reason: DialpadDirectoryFailure };

export type DialpadDirectoryFetch = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; redirect: 'error'; cache: 'no-store'; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

const INT64_FIELDS = /"(id|company_id|office_id)"(\s*:\s*)(-?\d{1,20})(?=\s*[,}\]])/g;

/** Exposed for tests: parses a directory record without ever rounding an int64 id. */
export function parseDialpadDirectoryUser(rawText: string): DialpadDirectoryUser | null {
  if (rawText.length === 0 || rawText.length > MAX_RESPONSE_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText.replace(INT64_FIELDS, '"$1"$2"$3"'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const id = record.id;
  const companyId = record.company_id;
  if (typeof id !== 'string' || !DIGITS.test(id) || typeof companyId !== 'string' || !DIGITS.test(companyId)) return null;
  if (typeof record.state !== 'string') return null;
  const emails = Array.isArray(record.emails) ? record.emails.filter((email): email is string => typeof email === 'string') : [];
  return { id, companyId, state: record.state, emails };
}

export async function fetchDialpadDirectoryUser(input: {
  dialpadUserId: string;
  apiKey: string;
  fetchImpl?: DialpadDirectoryFetch;
}): Promise<DialpadDirectoryResult> {
  if (!DIGITS.test(input.dialpadUserId)) return { ok: false, reason: 'invalid_response' };
  const doFetch: DialpadDirectoryFetch = input.fetchImpl ?? ((url, init) => fetch(url, init));
  let response: { status: number; text(): Promise<string> };
  try {
    response = await doFetch(`${DIALPAD_API_ORIGIN}/api/v2/users/${input.dialpadUserId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${input.apiKey}`, Accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (response.status === 404) return { ok: false, reason: 'not_found' };
  if (response.status === 401 || response.status === 403) return { ok: false, reason: 'rejected' };
  if (response.status !== 200) return { ok: false, reason: 'unavailable' };
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  const user = parseDialpadDirectoryUser(text);
  return user ? { ok: true, user } : { ok: false, reason: 'invalid_response' };
}

export type DialpadIdentityMismatch = 'user_mismatch' | 'inactive' | 'company_mismatch' | 'email_unverified' | 'email_mismatch';

/**
 * The directory record must be the claimed user, active, in the org's Dialpad
 * company, and list the authenticated Sandra user's confirmed email.
 */
export function assessDialpadDirectoryIdentity(input: {
  claimedDialpadUserId: string;
  expectedCompanyId: string | null;
  sandraEmail: string | null;
  sandraEmailConfirmed: boolean;
  user: DialpadDirectoryUser;
}): { ok: true } | { ok: false; reason: DialpadIdentityMismatch } {
  if (input.user.id !== input.claimedDialpadUserId) return { ok: false, reason: 'user_mismatch' };
  if (input.user.state !== 'active') return { ok: false, reason: 'inactive' };
  if (!input.expectedCompanyId || input.user.companyId !== input.expectedCompanyId) return { ok: false, reason: 'company_mismatch' };
  const email = input.sandraEmail?.trim().toLowerCase();
  if (!email || !input.sandraEmailConfirmed) return { ok: false, reason: 'email_unverified' };
  if (!input.user.emails.some((candidate) => candidate.trim().toLowerCase() === email)) return { ok: false, reason: 'email_mismatch' };
  return { ok: true };
}

/** Evidence stored on the binding; ids only, no email or other personal data. */
export function dialpadDirectoryVerificationRef(companyId: string, dialpadUserId: string): string {
  return `dialpad-directory:${companyId}:${dialpadUserId}`;
}
