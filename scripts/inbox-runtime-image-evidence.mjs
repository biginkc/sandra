#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const serviceFiles = {
  'operation-worker': [
    'experiments/inbox-operation-worker/Dockerfile',
    'experiments/inbox-operation-worker/package.json',
    'experiments/inbox-operation-worker/package-lock.json',
    'experiments/inbox-operation-worker/core.mjs',
    'experiments/inbox-operation-worker/server.mjs',
  ],
  'reply-send-worker': [
    'experiments/inbox-reply-send-worker/Dockerfile',
    'experiments/inbox-reply-send-worker/package.json',
    'experiments/inbox-reply-send-worker/package-lock.json',
    'experiments/inbox-reply-send-worker/core.mjs',
    'experiments/inbox-reply-send-worker/runner.mjs',
    'experiments/inbox-reply-send-worker/server.mjs',
    'experiments/inbox-reply-send-worker/vendor/reply-provider.mjs',
    'experiments/inbox-reply-send-worker/vendor/test-transport.mjs',
    'experiments/inbox-reply-send-worker/worker-role.sql',
    'experiments/inbox-reply-send-worker/worker.sql',
  ],
  'projection-worker': [
    'services/inbox-projection-worker/Dockerfile',
    'services/inbox-projection-worker/package.json',
    'services/inbox-projection-worker/package-lock.json',
    'services/inbox-projection-worker/core.mjs',
    'services/inbox-projection-worker/config.mjs',
    'services/inbox-projection-worker/server.mjs',
    'services/inbox-projection-worker/worker-role.sql',
    'services/inbox-projection-worker/config.test.mjs',
  ],
  'sync-relay': [
    'services/inbox-sync-relay/Dockerfile',
    'services/inbox-sync-relay/server.mjs',
    'services/inbox-sync-relay/railway.json',
  ],
};
const serviceContexts = {
  'operation-worker': 'experiments/inbox-operation-worker/',
  'reply-send-worker': 'experiments/inbox-reply-send-worker/',
  'projection-worker': 'services/inbox-projection-worker/',
  'sync-relay': 'services/inbox-sync-relay/',
};

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--source-sha' || argument === '--output') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      values[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    if (argument === '--image') {
      const value = argv[index + 1];
      if (!value) throw new Error('--image requires service=image@sha256:digest');
      const separator = value.indexOf('=');
      if (separator < 1) throw new Error('--image requires service=image@sha256:digest');
      values.images ??= {};
      values.images[value.slice(0, separator)] = value.slice(separator + 1);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument ${argument}`);
  }
  return values;
}

function assertImage(service, value) {
  const expectedRepository = {
    'operation-worker': 'ghcr.io/biginkc/sandra-inbox-operation-worker',
    'reply-send-worker': 'ghcr.io/biginkc/sandra-inbox-reply-send-worker',
    'projection-worker': 'ghcr.io/biginkc/sandra-inbox-projection-worker',
    'sync-relay': 'ghcr.io/biginkc/sandra-inbox-sync-relay',
  }[service];
  const pattern = new RegExp(`^${expectedRepository.replaceAll('.', '\\.')}@sha256:[a-f0-9]{64}$`);
  if (!pattern.test(value)) throw new Error(`${service} must be an immutable GHCR image digest`);
}

export async function buildEvidence({ sourceSha, images, output }) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '')) throw new Error('source sha must be exactly 40 lowercase hex characters');
  if (!output) throw new Error('output is required');
  for (const service of Object.keys(serviceFiles)) {
    if (typeof images?.[service] !== 'string') throw new Error(`missing image for ${service}`);
    assertImage(service, images[service]);
  }
  if (Object.keys(images).some(service => !serviceFiles[service])) throw new Error('unexpected image service');

  const services = {};
  for (const [service, files] of Object.entries(serviceFiles)) {
    const hashes = {};
    for (const file of files) hashes[file.slice(serviceContexts[service].length)] = sha256(await readFile(file));
    services[service] = {
      image: images[service],
      source_sha: sourceSha,
      source_commit: sourceSha,
      files: hashes,
    };
  }
  const evidence = {
    schema_version: 1,
    source_sha: sourceSha,
    source_commit: sourceSha,
    images: Object.fromEntries(Object.entries(services).map(([service, value]) => [service, value.image])),
    services,
  };
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArguments(process.argv.slice(2));
    await buildEvidence({ sourceSha: args['source-sha'], images: args.images, output: args.output });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
