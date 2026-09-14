import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { containerMime, extensionForMime } from './reliability-capture-format.mjs';
import { validateCaptureSegments } from './reliability-capture-export-validation.mjs';

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

test('export validation rejects a trailing event-only segment', () => {
  const event = (segment, kind, atMonotonicMs) => ({ segment, kind, atMonotonicMs });
  const capture = {
    chunks: [{ segment: 1, sequence: 1, size: 1, mimeType: 'audio/webm;codecs=opus' }],
    events: [
      event(1, 'started', 1), event(1, 'chunk', 2), event(1, 'stopped', 3),
      event(2, 'started', 4), event(2, 'stopped', 5),
    ],
  };
  assert.throws(() => validateCaptureSegments(capture), /Segment 2 has no media chunks/);
});

test('export validation rejects an unfinished segment even when it has media', () => {
  const capture = {
    chunks: [{ segment: 1, sequence: 1, size: 1, mimeType: 'audio/webm;codecs=opus' }],
    events: [
      { segment: 1, kind: 'started', atMonotonicMs: 1 },
      { segment: 1, kind: 'chunk', atMonotonicMs: 2 },
    ],
  };
  assert.throws(() => validateCaptureSegments(capture), /no ordered start\/stop evidence/);
});
