import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const CONTRACT = JSON.parse(readFileSync(new URL('./norma-schema-contract.json', import.meta.url), 'utf8'));
export const LEGACY_EXCLUSION = path.basename(CONTRACT.retry_file);
export function checkEntryEnvironment(env) {
  for (const key of Object.keys(env)) {
    if ((key.startsWith('NORMA_') && key !== 'NORMA_STRESS_SOURCE_DB_URL') || key === 'TEST_SUPABASE_DB_URL' || key.startsWith('PG') || key.startsWith('GIT_') || key.startsWith('DOCKER_')) throw new Error(`External contract override refused: ${key}`);
  }
}
export function checkCheckout(root) {
  assert.deepEqual(CONTRACT.seeds, [101,202,303,404,505]);
  assert.equal(CONTRACT.lifecycles, 80);
  assert.deepEqual(Object.values(CONTRACT.lanes).map(lane => lane.tests), [131,10,20]);
  const actual = readdirSync(path.join(root, 'supabase/migrations')).filter(f => /^\d{14}_norma_.+\.sql$/.test(f)).map(f => `supabase/migrations/${f}`).sort();
  assert.deepEqual(actual, Object.keys(CONTRACT.norma_migrations).sort(), 'Norma migration set drift');
  for (const [file, hash] of Object.entries({...CONTRACT.norma_migrations, ...CONTRACT.unchanged_legacy_sources})) {
    assert.equal(sha256(readFileSync(path.join(root, file))), hash, `Reviewed source drift: ${file}`);
  }
  const legacyFiles = readdirSync(path.join(root,'src/lib/norma/stress')).filter(f => f.endsWith('.integration.test.ts') && f !== 'schema-contract.integration.test.ts').map(f => `src/lib/norma/stress/${f}`).sort();
  assert.deepEqual(legacyFiles, CONTRACT.lanes.legacy.files, 'Legacy test collection drift');
}
export function checkLaneEnvironment(env) {
  const lane = env.NORMA_SCHEMA_CONTRACT_LANE;
  assert.ok(['legacy','postddl','upgrade'].includes(lane), 'Unknown schema contract lane');
  assert.match(env.NORMA_SCHEMA_CONTRACT_RUN_ID ?? '', /^[a-f0-9]{16}$/);
  assert.equal(env.NORMA_STRESS_EXCLUDE_MIGRATIONS ?? '', lane === 'legacy' ? LEGACY_EXCLUSION : '', 'Exclusion-set drift');
  assert.equal(env.NORMA_STRESS_SEED, '101,202,303,404,505', 'Seed override');
  assert.equal(env.NORMA_STRESS_LIFECYCLES, '80', 'Lifecycle override');
  assert.match(env.NORMA_SCHEMA_SOURCE_SHA256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(sha256(readFileSync(env.NORMA_SCHEMA_SOURCE_DUMP)), env.NORMA_SCHEMA_SOURCE_SHA256, 'Dump hash drift');
  assert.ok(env.NORMA_SCHEMA_MANIFEST_DIRECTORY, 'Manifest directory required');
  return lane;
}
export function validateReport(report, lane, root) {
  const expected = CONTRACT.lanes[lane];
  assert.ok(expected, 'Unknown report lane');
  assert.equal(report.success, true, `${lane}: failed suite`);
  for (const field of ['numFailedTests','numPendingTests','numTodoTests']) assert.equal(report[field], 0, `${lane}: ${field}`);
  assert.equal(report.numTotalTests, expected.tests, `${lane}: total count`);
  assert.equal(report.numPassedTests, expected.tests, `${lane}: pass count`);
  assert.deepEqual(report.testResults.map(r => path.relative(root, r.name).replaceAll('\\','/')).sort(), [...expected.files].sort(), `${lane}: file collection`);
  const assertions = report.testResults.flatMap(r => r.assertionResults);
  assert.equal(assertions.length, expected.tests, `${lane}: assertion count`);
  assert.ok(assertions.every(r => r.status === 'passed'), `${lane}: skipped/failed assertion`);
  if (lane === 'legacy') {
    const names = assertions.map(r => r.fullName);
    for (const seed of CONTRACT.seeds) assert.equal(names.filter(name => name.includes(`seed ${seed}: 80 lifecycles`)).length, 1, `Missing seed ${seed}`);
  }
  return {tests: expected.tests, files: expected.files, allAssertionsPassed: true};
}
export async function schemaCatalog(client) {
  const r = await client.query(`select
    to_regclass('public.norma_call_requests') is not null as requests,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='norma_call_requests' and column_name='attempt') as attempt,
    to_regprocedure('public.fn_norma_claim_dispatch(uuid)') is not null as legacy_claim,
    to_regprocedure('public.fn_norma_claim_dispatch(uuid,integer)') is not null as attempt_claim`);
  return r.rows[0];
}
export function checkSchema(catalog, lane) {
  if (lane === 'source' || lane === 'upgrade-source') assert.deepEqual(catalog, {requests:false, attempt:false, legacy_claim:false, attempt_claim:false}, 'Source is not pre-Norma');
  else if (lane === 'legacy') assert.deepEqual(catalog, {requests:true, attempt:false, legacy_claim:true, attempt_claim:false}, 'Legacy schema/signature mismatch');
  else assert.deepEqual(catalog, {requests:true, attempt:true, legacy_claim:false, attempt_claim:true}, 'Post-DDL schema/signature mismatch');
}
export function writeManifest(file, receipt) { writeFileSync(file, JSON.stringify(receipt,null,2)+'\n', {mode:0o600}); }
export function ownDatabase(name, runId) { return new RegExp(`^norma_schema_${runId}_[a-z0-9_]+$`).test(name) && /^[a-z0-9_]{1,63}$/.test(name); }

// Subprocesses receive no ambient database, Git, Docker or provider settings.
export function subprocessEnvironment(env=process.env) {
  const clean={};
  for (const key of ['PATH','HOME','TMPDIR','TEMP','LANG','LC_ALL','SYSTEMROOT']) if (env[key]) clean[key]=env[key];
  return {...clean, NODE_ENV:/** @type {'test'} */ ('test'), GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null'};
}
export function validateUpgradeCases(cases, report) {
  const assertions=report.testResults.flatMap(r=>r.assertionResults);
  const expected=assertions.map(a=>[...a.ancestorTitles,a.title].join(' > '));
  assert.equal(expected.length,20,'Upgrade assertion count');
  assert.equal(new Set(expected).size,20,'Duplicate upgrade assertion identity');
  assert.equal(cases.length,20,'Missing per-case upgrade manifests');
  assert.equal(new Set(cases.map(c=>c.test)).size,20,'Duplicate upgrade case receipt');
  assert.deepEqual(cases.map(c=>c.test).sort(),expected.sort(),'Upgrade case identities do not match collected assertions');
}
