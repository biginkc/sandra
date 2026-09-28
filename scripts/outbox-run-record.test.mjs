import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { artifactHashes, assertCleanStart, assertOnlyRunDirDirty, runPath, sha256, writeManifest } from './outbox-run-record.mjs';
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
  const results = { config: { webServer: { env: { NEXT_PUBLIC_SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: service } }, rootDir: '/tmp' }, suites: [{ title: 'passing test', specs: [] }] };
  writeFileSync(path.join(full, 'results.json'), JSON.stringify(results));
  for (const extension of ['log', 'txt', 'html', 'json']) writeFileSync(path.join(full, `extra.${extension}`), `${anon} ${service} ${jwt} sb_secret_sample sb_publishable_sample`);
  const manifest = writeManifest(dir, relative, { tested_sha: 'a'.repeat(40) }, { NEXT_PUBLIC_SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: service });
  const safeResults = JSON.parse(readFileSync(path.join(full, 'results.json'), 'utf8'));
  assert.equal(safeResults.config.webServer, undefined);
  assert.deepEqual(safeResults.suites, results.suites);
  for (const extension of ['log', 'txt', 'html', 'json']) {
    const safe = readFileSync(path.join(full, `extra.${extension}`), 'utf8');
    assert.equal(safe, '[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]');
    assert.equal(manifest.artifacts[`extra.${extension}`], sha256(safe));
  }
  assert.equal(manifest.artifacts['results.json'], sha256(readFileSync(path.join(full, 'results.json'))));
});
test('residual secret in an unrecognized artifact fails without a manifest', () => {
  const dir = repo();
  const relative = runPath('a'.repeat(40), 'pre-merge', 'residual');
  const full = path.join(dir, relative);
  mkdirSync(full, { recursive: true });
  writeFileSync(path.join(full, 'trace.bin'), 'header sb_secret_residual footer');
  assert.throws(() => writeManifest(dir, relative, { tested_sha: 'a'.repeat(40) }, {}), /Residual secret in run artifact: trace\.bin/);
  assert.equal(existsSync(path.join(full, 'manifest.json')), false);
});
