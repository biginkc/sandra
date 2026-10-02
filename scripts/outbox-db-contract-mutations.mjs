import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { assertWriteMode } from './outbox-db-contract/guards.mjs';
import { makeRest } from './outbox-db-contract/postgrest.mjs';
import { createFixture } from './outbox-db-contract/fixture.mjs';
import { sealPhaseRecord } from './outbox-db-contract.mjs';
import { platformFingerprint } from './outbox-db-contract/platform.mjs';
import { readPostgrestMajor } from './outbox-db-contract/readonly.mjs';

const MUTATIONS = [
  ['M1', 'REVOKE SELECT ON public.messages FROM authenticated', 'GRANT SELECT ON public.messages TO authenticated', ['PIN_BASE_GRANTS', 'C00', 'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C08b', 'C09', 'D02', 'D03']],
  ['M2', 'ALTER TABLE public.messages DISABLE TRIGGER zzzzz_inbox_message_direct', 'ALTER TABLE public.messages ENABLE TRIGGER zzzzz_inbox_message_direct', ['PIN_TRIGGERS', 'C00', 'C05', 'C06', 'C07', 'C08', 'C08b']],
  // The policy is TO authenticated, so anon D01 cannot change; tenant reads and D02/D03 do.
  ['M3', 'ALTER POLICY messages_org_select ON public.messages USING (true)', null, ['C01', 'C02', 'C03', 'D02', 'D03']],
  // Other INSERT/UPDATE policy predicates leave C00's O2 insert denied; D02/D03 detect the widened path.
  ['M3b', 'ALTER POLICY messages_org_insert ON public.messages WITH CHECK (true)', null, ['D02', 'D03']],
  ['M4', 'ALTER FUNCTION inbox_message_capture.capture() SECURITY INVOKER', 'ALTER FUNCTION inbox_message_capture.capture() SECURITY DEFINER', ['PIN_FUNCTIONS', 'C00', 'C05', 'C06', 'C07', 'C08', 'C08b']],
  ['M4b', 'ALTER FUNCTION public.inbox_guard_inbound_revision() SECURITY DEFINER', 'ALTER FUNCTION public.inbox_guard_inbound_revision() SECURITY INVOKER', ['PIN_FUNCTIONS', 'D04']],
  ['M5', 'GRANT DELETE ON inbox_maintained.queue TO service_role', 'REVOKE DELETE ON inbox_maintained.queue FROM service_role', ['PIN_RELATIONS']],
  ['M5b', 'GRANT EXECUTE ON FUNCTION inbox_maintained.claim_work(integer,integer) TO authenticated', 'REVOKE EXECUTE ON FUNCTION inbox_maintained.claim_work(integer,integer) FROM authenticated', ['PIN_FUNCTIONS']],
  ['M5c', 'ALTER FUNCTION inbox_maintained.enqueue_dirty() SET search_path = public', "ALTER FUNCTION inbox_maintained.enqueue_dirty() SET search_path = ''", ['PIN_FUNCTIONS']],
  ['M5d', 'GRANT SELECT (org_id) ON inbox_maintained.queue TO authenticated', 'REVOKE SELECT (org_id) ON inbox_maintained.queue FROM authenticated', ['PIN_RELATIONS']],
  ['M6', 'ALTER TABLE public.messages DISABLE TRIGGER zzz_inbox_guard_inbound_revision_update', 'ALTER TABLE public.messages ENABLE TRIGGER zzz_inbox_guard_inbound_revision_update', ['PIN_TRIGGERS', 'D04']],
  ['M6b', 'ALTER TABLE public.messages DISABLE TRIGGER inbox_capture_inbound_head', 'ALTER TABLE public.messages ENABLE TRIGGER inbox_capture_inbound_head', ['PIN_TRIGGERS', 'C00']],
  ['M7', 'UPDATE inbox_control.rollout SET serving_enabled=true', 'UPDATE inbox_control.rollout SET serving_enabled=false', ['PIN_SCHEMAS_ROLLOUT_ROLES']],
  // Disabling RLS also changes pagination and tenant/revocation denials; all are pinned.
  ['M10', 'ALTER TABLE public.messages DISABLE ROW LEVEL SECURITY', 'ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY', ['PIN_BASE_GRANTS', 'C00', 'C01', 'C02', 'C03', 'D01', 'D02', 'D03'], ['pre', 'post']],
];

export function fixtureChildEnv(baseEnv, fixture, scratch) {
  const { MUTATION_FIXTURE_JSON: ignored, ...env } = baseEnv;
  env.OUTBOX_CONTRACT_SCRATCH_DIR = scratch;
  if (fixture) {
    const file = path.join(scratch, 'mutation-fixture.json');
    writeFileSync(file, JSON.stringify(fixture), { mode: 0o600 });
    env.MUTATION_FIXTURE_PATH = file;
  }
  return env;
}

