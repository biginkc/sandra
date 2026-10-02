import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureChildEnv, platformConfigFor, stagePhaseRunDir } from './outbox-db-contract-mutations.mjs';

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
