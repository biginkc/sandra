const PROD_REF = 'copflsklaefwzipsrjqz';
const TEST_REF = 'ncsngxlcyxylaeskiteu';

function url(value, label) {
  try { return new URL(value); } catch { throw new Error(`${label}: invalid URL`); }
}

export function assertDisposableTarget({ apiUrl, dbUrl, env = process.env }) {
  assertNoProductionRef('disposable', apiUrl, dbUrl);
  if (env.E2E_DISPOSABLE_DATABASE !== '1') throw new Error('DISPOSABLE_REQUIRED');
  if (!apiUrl || !dbUrl || `${apiUrl} ${dbUrl}`.includes(PROD_REF)) throw new Error('HOSTED_TARGET_REFUSED');
  const api = url(apiUrl, 'API');
  const db = url(dbUrl, 'DB');
  if (api.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(api.hostname) || !['54321', '55421'].includes(api.port) || api.pathname !== '/' || api.username || api.password || api.search || api.hash) throw new Error('DISPOSABLE_API_REFUSED');
  if (!['postgres:', 'postgresql:'].includes(db.protocol) || !['127.0.0.1', 'localhost'].includes(db.hostname) || !['54322', '55422'].includes(db.port) || db.username !== 'postgres' || db.pathname !== '/postgres' || db.search || db.hash) throw new Error('DISPOSABLE_DB_REFUSED');
  if (Number(api.port) + 1 !== Number(db.port)) throw new Error('DISPOSABLE_PORT_MISMATCH');
  if (env.E2E_CI_SUPABASE_PROJECT_REF) throw new Error('HOSTED_TARGET_REFUSED');
  return { api: api.origin, db: db.host, target: 'disposable' };
}

export function assertWriteMode(target, options) {
  if (target !== 'disposable') throw new Error('WRITE_MODE_REFUSED');
  return assertDisposableTarget(options);
}

export function assertNoProductionRef(target, ...values) {
  if (target !== 'production' && values.some(value => String(value ?? '').includes(PROD_REF))) throw new Error('HOSTED_TARGET_REFUSED');
}

export { PROD_REF, TEST_REF };
