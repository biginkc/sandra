import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureChildEnv, stagePhaseRunDir } from './outbox-db-contract-mutations.mjs';

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
