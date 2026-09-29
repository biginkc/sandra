import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { assertWriteMode } from './outbox-db-contract/guards.mjs';

const MUTATIONS = [
  ['M1', 'REVOKE SELECT ON public.messages FROM authenticated', 'GRANT SELECT ON public.messages TO authenticated', ['C01']],
  ['M2', 'ALTER TABLE public.messages DISABLE TRIGGER zzzzz_inbox_message_direct', 'ALTER TABLE public.messages ENABLE TRIGGER zzzzz_inbox_message_direct', ['PIN_TRIGGERS']],
  ['M3', 'ALTER POLICY messages_org_select ON public.messages USING (true)', null, ['D01']],
  ['M3b', 'ALTER POLICY messages_org_insert ON public.messages WITH CHECK (true)', null, ['C00']],
  ['M4', 'ALTER FUNCTION inbox_message_capture.capture() SECURITY INVOKER', 'ALTER FUNCTION inbox_message_capture.capture() SECURITY DEFINER', ['PIN_FUNCTIONS']],
  ['M4b', 'ALTER FUNCTION public.inbox_guard_inbound_revision() SECURITY DEFINER', 'ALTER FUNCTION public.inbox_guard_inbound_revision() SECURITY INVOKER', ['PIN_FUNCTIONS']],
  ['M5', 'GRANT DELETE ON inbox_maintained.queue TO service_role', 'REVOKE DELETE ON inbox_maintained.queue FROM service_role', ['PIN_RELATIONS']],
  ['M5b', 'GRANT EXECUTE ON FUNCTION inbox_maintained.claim_work(integer,integer) TO authenticated', 'REVOKE EXECUTE ON FUNCTION inbox_maintained.claim_work(integer,integer) FROM authenticated', ['PIN_FUNCTIONS']],
  ['M5c', 'ALTER FUNCTION inbox_maintained.enqueue_dirty() SET search_path = public', "ALTER FUNCTION inbox_maintained.enqueue_dirty() SET search_path = ''", ['PIN_FUNCTIONS']],
  ['M5d', 'GRANT SELECT (org_id) ON inbox_maintained.queue TO authenticated', 'REVOKE SELECT (org_id) ON inbox_maintained.queue FROM authenticated', ['PIN_RELATIONS']],
  ['M6', 'ALTER TABLE public.messages DISABLE TRIGGER zzz_inbox_guard_inbound_revision_update', 'ALTER TABLE public.messages ENABLE TRIGGER zzz_inbox_guard_inbound_revision_update', ['PIN_TRIGGERS', 'D04']],
  ['M6b', 'ALTER TABLE public.messages DISABLE TRIGGER inbox_capture_inbound_head', 'ALTER TABLE public.messages ENABLE TRIGGER inbox_capture_inbound_head', ['PIN_TRIGGERS', 'C00']],
  ['M7', 'UPDATE inbox_control.rollout SET serving_enabled=true', 'UPDATE inbox_control.rollout SET serving_enabled=false', ['PIN_SCHEMAS_ROLLOUT_ROLES']],
  ['M10', 'ALTER TABLE public.messages DISABLE ROW LEVEL SECURITY', 'ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY', ['PIN_BASE_GRANTS', 'D01']],
];

function runContract(extra = []) {
  const result = spawnSync(process.execPath, ['scripts/outbox-db-contract.mjs', '--target', 'disposable', '--phase', 'post', ...extra], { encoding: 'utf8', env: process.env, maxBuffer: 20 * 1024 * 1024 });
  const line = result.stdout?.split('\n').find(value => value.startsWith('CONTRACT_RESULT '));
  assert(line, `No contract result: ${result.stderr}\n${result.stdout}`);
  return { exit: result.status, ...JSON.parse(line.slice('CONTRACT_RESULT '.length)) };
}

export async function runMutations(output) {
  assertWriteMode('disposable', { apiUrl: process.env.TEST_SUPABASE_URL, dbUrl: process.env.E2E_CI_SUPABASE_DB_URL, env: process.env });
  const db = new pg.Client({ connectionString: process.env.E2E_CI_SUPABASE_DB_URL });
  await db.connect();
  const results = [];
  try {
    for (const [id, apply, fixedRevert, required] of MUTATIONS) {
      let revert = fixedRevert;
      if (id === 'M3' || id === 'M3b') {
        const column = id === 'M3' ? 'polqual' : 'polwithcheck';
        const name = id === 'M3' ? 'messages_org_select' : 'messages_org_insert';
        const original = (await db.query(`SELECT pg_get_expr(${column}, polrelid) AS expr FROM pg_policy WHERE polname=$1 AND polrelid='public.messages'::regclass`, [name])).rows[0]?.expr;
        assert(original, `${id}: original policy missing`);
        revert = `ALTER POLICY ${name} ON public.messages ${id === 'M3' ? 'USING' : 'WITH CHECK'} (${original})`;
      }
      await db.query(apply);
      let observed, exact;
      try {
        observed = runContract();
        assert.equal(observed.exit, 1, `${id}: mutated run did not fail`);
        assert.equal(observed.verdict, 'FAIL');
        assert(!observed.error || observed.error.startsWith('Error: CONTRACT_FAILURE'), `${id}: ${observed.error}`);
        for (const check of required) assert(observed.failed.includes(check), `${id}: ${check} did not fail; got ${observed.failed}`);
        if (id === 'M10') {
          const contracts = (await import('node:fs')).readFileSync(`${observed.runDir}/contracts.json`, 'utf8');
          assert.match(contracts, /ANON_ROW_EXPOSURE count=[1-9]\d* fixture=true/);
        }
        exact = runContract(['--expect-fail', observed.failed.join(',')]);
        assert.equal(exact.exit, 1, `${id}: --expect-fail must exit nonzero`);
        assert.equal(exact.verdict, 'FAIL');
        assert.equal(exact.error, '', `${id}: expected-fail mismatch: ${exact.error}`);
        assert.deepEqual(new Set(exact.failed), new Set(observed.failed), `${id}: failed IDs drifted`);
      } finally { await db.query(revert); }
      const restored = runContract();
      assert.equal(restored.exit, 0, `${id}: restore run: ${restored.error}; failed=${restored.failed}`);
      assert.equal(restored.verdict, 'PASS');
      results.push({ id, expected_fail: observed.failed, observed_exit: exact.exit, restored: restored.verdict });
      writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
      console.log(`MUTATION ${id} FAIL ${observed.failed.join(',')} RESTORED PASS`);
    }
  } finally { await db.end(); }
  return results;
}

if (process.argv[1]?.endsWith('outbox-db-contract-mutations.mjs')) runMutations(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
