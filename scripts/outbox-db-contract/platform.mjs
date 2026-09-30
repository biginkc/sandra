import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const NOT_VERIFIED = 'NOT_VERIFIED';
export async function readonlyGet(url, options = {}, transport = globalThis.fetch) {
  const parsed = new URL(url);
  if (options.method && options.method !== 'GET' || !['/rest/v1/', '/auth/v1/health'].includes(parsed.pathname) || parsed.search) {
    throw new Error('READONLY_HTTP_DENIED');
  }
  return transport(url, { ...options, method: 'GET', redirect: 'error' });
}
const responseIs200 = response => response.ok && (response.status === undefined || response.status === 200);
const isPostgrestMajor = value => value === NOT_VERIFIED || /^\d+$/.test(String(value ?? ''));
export async function platformFingerprint(apiUrl, anonKey, postgresMajor, transport, { mode = 'disposable', postgrestMajor } = {}) {
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
  const result = { postgres_major: String(postgresMajor), postgrest_major: mode === 'hosted' ? String(postgrestMajor) : httpPostgrestMajor, gotrue_major: version.match(/\d+/)?.[0] };
  if (!result.gotrue_major) throw new Error('PLATFORM_VERSION_MISSING');
  return { ...result, sha256: digest(result) };
}
export function comparePlatform(a, b) {
  for (const key of ['postgres_major', 'gotrue_major']) if (a[key] !== b[key]) throw new Error(`PLATFORM_MISMATCH ${key}`);
  if (!isPostgrestMajor(a.postgrest_major) || !isPostgrestMajor(b.postgrest_major)) throw new Error('PLATFORM_MISMATCH postgrest_major');
  if (b.postgrest_major !== NOT_VERIFIED && a.postgrest_major !== b.postgrest_major) throw new Error('PLATFORM_MISMATCH postgrest_major');
  return { waived_fields: b.postgrest_major === NOT_VERIFIED ? ['postgrest_major'] : [] };
}
export function compareObservedPlatform(a, b) {
  for (const key of ['postgres_major', 'gotrue_major']) if (a[key] !== b[key]) throw new Error(`PLATFORM_MISMATCH ${key}`);
  if (!isPostgrestMajor(a.postgrest_major) || !isPostgrestMajor(b.postgrest_major)) throw new Error('PLATFORM_MISMATCH postgrest_major');
  if (a.postgrest_major !== NOT_VERIFIED && b.postgrest_major !== NOT_VERIFIED && a.postgrest_major !== b.postgrest_major) throw new Error('PLATFORM_MISMATCH postgrest_major');
}
