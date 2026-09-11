#!/usr/bin/env node
/**
 * PR519 configuration-only metadata parser v1 (repaired).
 * Reads only allowlisted names, validates URL structure in memory, and never
 * opens a socket, invokes a child process, imports recovery/Auth/DB code, or
 * prints credential material. A non-zero status means the tuple is unusable.
 */

const ALLOWED_ENV = [
  'E2E_CI_SUPABASE_PROJECT_REF',
  'TEST_SUPABASE_URL',
  'E2E_CI_SUPABASE_DB_URL',
  'E2E_CI_SUPABASE_DB_HOST',
];
const REF_PATTERN = /^[a-z0-9]{20}$/;
const POOLER_HOST_PATTERN = /^[a-z0-9-]+\.pooler\.supabase\.com$/;
const DNS_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? '' : '';
}

function fixedError(code) {
  return { code };
}

function safeRef(raw) {
  return REF_PATTERN.test(raw ?? '') ? raw : null;
}

function safeDns(raw) {
  return DNS_PATTERN.test(raw ?? '') ? raw.toLowerCase() : null;
}

function safeMeta(raw, pattern) {
  return pattern.test(raw ?? '') ? raw : null;
}

function hostClass(hostname) {
  if (!hostname) return 'ABSENT';
  const lower = hostname.toLowerCase();
  if (!DNS_PATTERN.test(lower)) return 'UNSAFE';
  if (POOLER_HOST_PATTERN.test(lower)) return 'SUPABASE_POOLER';
  if (lower.endsWith('.supabase.co')) return 'SUPABASE_PROVIDER';
  return 'OTHER';
}

function parseApi(raw, expectedRef) {
  if (!raw) return { present: false, originMatch: false, queryHashAbsent: null, hostname: null, hostClass: 'ABSENT', error: fixedError('API_URL_ABSENT') };
  if (!expectedRef) return { present: true, originMatch: false, queryHashAbsent: null, hostname: null, hostClass: 'UNRESOLVED', error: fixedError('EXPECTED_REF_INVALID') };
  try {
    const value = new URL(raw);
    const hostname = safeDns(value.hostname);
    const expectedHost = `${expectedRef}.supabase.co`;
    const queryHashAbsent = value.search === '' && value.hash === '';
    const originMatch = value.protocol === 'https:' && hostname === expectedHost && !value.port && (value.pathname === '/' || value.pathname === '') && !value.username && !value.password;
    const valid = originMatch && queryHashAbsent;
    return {
      present: true,
      originMatch,
      queryHashAbsent,
      hostname,
      hostClass: hostClass(hostname),
      error: valid ? null : fixedError(originMatch ? 'API_ORIGIN_QUERY_OR_PATH_MISMATCH' : 'API_ORIGIN_MISMATCH'),
    };
  } catch {
    return { present: true, originMatch: false, queryHashAbsent: false, hostname: null, hostClass: 'UNPARSEABLE', error: fixedError('API_URL_UNPARSEABLE') };
  }
}

