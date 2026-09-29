import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { artifactHashes, assertCleanStart, assertOnlyRunDirDirty, buildOutboxIdentityEnvironment, executeOutboxRun, isGitHubE2ERun, recordOutboxResult, runPath, sha256, validateOutboxResults, writeManifest } from './outbox-run-record.mjs';
import { ensureE2ERunEnvironment } from '../src/lib/supabase/e2e-identity-guard.ts';
test('GitHub Outbox identity matches the real E2E guard', () => {
  assert.throws(() => ensureE2ERunEnvironment({ GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '36550350156', GITHUB_RUN_ATTEMPT: '2', E2E_RUN_SLUG: 'local-123-abcdef123456', E2E_TEST_USER_EMAIL: 'e2e-ci+local-123-abcdef123456@bmhgroupkc.com', E2E_TEST_USER_PASSWORD: 'x'.repeat(32) }), /does not match this run ID and attempt/);
  const env = buildOutboxIdentityEnvironment({ GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '36550350156', GITHUB_RUN_ATTEMPT: '2' });
  assert.equal(env.E2E_RUN_SLUG, 'gha-36550350156-2');
  assert.equal(env.E2E_TEST_USER_EMAIL, 'e2e-ci+gha-36550350156-2@bmhgroupkc.com');
  assert.doesNotThrow(() => ensureE2ERunEnvironment(env));
});
test('CI=1 takes the same GitHub identity path as the real guard', () => {
  const env = buildOutboxIdentityEnvironment({ CI: '1', GITHUB_RUN_ID: '36550350156', GITHUB_RUN_ATTEMPT: '3' });
  assert.equal(env.E2E_RUN_SLUG, 'gha-36550350156-3');
  assert.doesNotThrow(() => ensureE2ERunEnvironment(env));
});
test('producer rejects malformed GitHub run ID and attempt itself', () => {
  const validIdentity = () => ({ runSlug: 'gha-36550350156-2', email: 'e2e-ci+gha-36550350156-2@bmhgroupkc.com', password: 'x'.repeat(32) });
  assert.throws(() => buildOutboxIdentityEnvironment({ GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: 'bad', GITHUB_RUN_ATTEMPT: '2' }, validIdentity), /numeric GITHUB_RUN_ID/);
  assert.throws(() => buildOutboxIdentityEnvironment({ GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '36550350156', GITHUB_RUN_ATTEMPT: 'bad' }, validIdentity), /numeric GITHUB_RUN_ATTEMPT/);
});
test('missing or mislabelled HEAVY_PHASE stops before Playwright and record creation', async () => {
  for (const phase of [undefined, 'post-mislabeled']) {
    let called = false;
    await assert.rejects(executeOutboxRun({ repo: '.', relativeDir: 'unused', sha: 'a'.repeat(40), tier: 'pre-merge', runId: 'unused', startedAt: new Date().toISOString(), baseEnv: { HEAVY_PHASE: phase }, playwright: () => { called = true; }, record: () => { called = true; } }), /HEAVY_PHASE/);
    assert.equal(called, false);
  }
});
test('CI=1 without GITHUB_ACTIONS runs both identity lifecycle steps', async () => {
  const env = buildOutboxIdentityEnvironment({ CI: '1', GITHUB_RUN_ID: '36550350156', GITHUB_RUN_ATTEMPT: '3', HEAVY_PHASE: 'pre' });
  assert.equal(isGitHubE2ERun(env), true);
  const steps = [];
  let recorded;
  await executeOutboxRun({ repo: '.', baseEnv: env, relativeDir: 'unused', sha: 'a'.repeat(40), tier: 'pre-merge', runId: 'unused', startedAt: new Date().toISOString(),
    identity: () => ({ ...env, RUNNER_TEMP: '/tmp' }), startProxy: () => ({}), ready: () => {}, stop: () => {},
    lifecycle: step => steps.push(step),
    playwright: () => ({ status: 0, stdout: '{}', stderr: '' }),
    record: fields => { recorded = fields; return 0; },
  });
  assert.deepEqual(steps, ['preflight', 'cleanup']);
  assert.equal(recorded.cleanupError, undefined);
});
test('preflight failure reaches the recorder', async () => {
  const env = { CI: '1', RUNNER_TEMP: '/tmp', HEAVY_PHASE: 'pre' };
  let recorded;
  await executeOutboxRun({ repo: '.', baseEnv: env, relativeDir: 'unused', sha: 'a'.repeat(40), tier: 'pre-merge', runId: 'unused', startedAt: new Date().toISOString(),
    identity: () => env, startProxy: () => ({}), ready: () => {}, stop: () => {},
    lifecycle: step => { if (step === 'preflight') throw new Error('injected inventory failure'); },
    playwright: () => { throw new Error('Playwright must not run'); },
    record: fields => { recorded = fields; return 1; },
  });
  assert.match(recorded.failures.join('\n'), /preflight.*injected inventory failure/);
});
test('each lifecycle failure seals exactly one stage-named FAIL and exits non-zero', async () => {
  const stages = [
    ['identity preflight', { lifecycle: step => { if (step === 'preflight') throw new Error('injected inventory failure'); } }],
    ['identity emit', { identity: () => { throw new Error('injected emission failure'); } }],
    ['proxy start', { startProxy: () => { throw new Error('injected spawn error'); } }],
    ['Playwright spawn', { playwright: () => { throw new Error('injected spawn error'); } }],
    ['Playwright failed', { playwright: () => ({ status: 9, stdout: '', stderr: 'injected non-zero' }) }],
    ['Exact-run cleanup', { lifecycle: step => { if (step === 'cleanup') throw new Error('injected cleanup failure'); } }],
    ['proxy cleanup', { stop: () => { throw new Error('injected proxy cleanup failure'); } }],
  ];
  for (const [name, injection] of stages) {
    const dir = repo();
    mkdirSync(path.join(dir, 'scripts/inbox-ci'), { recursive: true });
    mkdirSync(path.join(dir, 'e2e/inbox-acceptance'), { recursive: true });
    writeFileSync(path.join(dir, 'scripts/inbox-ci/outbox-pre.sh'), '#!/bin/sh\n');
    writeFileSync(path.join(dir, 'e2e/inbox-acceptance/fault-proxy.mjs'), '// proxy\n');
    execFileSync('git', ['-C', dir, 'add', '.']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'record fixtures']);
    const sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const runId = name.replaceAll(' ', '-');
    const relativeDir = runPath(sha, 'pre-merge', runId);
    const full = path.join(dir, relativeDir);
    mkdirSync(full, { recursive: true });
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: `O${String(i + 1).padStart(2, '0')}`, status: 'pass' }));
    const passed = () => ({ status: 'expected', results: [{ retry: 0, status: 'passed' }] });
    const results = { stats: { expected: 8, skipped: 0, unexpected: 0, flaky: 0 }, suites: [{ specs: Array.from({ length: 8 }, () => ({ tests: [passed()] })) }] };
    writeFileSync(path.join(full, 'row-results.json'), JSON.stringify(rows));
    let records = 0;
    const invokedSteps = [];
    const defaults = {
      identity: env => ({ ...env, E2E_RUN_SLUG: 'gha-test', RUNNER_TEMP: dir }),
      lifecycle: step => invokedSteps.push(step), startProxy: () => ({}), ready: () => {}, stop: () => {},
      playwright: () => ({ status: 0, stdout: JSON.stringify(results), stderr: '' }),
    };
    const exitStatus = await executeOutboxRun({ repo: dir, relativeDir, sha, tier: 'pre-merge', runId, startedAt: new Date().toISOString(), baseEnv: { CI: '1', HEAVY_LANE: 'outbox-pre', HEAVY_PHASE: 'pre' }, ...defaults, ...injection, record: fields => { records++; return recordOutboxResult(fields); } });
    const manifest = JSON.parse(readFileSync(path.join(full, 'manifest.json'), 'utf8'));
    assert.equal(records, 1, name);
    assert.equal(manifest.verdict, 'FAIL', name);
    assert.notEqual(exitStatus, 0, name);
    assert.notEqual(manifest.exit_status, 0, name);
    assert.match(readFileSync(path.join(full, 'validation.log'), 'utf8'), new RegExp(name, 'i'));
    if (name === 'Playwright spawn' || name === 'Playwright failed') assert.deepEqual(invokedSteps, ['preflight', 'cleanup'], name);
  }
});
test('cleanup failure after Playwright seals a FAIL record and returns non-zero', async () => {
  const dir = repo();
  mkdirSync(path.join(dir, 'scripts/inbox-ci'), { recursive: true });
  mkdirSync(path.join(dir, 'e2e/inbox-acceptance'), { recursive: true });
  writeFileSync(path.join(dir, 'scripts/inbox-ci/outbox-pre.sh'), '#!/bin/sh\n');
  writeFileSync(path.join(dir, 'e2e/inbox-acceptance/fault-proxy.mjs'), '// proxy\n');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'record fixtures']);
  const sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const relative = runPath(sha, 'pre-merge', 'cleanup-failure');
  const full = path.join(dir, relative);
  mkdirSync(full, { recursive: true });
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: `O${String(i + 1).padStart(2, '0')}`, status: 'pass' }));
  const passed = () => ({ status: 'expected', results: [{ retry: 0, status: 'passed' }] });
  const results = { stats: { expected: 8, skipped: 0, unexpected: 0, flaky: 0 }, suites: [{ specs: Array.from({ length: 8 }, () => ({ tests: [passed()] })) }] };
  writeFileSync(path.join(full, 'row-results.json'), JSON.stringify(rows));
  const env = { CI: '1', GITHUB_RUN_ID: '36550350156', GITHUB_RUN_ATTEMPT: '3', HEAVY_LANE: 'outbox-pre', HEAVY_PHASE: 'pre' };
  const exitStatus = await executeOutboxRun({ repo: dir, relativeDir: relative, sha, tier: 'pre-merge', runId: 'cleanup-failure', startedAt: new Date().toISOString(), baseEnv: env,
    identity: value => ({ ...value, E2E_RUN_SLUG: 'gha-test', RUNNER_TEMP: dir }), startProxy: () => ({}), ready: () => {}, stop: () => {},
    lifecycle: step => { if (step === 'cleanup') throw new Error('injected exact-run cleanup failure'); },
    playwright: () => ({ status: 0, stdout: JSON.stringify(results), stderr: '' }),
  });
  const manifest = JSON.parse(readFileSync(path.join(full, 'manifest.json'), 'utf8'));
  assert.equal(manifest.verdict, 'FAIL');
  assert.notEqual(manifest.exit_status, 0);
  assert.notEqual(exitStatus, 0);
  assert.equal(manifest.cleanup_failure, true);
  assert.match(readFileSync(path.join(full, 'validation.log'), 'utf8'), /Exact-run cleanup failed/);
  assert.ok(existsSync(path.join(full, 'results.json')));
  assert.equal(manifest.artifacts['results.json'], sha256(readFileSync(path.join(full, 'results.json'))));
});
test('recorder rejects a non-zero Playwright status without stage failures', () => {
  const dir = repo();
  mkdirSync(path.join(dir, 'scripts/inbox-ci'), { recursive: true });
  mkdirSync(path.join(dir, 'e2e/inbox-acceptance'), { recursive: true });
  writeFileSync(path.join(dir, 'scripts/inbox-ci/outbox-pre.sh'), '#!/bin/sh\n');
  writeFileSync(path.join(dir, 'e2e/inbox-acceptance/fault-proxy.mjs'), '// proxy\n');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'record fixtures']);
  const sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const relativeDir = runPath(sha, 'pre-merge', 'nonzero-gate');
  mkdirSync(path.join(dir, relativeDir), { recursive: true });
  const exitStatus = recordOutboxResult({ repo: dir, relativeDir, sha, tier: 'pre-merge', runId: 'nonzero-gate', startedAt: new Date().toISOString(), env: { HEAVY_LANE: 'outbox-pre', HEAVY_PHASE: 'pre' }, result: { status: 9, stdout: '', stderr: '' }, failures: [] });
  const manifest = JSON.parse(readFileSync(path.join(dir, relativeDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.verdict, 'FAIL');
  assert.equal(manifest.exit_status, 9);
  assert.equal(exitStatus, 9);
});
test('local Outbox identity stays local and satisfies the real E2E guard', () => {
  const env = buildOutboxIdentityEnvironment({});
  assert.match(env.E2E_RUN_SLUG, /^local-[1-9][0-9]*-[a-f0-9]{12}$/);
  assert.doesNotThrow(() => ensureE2ERunEnvironment(env));
});
function repo() { const dir = mkdtempSync(path.join(tmpdir(), 'outbox-record-')); execFileSync('git', ['init', '-q', dir]); execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.invalid']); execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']); writeFileSync(path.join(dir, 'tracked'), 'baseline'); execFileSync('git', ['-C', dir, 'add', '.']); execFileSync('git', ['-C', dir, 'commit', '-qm', 'baseline']); return dir; }
test('layout and artifact hashes', () => { const dir = repo(); const sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim(); const relative = runPath(sha, 'pre-merge', 'run_1'); const full = path.join(dir, relative); mkdirSync(full, {recursive:true}); writeFileSync(path.join(full,'results.json'), 'hello'); assert.deepEqual(artifactHashes(full), {'results.json':'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'}); const manifest = writeManifest(dir, relative, { tested_sha:sha }); assert.equal(manifest.artifacts['results.json'], sha256('hello')); assert.equal(JSON.parse(readFileSync(path.join(full,'manifest.json'))).tested_sha, sha); assertOnlyRunDirDirty(dir, relative); });
test('dirty tree refusal and exact run-dir exclusion', () => { const dir = repo(); assertCleanStart(dir); writeFileSync(path.join(dir,'stray'), 'x'); assert.throws(() => assertCleanStart(dir), /dirty tree/); assert.throws(() => assertOnlyRunDirDirty(dir, 'docs/performance/inbox-redesign/evidence/abc'), /Non-record/); });
test('path rejects malformed SHA, tier, and run ID', () => { assert.throws(() => runPath('short','pre-merge','id')); assert.throws(() => runPath('a'.repeat(40),'other','id')); assert.throws(() => runPath('a'.repeat(40),'pre-merge','../escape')); });
test('end attestation rejects a sibling evidence run', () => { const dir = repo(); const allowed = runPath('a'.repeat(40), 'pre-merge', 'run_1'); const sibling = runPath('a'.repeat(40), 'pre-merge', 'run_2'); mkdirSync(path.join(dir, allowed), {recursive:true}); writeFileSync(path.join(dir, allowed, 'results.json'), '{}'); mkdirSync(path.join(dir, sibling), {recursive:true}); writeFileSync(path.join(dir, sibling, 'results.json'), '{}'); assert.throws(() => assertOnlyRunDirDirty(dir, allowed), /Non-record/); });
test('results remove webServer env and every text artifact is redacted before hashing', () => {
  const dir = repo();
  const relative = runPath('a'.repeat(40), 'pre-merge', 'redaction');
  const full = path.join(dir, relative);
  mkdirSync(full, { recursive: true });
  const anon = 'demo-anon-value';
  const service = 'demo-service-value';
  const jwt = 'eyJabcdefghij.payload.signature';
  const results = { config: { webServer: { env: { NEXT_PUBLIC_SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: service } }, rootDir: dir, configFile: `${dir}/playwright.outbox-regression.config.ts`, globalSetup: `${dir}/e2e/inbox-acceptance/outbox-global-setup.ts`, externalPath: '/Users/another/private/config.ts' }, suites: [{ title: 'passing test', specs: [], file: `${dir}/e2e/inbox-acceptance/outbox.spec.ts` }] };
  writeFileSync(path.join(full, 'results.json'), JSON.stringify(results));
  for (const extension of ['log', 'txt', 'html', 'json', 'md']) writeFileSync(path.join(full, `extra.${extension}`), `${anon} ${service} ${jwt} sb_secret_sample sb_publishable_sample`);
  mkdirSync(path.join(full, 'playwright', 'x'), { recursive: true });
  writeFileSync(path.join(full, 'playwright', 'x', 'error-context.md'), `${anon} ${service} ${jwt} sb_secret_sample sb_publishable_sample`);
  const manifest = writeManifest(dir, relative, { tested_sha: 'a'.repeat(40) }, { NEXT_PUBLIC_SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: service });
  const safeResults = JSON.parse(readFileSync(path.join(full, 'results.json'), 'utf8'));
  assert.equal(safeResults.config.webServer, undefined);
  assert.equal(safeResults.config.rootDir, '.');
  assert.equal(safeResults.config.configFile, './playwright.outbox-regression.config.ts');
  assert.equal(safeResults.config.globalSetup, './e2e/inbox-acceptance/outbox-global-setup.ts');
  assert.equal(safeResults.config.externalPath, '[LOCAL_PATH]');
  assert.equal(safeResults.suites[0].file, './e2e/inbox-acceptance/outbox.spec.ts');
  assert.doesNotMatch(JSON.stringify(safeResults), /\/Users\//);
  for (const extension of ['log', 'txt', 'html', 'json', 'md']) {
    const safe = readFileSync(path.join(full, `extra.${extension}`), 'utf8');
    assert.equal(safe, '[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]');
    assert.equal(manifest.artifacts[`extra.${extension}`], sha256(safe));
  }
  const safeContext = readFileSync(path.join(full, 'playwright', 'x', 'error-context.md'), 'utf8');
  assert.equal(safeContext, '[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]');
  assert.equal(manifest.artifacts['playwright/x/error-context.md'], sha256(safeContext));
  assert.equal(manifest.artifacts['results.json'], sha256(readFileSync(path.join(full, 'results.json'))));
});
test('stray zip fails closed without a manifest, even without recognizable secret text', () => {
  const dir = repo();
  const relative = runPath('a'.repeat(40), 'pre-merge', 'residual');
  const full = path.join(dir, relative);
  mkdirSync(full, { recursive: true });
  writeFileSync(path.join(full, 'trace.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]));
  assert.throws(() => writeManifest(dir, relative, { tested_sha: 'a'.repeat(40) }, {}), /Disallowed run artifact: trace\.zip/);
  assert.equal(existsSync(path.join(full, 'manifest.json')), false);
});
test('short env values are not redacted from text artifacts', () => {
  const dir = repo();
  const relative = runPath('a'.repeat(40), 'pre-merge', 'short-env');
  const full = path.join(dir, relative);
  mkdirSync(full, { recursive: true });
  writeFileSync(path.join(full, 'runner.log'), 'status=1 enabled=false');
  writeManifest(dir, relative, { tested_sha: 'a'.repeat(40) }, { TEST_TOKEN: '1', TEST_SECRET: 'false' });
  assert.equal(readFileSync(path.join(full, 'runner.log'), 'utf8'), 'status=1 enabled=false');
});
test('outbox lane test count stays aligned with the selected specs', () => {
  const outbox = readFileSync(new URL('../e2e/inbox-acceptance/outbox.spec.ts', import.meta.url), 'utf8');
  const auth = readFileSync(new URL('../e2e/auth.setup.ts', import.meta.url), 'utf8');
  const config = readFileSync(new URL('../playwright.outbox-regression.config.ts', import.meta.url), 'utf8');
  const base = readFileSync(new URL('../playwright.inbox-acceptance.config.ts', import.meta.url), 'utf8');
  assert.ok(config.includes('testMatch: /outbox\\.spec\\.ts$/'));
  assert.ok(base.includes('testMatch: /auth\\.setup\\.ts$/'));
  assert.match(base, /dependencies:\s*\["setup"\]/);
  assert.equal([...outbox.matchAll(/^test\(/gm)].length, 7);
  assert.equal([...auth.matchAll(/^setup\(/gm)].length, 1);
});
test('real outbox lane shape passes only with eight Playwright tests and all ten O-ids', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'outbox-validator-'));
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: `O${String(i + 1).padStart(2, '0')}`, status: 'pass' }));
  const passed = () => ({ status: 'expected', results: [{ retry: 0, status: 'passed' }] });
  const results = { stats: { expected: 8, skipped: 0, unexpected: 0, flaky: 0 }, suites: [
    { file: 'e2e/auth.setup.ts', specs: [{ tests: [passed()] }] },
    { file: 'e2e/inbox-acceptance/outbox.spec.ts', specs: Array.from({ length: 7 }, () => ({ tests: [passed()] })) },
  ] };
  const save = () => { writeFileSync(path.join(dir, 'row-results.json'), JSON.stringify(rows)); writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results)); };
  save(); assert.doesNotThrow(() => validateOutboxResults(dir));
  results.stats.expected = 7; results.suites[1].specs.pop(); save(); assert.throws(() => validateOutboxResults(dir), /Playwright incomplete/);
  results.stats.expected = 8; save(); assert.throws(() => validateOutboxResults(dir), /Playwright incomplete/);
  results.stats.expected = 8; results.suites[1].specs.push({ tests: [passed()] }); rows.pop(); save(); assert.throws(() => validateOutboxResults(dir), /O10/);
  rows.push({ id: 'O10', status: 'pass' }); results.stats.expected = 7; results.stats.skipped = 1; results.suites[1].specs[6].tests[0] = { status: 'skipped', results: [] }; save(); assert.throws(() => validateOutboxResults(dir), /skipped/);
});
test('negative control rejects skipped O10 and retry even if all row outcomes pass', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'outbox-validator-'));
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: `O${String(i + 1).padStart(2, '0')}`, status: 'pass' }));
  const passed = () => ({ status: 'expected', results: [{ retry: 0, status: 'passed' }] });
  const results = { stats: { expected: 8, skipped: 0, unexpected: 0, flaky: 0 }, suites: [{ specs: Array.from({ length: 8 }, () => ({ tests: [passed()] })) }] };
  const save = () => { writeFileSync(path.join(dir, 'row-results.json'), JSON.stringify(rows)); writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results)); };
  save(); assert.doesNotThrow(() => validateOutboxResults(dir));
  rows[9].status = 'skip'; save(); assert.throws(() => validateOutboxResults(dir), /O10/);
  rows[9].status = 'pass'; results.suites[0].specs[0].tests[0].results[0].retry = 1; save(); assert.throws(() => validateOutboxResults(dir), /retried/);
  results.suites[0].specs[0].tests[0].results[0].retry = 0; results.stats.skipped = 1; save(); assert.throws(() => validateOutboxResults(dir), /skipped/);
});
test('large raw file uses gzip -n -9 and hashes committed bytes', () => {
  const dir = repo();
  const relative = runPath('a'.repeat(40), 'pre-merge', 'compressed');
  const full = path.join(dir, relative);
  mkdirSync(full, { recursive: true });
  const raw = Buffer.alloc(1024 * 1024 + 1, 0x61);
  writeFileSync(path.join(full, 'raw.csv'), raw);
  const manifest = writeManifest(dir, relative, { tested_sha: 'a'.repeat(40) }, {});
  assert.equal(existsSync(path.join(full, 'raw.csv')), false);
  assert.equal(existsSync(path.join(full, 'raw.csv.gz')), true);
  assert.equal(manifest.raw_inflated_sha256['raw.csv'], sha256(raw));
  assert.equal(manifest.artifacts['raw.csv.gz'], sha256(readFileSync(path.join(full, 'raw.csv.gz'))));
});

test('mutation-first producer refuses a run over 40 MiB', () => {
  const dir = repo();
  const relative = runPath('a'.repeat(40), 'pre-merge', 'over-cap');
  const full = path.join(dir, relative);
  mkdirSync(full, { recursive: true });
  writeFileSync(path.join(full, 'raw.csv'), randomBytes(40 * 1024 * 1024 + 1024));
  assert.throws(() => writeManifest(dir, relative, { tested_sha: 'a'.repeat(40) }, {}), /40 MiB/);
  assert.equal(existsSync(path.join(full, 'manifest.json')), false);
});
