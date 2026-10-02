import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { completePhaseInventory } from './outbox-db-contract.mjs';
import { finalizeSubstep, fixtureChildEnv, platformConfigFor, stagePhaseRunDir } from './outbox-db-contract-mutations.mjs';
import { runPath } from './outbox-run-record.mjs';

const repo = process.cwd();
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const CONTRACT_IDS = ['C00','C01','C02','C03','C04','C05','C06','C07','C08','C08b','C09','D01','D02','D03','D04','D05'];
const POST_MUTATION_IDS = ['M1','M2','M3','M3b','M4','M4b','M5','M5b','M5c','M5d','M6','M6b','M7','M10'];
const REPLAY_REFS = ['ncsngxlcyxylaeskiteu', 'copflsklaefwzipsrjqz'];
const REPLAY_ARTIFACTS = ['catalog-pre.json', 'catalog-post.json', ...REPLAY_REFS.flatMap(ref => [
  `drift-record-${ref}.json`, `catalog-pre-${ref}.json`, `catalog-post-${ref}.json`,
  `pre-readonly-${ref}.json`, `post-readonly-${ref}.json`, `contract-pre-${ref}.txt`, `contract-post-${ref}.txt`,
])];

function phaseInventory(phase) {
  const checks = [...CONTRACT_IDS, 'PIN_BASE_GRANTS', ...(phase === 'post' ? ['PIN_FUNCTIONS', 'PIN_RELATIONS', 'PIN_SCHEMAS_ROLLOUT_ROLES'] : ['PIN_PRE_ABSENCE']), 'PIN_TRIGGERS']
    .map(id => ({ id, verdict: 'PASS' }));
  const mutationIds = phase === 'post' ? POST_MUTATION_IDS : ['M10'];
  const mutations = mutationIds.map(id => ({ id, observed_exit: 1, observed_fail: true, exact_fail: true, restored: 'PASS' }));
  return {
    checks,
    schemaState: phase === 'post' ? { versions: ['20260930040000', '20260930040100', '20260930040200'], inboundHeadsPresent: true } : { versions: [], inboundHeadsPresent: false },
    mutations,
  };
}

function laneEnv(lane, githubEnv) {
  return {
    ...process.env,
    E2E_DISPOSABLE_DATABASE: '1',
    TEST_SUPABASE_URL: 'http://127.0.0.1:55421/',
    E2E_CI_SUPABASE_DB_URL: 'postgresql://postgres:postgres@127.0.0.1:55422/postgres',
    HEAVY_LANE: lane,
    HEAVY_TESTED_SHA: sha,
    GITHUB_ACTIONS: 'true',
    GITHUB_RUN_ID: String(900000000 + process.pid),
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_ENV: githubEnv,
    GITHUB_WORKFLOW_REF: 'bmh/sandra/.github/workflows/inbox-heavy-verification.yml@refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF_NAME: 'main',
  };
}

const dbWithApplicationNames = (...applicationNames) => ({
  query: async () => ({ rows: applicationNames.map(application_name => ({ application_name })) }),
});

const transportWithPostgrestMajor = major => async url => ({
  ok: true,
  status: 200,
  headers: { get: name => new URL(url).pathname === '/rest/v1/' && name === 'x-postgrest-version' ? `PostgREST/${major}.1.0` : null },
  json: async () => ({ version: '2.196.0' }),
});

test('platform config matches SQL PostgREST 16 to HTTP major 16', async () => {
  const result = await platformConfigFor(
    dbWithApplicationNames('PostgREST 16.1.0'),
    transportWithPostgrestMajor(16),
    { apiUrl: 'http://127.0.0.1:55421', anonKey: 'anon', postgresMajor: '16' },
  );
  assert.equal(result.postgrest_major, '16');
  assert.equal(result.postgres_major, '16');
  assert.equal(result.gotrue_major, '2');
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
});

test('platform config rejects SQL and HTTP PostgREST major mismatch', async () => {
  await assert.rejects(
    platformConfigFor(
      dbWithApplicationNames('PostgREST 16.1.0'),
      transportWithPostgrestMajor(15),
      { apiUrl: 'http://127.0.0.1:55421', anonKey: 'anon', postgresMajor: '16' },
    ),
    /PLATFORM_MISMATCH postgrest_major/,
  );
});

test('platform config rejects an unversioned bare PostgREST name', async () => {
  await assert.rejects(
    platformConfigFor(
      dbWithApplicationNames('postgrest'),
      transportWithPostgrestMajor(16),
      { apiUrl: 'http://127.0.0.1:55421', anonKey: 'anon', postgresMajor: '16' },
    ),
    /PLATFORM_MISMATCH postgrest_major/,
  );
});

