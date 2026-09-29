import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { assertEmbedding, assertExactIds, assertMetrics } from './contracts.mjs';
import { completePhaseInventory, sealPhaseRecord } from '../outbox-db-contract.mjs';

test('C01 rejects a broken embedded contact', () => {
  const base = { property: { id: 'p', address: '1 Lane', city: 'Kansas City', state: 'MO' }, contact: { id: 'c', first_name: 'A', last_name: 'B', entity_name: null, phone_1: '+18165550000' } };
  const message = { id: 'm', body: 'x', from_address: 'a', to_address: 'b', created_at: 'now', scheduled_for: 'later', property_id: 'p', contact_id: 'c', property: base.property, contact: { ...base.contact, first_name: 'WRONG' } };
  assert.throws(() => assertEmbedding(message, base), /deep-equal/);
});

test('C02 rejects a substituted row with the same cardinality', () => {
  assert.throws(() => assertExactIds([{ id: 'a' }, { id: 'substitute' }], [{ id: 'a' }, { id: 'b' }]), /deep-equal/);
});

test('C04 rejects wrong queued count and paused count', () => {
  assert.throws(() => assertMetrics({ queued: 8, paused: 1 }, 9), /8 !== 9/);
  assert.throws(() => assertMetrics({ queued: 9, paused: 2 }, 9), /2 !== 1/);
});

const C_IDS = ['C00','C01','C02','C03','C04','C05','C06','C07','C08','C08b','C09','D01','D02','D03','D04','D05'];
const PIN_IDS = ['PIN_BASE_GRANTS','PIN_FUNCTIONS','PIN_RELATIONS','PIN_SCHEMAS_ROLLOUT_ROLES','PIN_TRIGGERS'];
const M_IDS = ['M1','M2','M3','M3b','M4','M4b','M5','M5b','M5c','M5d','M6','M6b','M7','M10'];
const completePost = () => ({
  checks: [...C_IDS, ...PIN_IDS].map(id => ({ id, verdict: 'PASS' })),
  schemaState: { versions: ['20260930020000','20260930020100','20260930020200'], inboundHeadsPresent: true },
  mutations: M_IDS.map(id => ({ id, observed_exit: 1, observed_fail: true, exact_fail: true, restored: 'PASS' })),
});

test('complete post inventory passes, and every required clause rejects a counterexample', () => {
  const baseline = completePost();
  assert.equal(completePhaseInventory('post', baseline.checks, baseline.schemaState, baseline.mutations), true);
  const fails = variant => assert.equal(completePhaseInventory('post', variant.checks, variant.schemaState, variant.mutations), false);
  fails({ ...baseline, mutations: baseline.mutations.slice(1) });
  fails({ ...baseline, mutations: [...baseline.mutations, { ...baseline.mutations[0], id: 'EXTRA' }] });
  fails({ ...baseline, mutations: [...baseline.mutations.slice(1), baseline.mutations[1]] });
  for (const [field, value] of [['restored','FAIL'],['observed_fail',false],['exact_fail',false]]) {
    fails({ ...baseline, mutations: [{ ...baseline.mutations[0], [field]: value }, ...baseline.mutations.slice(1)] });
  }
  fails({ ...baseline, checks: [...baseline.checks, baseline.checks[0]] });
  fails({ ...baseline, checks: [{ ...baseline.checks[0], verdict: 'FAIL' }, ...baseline.checks.slice(1)] });
  fails({ ...baseline, schemaState: { ...baseline.schemaState, inboundHeadsPresent: false } });
  fails({ ...baseline, schemaState: { ...baseline.schemaState, versions: baseline.schemaState.versions.slice(1) } });
  fails({ ...baseline, checks: baseline.checks.slice(1) });
  fails({ ...baseline, mutations: [{ ...baseline.mutations[0], observed_exit: 0 }, ...baseline.mutations.slice(1)] });
  const pre = { checks: [...C_IDS, 'PIN_BASE_GRANTS','PIN_PRE_ABSENCE','PIN_TRIGGERS'].map(id => ({ id, verdict: 'PASS' })), schemaState: { versions: [], inboundHeadsPresent: false }, mutations: [baseline.mutations.at(-1)] };
  assert.equal(completePhaseInventory('pre', pre.checks, pre.schemaState, pre.mutations), true);
  assert.equal(completePhaseInventory('pre', pre.checks, pre.schemaState, [baseline.mutations[0]]), false);
  assert.equal(completePhaseInventory('pre', pre.checks, pre.schemaState, [...pre.mutations, baseline.mutations[0]]), false);
});

test('sealer downgrades incomplete PASS to FAIL', () => {
  const baseline = completePost();
  const env = { E2E_DISPOSABLE_DATABASE: '1', TEST_SUPABASE_URL: 'http://127.0.0.1:55421/', E2E_CI_SUPABASE_DB_URL: 'postgresql://postgres:postgres@127.0.0.1:55422/postgres', HEAVY_LANE: 'db-contract-post' };
  const runId = `w4w_inventory_${process.pid}`;
  const result = sealPhaseRecord({ phase: 'post', ...baseline, mutations: baseline.mutations.slice(1), verdict: 'PASS', env, runId });
  try {
    assert.equal(result.verdict, 'FAIL');
    const manifest = JSON.parse(readFileSync(path.join(result.runDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.exit_status, 1);
    assert.equal(manifest.failure, 'INCOMPLETE_PHASE_INVENTORY');
    assert.deepEqual(Object.keys(manifest.clean_tree).sort(), ['end_excluding_run_dir', 'end_status', 'excluded_path', 'start']);
    assert.equal(manifest.clean_tree.start, true);
    assert.equal(manifest.clean_tree.end_excluding_run_dir, true);
    assert.equal(manifest.clean_tree.excluded_path, `docs/performance/inbox-redesign/evidence/${manifest.tested_sha}/pre-merge/${runId}`);
  } finally { rmSync(result.runDir, { recursive: true, force: true }); }
});

test('failure injection hook has no side effects other than throwing', () => {
  const source = readFileSync(new URL('../outbox-db-contract-mutations.mjs', import.meta.url), 'utf8');
  assert.match(source, /const inject = step => \{\s*if \(process\.env\.HEAVY_LOCAL_FAILURE_INJECTION === '1' && process\.env\.OUTBOX_INJECT_AT === step\) throw new Error\(`INJECTED_ORCHESTRATION_FAILURE \$\{step\}`\);\s*\};/);
});
