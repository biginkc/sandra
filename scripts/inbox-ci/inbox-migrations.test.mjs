import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { files, readManifest, relativePath, repoRoot, sqlInList, versions } from './inbox-migrations.mjs';

const legacyPrefix = ['2026', '09', '3004'].join('');
const legacyPattern = new RegExp(`${legacyPrefix}|${legacyPrefix}0[0-9]{3}`);
const migrationDir = path.join(repoRoot, 'supabase/migrations');

export function assertNoLegacyReferences(root = repoRoot) {
  const result = spawnSync('git', ['-C', root, 'grep', '-nE', `${legacyPrefix}|${legacyPrefix}0[0-9]{3}`, '--', ':(exclude)notes', ':(exclude)evidence'], { encoding: 'utf8' });
  if (![0, 1].includes(result.status)) throw new Error(result.stderr || 'git grep failed');
  if (result.stdout) throw new Error(`Legacy Inbox migration reference(s) remain:\n${result.stdout}`);
}

export function assertManifestIntegrity(root = repoRoot) {
  const entries = readManifest(root);
  const expected = new Set(entries.map(relativePath));
  const directory = path.join(root, 'supabase/migrations');
  for (const entry of entries) {
    const file = path.join(root, relativePath(entry));
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), entry.sha256, `sha256 mismatch: ${file}`);
  }
  const sqlFiles = execFileSync('find', [directory, '-maxdepth', '1', '-type', 'f', '-name', '*.sql', '-print'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  for (const full of sqlFiles) {
    const name = path.basename(full);
    const version = name.split('_', 1)[0];
    const isInboxName = /^\d+_inbox_[a-z0-9_]+\.sql$/.test(name);
    const inReservedBlock = /^\d{14}$/.test(version) && version >= entries[0].version && version <= '20261002100260';
    if ((isInboxName || inReservedBlock) && !expected.has(path.relative(root, full))) throw new Error(`Unlisted Inbox migration: ${name}`);
  }
  assert.deepEqual(entries.map(relativePath), files(root));
  return entries;
}

test('literal sweep has no legacy Inbox migration reference', () => {
  assertNoLegacyReferences();
  assert.equal(legacyPattern.test('20261002100000_inbox_control_foundation.sql'), false);
});

test('manifest entries are ordered, hashed, and exhaustive', () => {
  const entries = assertManifestIntegrity();
  assert.deepEqual(entries.map(entry => entry.version), versions());
  assert.match(sqlInList(), /^'20261002100000','20261002100100','20261002100200'$/);
});

test('literal sweep mutation fails naturally', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'inbox-literal-sweep-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    writeFileSync(path.join(root, 'mutated.txt'), `${legacyPrefix}0000\n`);
    execFileSync('git', ['-C', root, 'add', 'mutated.txt']);
    assert.throws(() => assertNoLegacyReferences(root), /Legacy Inbox migration reference/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('manifest byte and unlisted-file mutations fail naturally', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'inbox-manifest-integrity-'));
  try {
    mkdirSync(path.join(root, 'scripts/inbox-ci'), { recursive: true });
    mkdirSync(path.join(root, 'supabase/migrations'), { recursive: true });
    cpSync(path.join(repoRoot, 'scripts/inbox-ci/inbox-migrations.json'), path.join(root, 'scripts/inbox-ci/inbox-migrations.json'));
    for (const file of files()) cpSync(path.join(repoRoot, file), path.join(root, file));
    const first = path.join(root, files()[0]);
    writeFileSync(first, `${readFileSync(first, 'utf8')}\n`);
    assert.throws(() => assertManifestIntegrity(root), /sha256 mismatch/);
    cpSync(path.join(repoRoot, files()[0]), first);
    writeFileSync(path.join(root, 'supabase/migrations/20261002100250_inbox_unlisted.sql'), 'select 1;\n');
    assert.throws(() => assertManifestIntegrity(root), /Unlisted Inbox migration/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