test('sealed contract run exports the exact relative path for artifact staging', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'contract-stage-env-'));
  try {
    const envFile = path.join(scratch, 'github-env');
    const relative = 'docs/performance/inbox-redesign/evidence/' + 'a'.repeat(40) + '/pre-merge/123';
    stagePhaseRunDir(path.join(scratch, relative), scratch, envFile);
    assert.equal(readFileSync(envFile, 'utf8'), `HEAVY_RUN_DIR=${relative}\n`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('large mutation fixture travels by file, not process environment', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'contract-fixture-env-'));
  try {
    const fixture = { synthetic: 'x'.repeat(3_000_000) };
    const oversized = spawnSync(process.execPath, ['-e', ''], {
      env: { ...process.env, MUTATION_FIXTURE_JSON: JSON.stringify(fixture) },
    });
    assert(oversized.error || oversized.status !== 0, 'negative control: oversized env unexpectedly spawned');

    const env = fixtureChildEnv(process.env, fixture, scratch);
    assert.equal(env.MUTATION_FIXTURE_JSON, undefined);
    const child = spawnSync(process.execPath, ['-e',
      "const fs=require('node:fs'); process.stdout.write(String(JSON.parse(fs.readFileSync(process.env.MUTATION_FIXTURE_PATH)).synthetic.length))"],
      { env, encoding: 'utf8' });
    assert.ifError(child.error);
    assert.equal(child.status, 0);
    assert.equal(child.stdout, '3000000');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('replay sub-step finalization keeps inventory enforcement without sealing or staging', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'contract-replay-finalize-'));
  const githubEnv = path.join(scratch, 'github-env');
  writeFileSync(githubEnv, '');
  try {
    const input = phaseInventory('pre');
    const incomplete = finalizeSubstep({ ...input, phase: 'pre', failure: null, env: laneEnv('drift-replay', githubEnv) });
    assert.equal(incomplete.sealed, null);

    const invalidInput = { ...input, checks: input.checks.slice(1) };
    const failed = finalizeSubstep({ ...invalidInput, phase: 'pre', failure: null, env: laneEnv('drift-replay', githubEnv) });
    assert.equal(failed.sealed, null);
    assert.equal(failed.failure?.message, 'INCOMPLETE_PHASE_INVENTORY');
    assert.equal(readFileSync(githubEnv, 'utf8'), '');
    assert.equal(completePhaseInventory('pre', input.checks, input.schemaState, input.mutations), true);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('db-contract lanes still seal and stage their own phase records', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'contract-owned-finalize-'));
  const githubEnv = path.join(scratch, 'github-env');
  writeFileSync(githubEnv, '');
  const sealCalls = [];
  const stageCalls = [];
  const seal = ({ phase, env, runId }) => {
    sealCalls.push({ phase, lane: env.HEAVY_LANE });
    return { verdict: 'PASS', runDir: path.join(repo, runPath(sha, 'pre-merge', runId)) };
  };
  const stage = (...args) => {
    stageCalls.push(args);
    stagePhaseRunDir(...args);
  };
  try {
    for (const phase of ['pre', 'post']) {
      const runId = `mutations-${phase}-${process.pid}`;
      const env = { ...laneEnv(`db-contract-${phase}`, githubEnv), GITHUB_RUN_ID: runId };
      const input = phaseInventory(phase);
      const result = finalizeSubstep({
        ...input,
        phase,
        failure: null,
        env,
        runId,
        platformConfig: phase === 'pre' ? { postgres_major: '17', sha256: '0'.repeat(64) } : undefined,
        seal,
        stage,
      });
      assert.equal(result.failure, null);
      assert.equal(result.sealed.verdict, 'PASS');
      assert.match(readFileSync(githubEnv, 'utf8'), new RegExp(`HEAVY_RUN_DIR=.*${sha}/pre-merge/${runId}`));
      writeFileSync(githubEnv, '');
    }
    assert.deepEqual(sealCalls, [
      { phase: 'pre', lane: 'db-contract-pre' },
      { phase: 'post', lane: 'db-contract-post' },
    ]);
    assert.equal(stageCalls.length, 2);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('drift replay finalizes both target phases, then the real writer seals the exact inventory', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'contract-replay-lifecycle-'));
  const githubEnv = path.join(scratch, 'github-env');
  const replayWork = path.join(scratch, 'replay-work');
  const isolatedRepo = path.join(scratch, 'repo');
  const runId = String(910000000 + process.pid);
  const env = { ...laneEnv('drift-replay', githubEnv), GITHUB_RUN_ID: runId };
  const relative = runPath(sha, 'pre-merge', runId);
  const runDir = path.join(isolatedRepo, relative);
  writeFileSync(githubEnv, '');
  mkdirSync(replayWork, { recursive: true });
  try {
    execFileSync('git', ['clone', '--no-hardlinks', '--quiet', repo, isolatedRepo], { cwd: repo, stdio: 'ignore' });
    for (const ref of REPLAY_REFS) {
      for (const phase of ['pre', 'post']) {
        const input = phaseInventory(phase);
        const result = finalizeSubstep({
          ...input,
          phase,
          failure: null,
          env,
          platformConfig: phase === 'pre' ? { postgres_major: '17', sha256: '0'.repeat(64) } : undefined,
        });
        assert.equal(result.failure, null);
        assert.equal(result.sealed, null);
      }
    }
    assert.equal(existsSync(path.join(runDir, 'manifest.json')), false);
    assert.equal(existsSync(path.join(runDir, 'contracts.json')), false);
    assert.equal(readFileSync(githubEnv, 'utf8'), '');

    const fixture = JSON.parse(readFileSync(path.join(repo, 'experiments/inbox-production-install/drift/ncsngxlcyxylaeskiteu.items.json'), 'utf8'));
    for (const file of REPLAY_ARTIFACTS) {
      let content = '{}\n';
      if (file === 'drift-record-ncsngxlcyxylaeskiteu.json') content = `${JSON.stringify({ items: fixture.items, sha256: 'a'.repeat(64) })}\n`;
      else if (file.startsWith('drift-record-')) content = `${JSON.stringify({ items: [], sha256: 'b'.repeat(64) })}\n`;
      else if (file.endsWith('.txt')) content = `captured ${file}\n`;
      writeFileSync(path.join(replayWork, file), content);
    }

    const writer = spawnSync(process.execPath, ['scripts/inbox-ci/write-drift-replay-record.mjs', replayWork], { cwd: isolatedRepo, env, encoding: 'utf8' });
    assert.equal(writer.status, 0, `${writer.stdout}\n${writer.stderr}`);
    const manifest = JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.artifacts).sort(), [...REPLAY_ARTIFACTS].sort());
    assert.deepEqual(readdirSync(runDir).sort(), ['manifest.json', ...REPLAY_ARTIFACTS].sort());
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});
