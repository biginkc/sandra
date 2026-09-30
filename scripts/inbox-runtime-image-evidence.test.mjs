import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEvidence } from './inbox-runtime-image-evidence.mjs';

const digest = 'a'.repeat(64);
const images = {
  'operation-worker': `ghcr.io/biginkc/sandra-inbox-operation-worker@sha256:${digest}`,
  'reply-send-worker': `ghcr.io/biginkc/sandra-inbox-reply-send-worker@sha256:${digest}`,
  'projection-worker': `ghcr.io/biginkc/sandra-inbox-projection-worker@sha256:${digest}`,
  'sync-relay': `ghcr.io/biginkc/sandra-inbox-sync-relay@sha256:${digest}`,
};

test('image evidence binds exact source sha, immutable images, and manifest file hashes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-image-evidence-'));
  const output = join(dir, 'evidence.json');
  try {
    const evidence = await buildEvidence({ sourceSha: 'b'.repeat(40), images, output });
    assert.equal(evidence.source_sha, 'b'.repeat(40));
    assert.deepEqual(Object.keys(evidence.services).sort(), ['operation-worker', 'projection-worker', 'reply-send-worker', 'sync-relay']);
    for (const service of Object.values(evidence.services)) {
      assert.match(service.image, /@sha256:[a-f0-9]{64}$/);
      assert.equal(service.source_commit, 'b'.repeat(40));
      assert.ok(Object.keys(service.files).length > 0);
      for (const hash of Object.values(service.files)) assert.match(hash, /^[a-f0-9]{64}$/);
    }
    assert.deepEqual(Object.keys(evidence.services['reply-send-worker'].files).sort(), [
      'Dockerfile', 'core.mjs', 'package-lock.json', 'package.json', 'runner.mjs', 'server.mjs',
      'vendor/reply-provider.mjs', 'vendor/test-transport.mjs', 'worker-role.sql', 'worker.sql',
    ]);
    assert.deepEqual(Object.keys(evidence.services['projection-worker'].files).sort(), [
      'Dockerfile', 'config.mjs', 'config.test.mjs', 'core.mjs', 'package-lock.json', 'package.json', 'server.mjs', 'worker-role.sql',
    ]);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), evidence);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('image evidence rejects mutable tags and wrong repositories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-image-evidence-'));
  try {
    await assert.rejects(() => buildEvidence({ sourceSha: 'b'.repeat(40), images: { ...images, 'sync-relay': 'ghcr.io/biginkc/sandra-inbox-sync-relay:latest' }, output: join(dir, 'evidence.json') }), /immutable GHCR image digest/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime image workflow pins source, base image, GHCR permissions, and all four builds', async () => {
  const workflow = await readFile('.github/workflows/inbox-runtime-images.yml', 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /sha:\n\s+description:[^\n]+\n\s+required:\s+true/);
  assert.match(workflow, /packages:\s*write/);
  assert.match(workflow, /ref:\s*\$\{\{ inputs\.sha \}\}/);
  assert.match(workflow, /node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5/);
  assert.equal((workflow.match(/docker\/build-push-action@v6/g) ?? []).length, 4);
  assert.match(workflow, /secrets\.GITHUB_TOKEN/);
  assert.match(workflow, /upload-artifact@v4/);
});