export function stagePhaseRunDir(runDir, repoRoot, githubEnv) {
  appendFileSync(githubEnv, `HEAVY_RUN_DIR=${path.relative(repoRoot, runDir)}\n`);
}

function runContract(phase, extra = [], fixture = null) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'w4w-contract-step-'));
  const env = fixtureChildEnv(process.env, fixture, scratch);
  try {
    const result = spawnSync(process.execPath, ['scripts/outbox-db-contract.mjs', '--target', 'disposable', '--phase', phase, ...extra], { encoding: 'utf8', env, maxBuffer: 20 * 1024 * 1024 });
    const line = result.stdout?.split('\n').find(value => value.startsWith('CONTRACT_RESULT '));
    assert(line, `No contract result: spawn=${result.error?.stack ?? 'none'} status=${result.status} signal=${result.signal} stderr=${result.stderr} stdout=${result.stdout}`);
    const parsed = JSON.parse(line.slice('CONTRACT_RESULT '.length));
    const contracts = JSON.parse(readFileSync(path.join(scratch, 'contracts.json'), 'utf8'));
    const fixtureRows = !fixture && result.status === 0 ? readFileSync(path.join(scratch, 'fixture-rows.json')) : undefined;
    return { exit: result.status, ...parsed, contracts, fixtureRows };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export async function platformConfigFor(db, transport, { apiUrl, anonKey, postgresMajor }) {
  const { postgrest_major: postgrestMajor, postgrest_reason: postgrestReason, postgrest_observed_major: postgrestObservedMajor } = await readPostgrestMajor(db);
  return platformFingerprint(apiUrl, anonKey, postgresMajor, transport, { postgrestMajor, postgrestReason, postgrestObservedMajor });
}

async function prepareFixture() {
  const runDir = mkdtempSync(path.join(os.tmpdir(), 'w4w-fixture-'));
  try {
    const rest = makeRest(process.env.TEST_SUPABASE_URL, process.env.TEST_SUPABASE_ANON_KEY, process.env.TEST_SUPABASE_SERVICE_ROLE_KEY);
    const fixture = await createFixture({ apiUrl: process.env.TEST_SUPABASE_URL, serviceKey: process.env.TEST_SUPABASE_SERVICE_ROLE_KEY, anonKey: process.env.TEST_SUPABASE_ANON_KEY, rest, runDir });
    delete fixture.rest;
    return fixture;
  } finally { rmSync(runDir, { recursive: true, force: true }); }
}

export async function runMutations(output, phase) {
  assert(['pre', 'post'].includes(phase), 'Usage: outbox-db-contract-mutations.mjs <output> --phase pre|post');
  assertWriteMode('disposable', { apiUrl: process.env.TEST_SUPABASE_URL, dbUrl: process.env.E2E_CI_SUPABASE_DB_URL, env: process.env });
  const db = new pg.Client({ connectionString: process.env.E2E_CI_SUPABASE_DB_URL });
  const results = [];
  const inject = step => {
    if (process.env.HEAVY_LOCAL_FAILURE_INJECTION === '1' && process.env.OUTBOX_INJECT_AT === step) throw new Error(`INJECTED_ORCHESTRATION_FAILURE ${step}`);
  };
  let baseline;
  let readonlyRehearsal;
  let failure;
  try {
    await db.connect();
    baseline = runContract(phase);
    assert.equal(baseline.exit, 0, `baseline: ${baseline.error}`);
    assert.equal(baseline.verdict, 'PASS');
    inject('after-baseline');
    for (const [id, apply, fixedRevert, expected] of MUTATIONS.filter(item => (item[4] ?? ['post']).includes(phase))) {
      let revert = fixedRevert;
      if (id === 'M3' || id === 'M3b') {
        const column = id === 'M3' ? 'polqual' : 'polwithcheck';
        const name = id === 'M3' ? 'messages_org_select' : 'messages_org_insert';
        const original = (await db.query(`SELECT pg_get_expr(${column}, polrelid) AS expr FROM pg_policy WHERE polname=$1 AND polrelid='public.messages'::regclass`, [name])).rows[0]?.expr;
        assert(original, `${id}: original policy missing`);
        revert = `ALTER POLICY ${name} ON public.messages ${id === 'M3' ? 'USING' : 'WITH CHECK'} (${original})`;
      }
      let observed, exact;
      let anonRowExposure = null;
      for (const mode of ['observe', 'exact']) {
        const fixture = await prepareFixture();
        inject(`${id}:${mode}:fixture`);
        await db.query(apply);
        try {
          inject(`${id}:${mode}:ddl`);
          if (mode === 'observe') observed = runContract(phase, [], fixture);
          else exact = runContract(phase, ['--expect-fail', expected.join(',')], fixture);
          if (mode === 'observe') {
            assert.equal(observed.exit, 1, `${id}: mutated run did not fail`);
            assert.equal(observed.verdict, 'FAIL');
            assert(!observed.error || observed.error.startsWith('Error: CONTRACT_FAILURE'), `${id}: ${observed.error}`);
            assert.deepEqual([...observed.failed].sort(), [...expected].sort(), `${id}: observed failures differ from pinned set`);
            if (id === 'M10') {
              const detail = observed.contracts.find(check => check.id === 'D01')?.error ?? '';
              const match = detail.match(/^ANON_ROW_EXPOSURE count=([1-9]\d*) fixture=true$/);
              assert(match, `${id}: anon did not read its own fixture row`);
              anonRowExposure = { count: Number(match[1]), fixture: true };
            }
          } else {
            assert.equal(exact.exit, 1, `${id}: --expect-fail must exit nonzero`);
            assert.equal(exact.verdict, 'FAIL');
            assert.equal(exact.error, '', `${id}: expected-fail mismatch: ${exact.error}`);
            assert.deepEqual([...exact.failed].sort(), [...expected].sort(), `${id}: failed IDs drifted`);
          }
        } finally { await db.query(revert); }
        inject(`${id}:${mode}:restored-ddl`);
      }
      const restored = runContract(phase);
      assert.equal(restored.exit, 0, `${id}: restore run: ${restored.error}; failed=${restored.failed}`);
      assert.equal(restored.verdict, 'PASS');
      inject(`${id}:restored-contract`);
      results.push({ id, expected_fail: expected, observed_exit: exact.exit, observed_fail: observed.verdict === 'FAIL', exact_fail: exact.verdict === 'FAIL', restored: restored.verdict, ...(anonRowExposure ? { anon_row_exposure: anonRowExposure } : {}) });
      writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
      console.log(`MUTATION ${id} FAIL ${observed.failed.join(',')} RESTORED PASS`);
      inject(`${id}:recorded`);
    }
    inject('aggregate');
    if (process.env.HEAVY_LANE === `db-contract-${phase}`) {
      const rehearsalFile = `${output}.readonly-rehearsal.json`;
      const fixtureFile = `${output}.fixture-rows.json`;
      writeFileSync(fixtureFile, baseline.fixtureRows);
      const pre = phase === 'post' ? ['--pre-file', process.env.HEAVY_PRE_READONLY_OUTPUT ?? ''] : [];
      const scope = phase === 'post' ? ['--org', process.env.HEAVY_REHEARSAL_ORG ?? ''] : ['--fixture-rows', fixtureFile];
      const rehearsal = spawnSync(process.execPath, ['scripts/inbox-ci/rehearse-readonly.mjs','--phase',phase,...scope,'--record',rehearsalFile,...pre], { encoding:'utf8', env:process.env, maxBuffer:20*1024*1024 });
      assert.equal(rehearsal.status, 0, `readonly rehearsal: ${rehearsal.stderr}`);
      readonlyRehearsal = JSON.parse(readFileSync(rehearsalFile));
    }
  } catch (error) { failure = error; }
  finally {
    let platformConfig;
    if (!failure && phase === 'pre') {
      try {
        const version = (await db.query('SHOW server_version_num')).rows[0].server_version_num;
        await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        platformConfig = await platformConfigFor(db, undefined, {
          apiUrl: process.env.TEST_SUPABASE_URL,
          anonKey: process.env.TEST_SUPABASE_ANON_KEY,
          postgresMajor: String(Math.floor(Number(version) / 10000)),
        });
        await db.query('COMMIT');
      } catch (error) { await db.query('ROLLBACK').catch(() => {}); failure = error; }
    }
    await db.end();
    const checks = baseline?.contracts ?? [];
    const fixtureRows = baseline?.fixtureRows;
    const sealed = sealPhaseRecord({ phase, checks, schemaState: baseline?.schemaState, mutations: results, fixtureRows, platformConfig, readonlyRehearsal, verdict: failure ? 'FAIL' : 'PASS', errorText: failure ? String(failure.stack ?? failure) : '' });
    if (process.env.GITHUB_ACTIONS === 'true') stagePhaseRunDir(sealed.runDir, process.cwd(), process.env.GITHUB_ENV);
    if (sealed.verdict !== 'PASS' && !failure) failure = new Error('INCOMPLETE_PHASE_INVENTORY');
  }
  if (failure) throw failure;
  return results;
}

if (process.argv[1]?.endsWith('outbox-db-contract-mutations.mjs')) runMutations(process.argv[2], process.argv[3] === '--phase' ? process.argv[4] : null).catch(error => { console.error(error); process.exitCode = 1; });
