import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function readonlyGet(url, options = {}, transport = globalThis.fetch) {
  const parsed = new URL(url);
  if (options.method && options.method !== 'GET' || !['/rest/v1/', '/auth/v1/health'].includes(parsed.pathname) || parsed.search) {
    throw new Error('READONLY_HTTP_DENIED');
  }
  return transport(url, { ...options, method: 'GET', redirect: 'error' });
}
export async function platformFingerprint(apiUrl, anonKey, postgresMajor, transport) {
  const headers = anonKey ? { apikey: anonKey } : {};
  const root = apiUrl.replace(/\/$/, '');
  const rest = await readonlyGet(`${root}/rest/v1/`, { headers }, transport);
  const auth = await readonlyGet(`${root}/auth/v1/health`, {}, transport);
  if (!rest.ok || !auth.ok) throw new Error('PLATFORM_READ_FAILED');
  const health = await auth.json();
  const version = String(health.version ?? '');
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
  if (!version) throw new Error('PLATFORM_VERSION_MISSING');
  const result = { postgres_major: String(postgresMajor), postgrest_major: postgrest[1], gotrue_major: version.match(/\d+/)?.[0] };
  if (!result.gotrue_major) throw new Error('PLATFORM_VERSION_MISSING');
  return { ...result, sha256: digest(result) };
}
export function comparePlatform(a, b) {
  for (const key of ['postgres_major', 'postgrest_major', 'gotrue_major']) if (a[key] !== b[key]) throw new Error(`PLATFORM_MISMATCH ${key}`);
}