function parseSql(raw, expectedRef, suppliedHost) {
  if (!raw) {
    return { present: false, protocolMatch: false, structureMatch: false, refMatch: false, providerHostMatch: false, hostMatch: suppliedHost ? false : null, queryHashAbsent: null, port: null, database: null, rolePatternMatch: false, hostname: null, hostClass: 'ABSENT', error: fixedError('SQL_URL_ABSENT') };
  }
  if (!expectedRef) {
    return { present: true, protocolMatch: false, structureMatch: false, refMatch: false, providerHostMatch: false, hostMatch: suppliedHost ? false : null, queryHashAbsent: null, port: null, database: null, rolePatternMatch: false, hostname: null, hostClass: 'UNRESOLVED', error: fixedError('EXPECTED_REF_INVALID') };
  }
  try {
    const value = new URL(raw);
    const hostname = safeDns(value.hostname);
    const supplied = suppliedHost ? safeDns(suppliedHost) : null;
    const protocolMatch = value.protocol === 'postgresql:' || value.protocol === 'postgres:';
    const username = value.username;
    const refMatch = username === `postgres.${expectedRef}`;
    const providerHostMatch = Boolean(hostname && POOLER_HOST_PATTERN.test(hostname));
    const hostMatch = suppliedHost ? Boolean(supplied && hostname === supplied) : null;
    const queryHashAbsent = value.search === '' && value.hash === '';
    const parsedPort = value.port ? Number(value.port) : null;
    const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : null;
    const databaseCandidate = value.pathname.replace(/^\//, '');
    const database = databaseCandidate === 'postgres' ? databaseCandidate : null;
    const rolePatternMatch = refMatch;
    const structureMatch = protocolMatch && providerHostMatch && port === 6543 && database === 'postgres' && queryHashAbsent && !value.password.includes('\n');
    const usable = structureMatch && refMatch && hostMatch === true;
    let error = null;
    if (!usable) {
      if (!protocolMatch) error = fixedError('SQL_PROTOCOL_MISMATCH');
      else if (!providerHostMatch) error = fixedError('SQL_PROVIDER_HOST_MISMATCH');
      else if (!queryHashAbsent) error = fixedError('SQL_QUERY_OR_HASH_PRESENT');
      else if (!structureMatch) error = fixedError('SQL_STRUCTURE_MISMATCH');
      else if (!refMatch) error = fixedError('SQL_USERNAME_REF_MISMATCH');
      else if (hostMatch === false) error = fixedError('SQL_HOST_METADATA_MISMATCH');
      else error = fixedError('SQL_HOST_METADATA_UNRESOLVED');
    }
    return { present: true, protocolMatch, structureMatch, refMatch, providerHostMatch, hostMatch, queryHashAbsent, port, database, rolePatternMatch, hostname, hostClass: hostClass(hostname), error };
  } catch {
    return { present: true, protocolMatch: false, structureMatch: false, refMatch: false, providerHostMatch: false, hostMatch: suppliedHost ? false : null, queryHashAbsent: false, port: null, database: null, rolePatternMatch: false, hostname: null, hostClass: 'UNPARSEABLE', error: fixedError('SQL_URL_UNPARSEABLE') };
  }
}

const rawExpectedRef = process.env.E2E_CI_SUPABASE_PROJECT_REF || arg('--expected-ref');
const expectedRef = safeRef(rawExpectedRef);
const api = parseApi(process.env.TEST_SUPABASE_URL, expectedRef);
const sql = parseSql(process.env.E2E_CI_SUPABASE_DB_URL, expectedRef, process.env.E2E_CI_SUPABASE_DB_HOST || null);
const checks = {
  apiRefMatch: api.originMatch && api.queryHashAbsent === true,
  sqlRefMatch: sql.refMatch,
  sqlHostMatch: sql.hostMatch,
  sqlProviderHostMatch: sql.providerHostMatch,
  sqlStructureMatch: sql.structureMatch,
  rolePatternMatch: sql.rolePatternMatch,
  queryHashAbsent: api.queryHashAbsent === true && sql.queryHashAbsent === true,
  apiErrorClear: api.error === null,
  sqlErrorClear: sql.error === null,
};
const configuredTupleValid = checks.apiRefMatch && checks.sqlRefMatch && checks.sqlHostMatch === true && checks.sqlProviderHostMatch && checks.sqlStructureMatch && checks.rolePatternMatch && checks.queryHashAbsent && checks.apiErrorClear && checks.sqlErrorClear;
const output = {
  schemaVersion: 1,
  kind: 'PR519_CONFIGURATION_METADATA',
  mode: 'NO_NETWORK',
  observedAt: new Date().toISOString(),
  candidate: {
    head: safeMeta(arg('--head'), /^[0-9a-f]{40}$/i),
    workflow: safeMeta(arg('--workflow'), /^[A-Za-z0-9_.-]{1,128}$/),
    run: safeMeta(arg('--run'), /^[A-Za-z0-9_.:-]{1,128}$/),
    environment: safeMeta(arg('--environment'), /^e2e-ci$/),
  },
  inputNames: ALLOWED_ENV,
  precedence: [
    'E2E_CI_SUPABASE_PROJECT_REF process value; explicit --expected-ref is only an independently evidenced local rehearsal input and is never derived from a URL.',
    'TEST_SUPABASE_URL from the existing recovery workflow step mapping of secrets.E2E_CI_SUPABASE_URL.',
    'E2E_CI_SUPABASE_DB_URL from the existing recovery workflow step mapping of secrets.E2E_CI_SUPABASE_DB_URL.',
    'E2E_CI_SUPABASE_DB_HOST from the existing recovery workflow variable when present; no guessed fallback.',
  ],
  expectedRef,
  api: { originMatch: api.originMatch, queryHashAbsent: api.queryHashAbsent, hostname: api.hostname, hostClass: api.hostClass, error: api.error },
  sql: { protocolMatch: sql.protocolMatch, structureMatch: sql.structureMatch, refMatch: sql.refMatch, providerHostMatch: sql.providerHostMatch, hostMatch: sql.hostMatch, queryHashAbsent: sql.queryHashAbsent, hostname: sql.hostname, hostClass: sql.hostClass, port: sql.port, database: sql.database, rolePatternMatch: sql.rolePatternMatch, error: sql.error },
  verdict: configuredTupleValid ? 'CONFIGURED_TUPLE_VALIDATED_NO_NETWORK' : 'HOST_METADATA_UNRESOLVED_OR_INPUT_INVALID',
  checks,
  forbiddenOutputs: ['username', 'password', 'raw URL', 'query/hash', 'token', 'key', 'raw exception'],
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
process.exitCode = configuredTupleValid ? 0 : 2;
