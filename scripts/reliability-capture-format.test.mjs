import test from 'node:test';
import assert from 'node:assert/strict';

import { containerMime, extensionForMime } from './reliability-capture-format.mjs';

test('maps Chromium codec-qualified WebM output by container MIME', () => {
  assert.equal(containerMime('audio/webm;codecs=opus'), 'audio/webm');
  assert.equal(extensionForMime('audio/webm;codecs=opus'), 'webm');
});

test('preserves unsupported or malformed MIME values for exporter rejection', () => {
  assert.equal(extensionForMime('audio/webm; codecs=opus'), 'webm');
  assert.equal(extensionForMime('audio/unknown;codecs=opus'), undefined);
});
