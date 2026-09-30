import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const NOT_VERIFIED = 'NOT_VERIFIED';
export const PLATFORM_MAJOR_FIELDS = Object.freeze(['postgres_major', 'postgrest_major', 'gotrue_major']);
export const PLATFORM_FIELDS = Object.freeze([...PLATFORM_MAJOR_FIELDS, 'postgrest_reason', 'postgrest_observed_major']);
const POSTGREST_REASONS = new Set(['NAME_UNVERSIONED', 'MIXED_NAMES', 'NO_CONNECTION']);
export function platformVerdict(waivedFields = []) {
  return waivedFields.length
    ? Object.fromEntries(PLATFORM_MAJOR_FIELDS.map(field => [field, waivedFields.includes(field) ? NOT_VERIFIED : 'PASS']))
    : 'PASS';
}
export function platformDigest(value) {
  const fields = Object.fromEntries(PLATFORM_FIELDS.map(field => [field, value?.[field]]));
  return digest(fields);
}
export function validatePlatformCombination(value, { requireVerifiedPostgrest = false } = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('PLATFORM_INVALID_FIELDS');
  if (!/^[0-9]+$/.test(String(value.postgres_major ?? '')) || !/^[0-9]+$/.test(String(value.gotrue_major ?? ''))) throw new Error('PLATFORM_INVALID_FIELDS');
  const major = value.postgrest_major;
  const observed = value.postgrest_observed_major;
  if (major === NOT_VERIFIED) {
    if (!POSTGREST_REASONS.has(value.postgrest_reason) ||
        (value.postgrest_reason === 'MIXED_NAMES'
          ? observed === null || !/^[0-9]+$/.test(String(observed))
          : observed !== null)) throw new Error('PLATFORM_INVALID_FIELDS');
    if (requireVerifiedPostgrest) throw new Error('PLATFORM_MISMATCH postgrest_major');
  } else if (/^[0-9]+$/.test(String(major ?? ''))) {
    if (value.postgrest_reason !== null || (observed !== null && String(observed) !== String(major))) throw new Error('PLATFORM_INVALID_FIELDS');
  } else throw new Error('PLATFORM_INVALID_FIELDS');
  return value;
}
export async function readonlyGet(url, options = {}, transport = globalThis.fetch) {
  const parsed = new URL(url);
  if (options.method && options.method !== 'GET' || !['/rest/v1/', '/auth/v1/health'].includes(parsed.pathname) || parsed.search) {
    throw new Error('READONLY_HTTP_DENIED');
  }
  return transport(url, { ...options, method: 'GET', redirect: 'error' });
}
const responseIs200 = response => response.ok && (response.status === undefined || response.status === 200);
export async function platformFingerprint(apiUrl, anonKey, postgresMajor, transport, options = {}) {
  const { mode = 'disposable', postgrestMajor, postgrestReason = null, postgrestObservedMajor = null } = options;
  if (!['disposable', 'hosted'].includes(mode) || !anonKey) throw new Error('PLATFORM_READ_FAILED');
  const headers = anonKey ? { apikey: anonKey } : {};
  const root = apiUrl.replace(/\/$/, '');
  const rest = mode === 'disposable' ? await readonlyGet(`${root}/rest/v1/`, { headers }, transport) : null;
  const auth = await readonlyGet(`${root}/auth/v1/health`, { headers }, transport);
  if ((rest && !responseIs200(rest)) || !responseIs200(auth)) throw new Error('PLATFORM_READ_FAILED');
  const health = await auth.json();
  const version = String(health.version ?? '');
  let httpPostgrestMajor;
  if (mode === 'disposable') {
    const versionHeader = rest.headers.get('x-postgrest-version');
    const serverHeader = rest.headers.get('server');
    let postgrest = versionHeader === null ? null : /^(?:PostgREST\/)?(\d+)\.\d+(?:\.\d+)?$/i.exec(versionHeader);
    postgrest ??= /^PostgREST\/(\d+)\.\d+(?:\.\d+)?$/i.exec(serverHeader ?? '');
    if (!postgrest) {
      let body;
      try { body = await rest.json(); } catch { throw new Error('PLATFORM_UNIDENTIFIED'); }
      if (body && typeof body === 'object' &&
          (typeof body.swagger === 'string' || typeof body.openapi === 'string') &&
          typeof body.info?.version === 'string') {
        postgrest = /^(\d+)\.\d+(?:\.\d+)?(?: \([0-9a-f]+\))?$/.exec(body.info.version);
      }
    }
    if (!postgrest) throw new Error('PLATFORM_UNIDENTIFIED');
    httpPostgrestMajor = postgrest[1];
    if (postgrestMajor === undefined || postgrestMajor !== httpPostgrestMajor) throw new Error('PLATFORM_MISMATCH postgrest_major');
  } else if (postgrestMajor !== NOT_VERIFIED && !/^\d+$/.test(String(postgrestMajor ?? ''))) {
    throw new Error('PLATFORM_READ_FAILED');
  }
  if (!version) throw new Error('PLATFORM_VERSION_MISSING');
  const result = { postgres_major: String(postgresMajor), postgrest_major: mode === 'hosted' ? String(postgrestMajor) : httpPostgrestMajor, gotrue_major: version.match(/\d+/)?.[0], postgrest_reason: mode === 'hosted' ? postgrestReason : null, postgrest_observed_major: mode === 'hosted' ? postgrestObservedMajor : null };
  // Keep the disposable HTTP assertion blocking and require the SQL observation
  // to be a verified, matching major. Hosted names may be diagnostic-only.
  if (mode === 'disposable' && (postgrestMajor !== httpPostgrestMajor || postgrestMajor === NOT_VERIFIED)) throw new Error('PLATFORM_MISMATCH postgrest_major');
  validatePlatformCombination(result, { requireVerifiedPostgrest: mode === 'disposable' });
  if (!result.gotrue_major) throw new Error('PLATFORM_VERSION_MISSING');
  return { ...result, sha256: platformDigest(result) };
}
export function comparePlatform(a, b) {
  validatePlatformCombination(a, { requireVerifiedPostgrest: true });
  validatePlatformCombination(b);
  for (const key of ['postgres_major', 'gotrue_major']) if (a[key] !== b[key]) throw new Error(`PLATFORM_MISMATCH ${key}`);
  if (b.postgrest_major !== NOT_VERIFIED && a.postgrest_major !== b.postgrest_major) throw new Error('PLATFORM_MISMATCH postgrest_major');
  if (b.postgrest_observed_major !== null && b.postgrest_observed_major !== a.postgrest_major) throw new Error('PLATFORM_MISMATCH postgrest_major');
  return { waived_fields: b.postgrest_major === NOT_VERIFIED ? ['postgrest_major'] : [], waiver_reasons: b.postgrest_major === NOT_VERIFIED ? { postgrest_major: b.postgrest_reason } : {} };
}
export function compareObservedPlatform(a, b) {
  validatePlatformCombination(a);
  validatePlatformCombination(b);
  for (const key of ['postgres_major', 'gotrue_major']) if (a[key] !== b[key]) throw new Error(`PLATFORM_MISMATCH ${key}`);
  if (a.postgrest_major !== NOT_VERIFIED && b.postgrest_major !== NOT_VERIFIED && a.postgrest_major !== b.postgrest_major) throw new Error('PLATFORM_MISMATCH postgrest_major');
  if (a.postgrest_observed_major !== null && b.postgrest_observed_major !== null && a.postgrest_observed_major !== b.postgrest_observed_major) throw new Error('PLATFORM_MISMATCH postgrest_major');
}
