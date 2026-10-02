#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const repoRoot = path.resolve(import.meta.dirname, '../..');
export const manifestPath = root => path.join(root, 'scripts/inbox-ci/inbox-migrations.json');
export const RESERVED_BLOCK_END = '20261002130500';

export function readManifest(root = repoRoot) {
  const entries = JSON.parse(readFileSync(manifestPath(root), 'utf8'));
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('Inbox migration manifest must be a non-empty array');
  const seenVersions = new Set();
  const seenNames = new Set();
  for (const entry of entries) {
    if (!entry || !/^[0-9]{14}$/.test(entry.version) || !/^inbox_[a-z0-9_]+$/.test(entry.name) || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error('Invalid Inbox migration manifest entry');
    if (seenVersions.has(entry.version) || seenNames.has(entry.name)) throw new Error('Duplicate Inbox migration manifest identity');
    seenVersions.add(entry.version); seenNames.add(entry.name);
  }
  return entries;
}

export const filename = entry => `${entry.version}_${entry.name}.sql`;
export const relativePath = entry => path.posix.join('supabase/migrations', filename(entry));
export const count = (root = repoRoot) => readManifest(root).length;
export const versions = (root = repoRoot) => readManifest(root).map(entry => entry.version);
export const files = (root = repoRoot) => readManifest(root).map(relativePath);
export const excludeArgs = (root = repoRoot) => readManifest(root).flatMap(entry => ['--exclude-migrations', filename(entry)]);
export const sqlInList = (root = repoRoot) => readManifest(root).map(entry => `'${entry.version}'`).join(',');
export const byName = (name, root = repoRoot) => {
  const entry = readManifest(root).find(item => item.name === name);
  if (!entry) throw new Error(`Inbox migration not found in manifest: ${name}`);
  return entry;
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const mode = process.argv[2];
  const values = mode === '--count' ? [String(count())]
    : mode === '--reserved-block-end' ? [RESERVED_BLOCK_END]
      : mode === '--versions' ? versions()
        : mode === '--files' ? files()
          : mode === '--exclude-args' ? excludeArgs()
            : mode === '--sql-in-list' ? [sqlInList()]
              : mode === '--file-by-name' ? [relativePath(byName(process.argv[3]))]
              : null;
  if (!values) throw new Error('Usage: inbox-migrations.mjs --count|--reserved-block-end|--versions|--files|--exclude-args|--sql-in-list|--file-by-name <name>');
  process.stdout.write(`${values.join('\n')}\n`);
}
