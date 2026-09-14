import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { containerMime, extensionForMime } from './reliability-capture-format.mjs';

test('maps Chromium codec-qualified WebM output by container MIME', () => {
  assert.equal(containerMime('audio/webm;codecs=opus'), 'audio/webm');
  assert.equal(extensionForMime('audio/webm;codecs=opus'), 'webm');
});

test('preserves unsupported or malformed MIME values for exporter rejection', () => {
  assert.equal(extensionForMime('audio/webm; codecs=opus'), 'webm');
  assert.equal(extensionForMime('audio/unknown;codecs=opus'), undefined);
});

test('exporter aborts a read-only upgrade before it can create an empty database', async () => {
  const source = await readFile(new URL('./export-reliability-browser-capture.mjs', import.meta.url), 'utf8');
  assert.equal(
    source.match(/request\.onupgradeneeded\s*=\s*\(\)\s*=>\s*request\.transaction\?\.abort\(\)/g)?.length,
    2,
    'both exporter database reads must abort upgrades',
  );
});
