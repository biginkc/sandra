#!/usr/bin/env node
/** Read only the named QA call's browser-side IndexedDB capture over local CDP. */
import { createHash } from 'node:crypto';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { validateCaptureSegments } from './reliability-capture-export-validation.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((part) => {
  const separator = part.indexOf('=');
  if (separator < 3 || !part.startsWith('--')) throw new Error('Arguments must be --name=value');
  return [part.slice(2, separator), part.slice(separator + 1)];
}));
const validCallReference = (value) =>
  /^[0-9a-f-]{36}$/i.test(value) || /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
if (!args.cdp || !args.origin || !args.run || !args.call || !args.out ||
    !/^[a-zA-Z0-9_-]{8,80}$/.test(args.run) ||
    !validCallReference(args.call)) {
  throw new Error('Usage: --cdp=http://127.0.0.1:9222 --origin=https://sandra.example --run=RUN_ID --call=EXACT_BROWSER_CALL_REFERENCE --out=/absolute/empty/directory');
}
const cdp = new URL(args.cdp);
const origin = new URL(args.origin);
if (!['127.0.0.1', 'localhost'].includes(cdp.hostname) || !['http:', 'ws:'].includes(cdp.protocol) ||
    origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash ||
    !args.out.startsWith('/') || !validCallReference(args.call)) {
  throw new Error('Invalid local CDP endpoint, HTTPS origin, output path, or call ID');
}

const browser = await chromium.connectOverCDP(cdp.toString());
try {
  const pages = browser.contexts().flatMap((context) => context.pages()).filter((page) => {
    try { return new URL(page.url()).origin === origin.origin; } catch { return false; }
  });
  if (pages.length !== 1) throw new Error(`Expected one matching Sandra tab, found ${pages.length}`);
  const page = pages[0];
  const capture = await page.evaluate(async ({ runId, callId }) => {
    const database = await new Promise((ok, fail) => {
      const request = indexedDB.open('sandra-reliability-capture-v2', 3);
      // This exporter is read-only. Aborting an upgrade prevents an empty
      // version-3 database from being created before the app has initialized
      // its stores; the app can then perform the real upgrade later.
      request.onupgradeneeded = () => request.transaction?.abort();
      request.onerror = () => fail(request.error ?? new Error('IndexedDB open failed'));
      request.onblocked = () => fail(new Error('IndexedDB open blocked'));
      request.onsuccess = () => ok(request.result);
    });
    try {
      if (!database.objectStoreNames.contains('chunks') || !database.objectStoreNames.contains('events') ||
          !database.objectStoreNames.contains('timings'))
        throw new Error('No QA capture stores in this tab');
      const chunks = await new Promise((ok, fail) => {
        const results = [];
        const transaction = database.transaction('chunks', 'readonly');
        const range = IDBKeyRange.bound(
          [runId, callId, 0, 0], [runId, callId, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
        );
        const request = transaction.objectStore('chunks').openCursor(range);
        request.onerror = () => fail(request.error ?? new Error('Chunk cursor failed'));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return ok(results);
          const value = cursor.value;
          results.push({ segment: value.segment, sequence: value.sequence, mimeType: value.mimeType,
            size: value.blob?.size, atMonotonicMs: value.atMonotonicMs, atEpochMs: value.atEpochMs });
          cursor.continue();
        };
      });
      const events = await new Promise((ok, fail) => {
        const transaction = database.transaction('events', 'readonly');
        const request = transaction.objectStore('events').index('byCall').getAll(IDBKeyRange.only([runId, callId]));
        request.onerror = () => fail(request.error ?? new Error('Event read failed'));
        request.onsuccess = () => ok(request.result);
      });
      const timings = await new Promise((ok, fail) => {
        const transaction = database.transaction('timings', 'readonly');
        const range = IDBKeyRange.bound(
          [runId, callId, 0], [runId, callId, Number.MAX_SAFE_INTEGER],
        );
        const request = transaction.objectStore('timings').openCursor(range);
        const results = [];
        request.onerror = () => fail(request.error ?? new Error('Timing cursor failed'));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return ok(results);
          results.push(cursor.value);
          cursor.continue();
        };
      });
      const captureError = sessionStorage.getItem(`sandra:reliability-capture-error:${runId}:${callId}`);
      return { chunks, events, timings, captureError };
    } finally { database.close(); }
  }, { runId: args.run, callId: args.call });
  if (!capture.chunks.length || !capture.events.length) throw new Error('Named QA capture is empty');
  if (!capture.timings.length) throw new Error('Named QA capture has no startup timing markers');
  if (capture.captureError) throw new Error('Named QA capture has a browser-side failure marker');
  if (capture.events.some((event) => ['error', 'unsupported', 'no_audio_track'].includes(event.kind)))
    throw new Error('Named QA capture contains a recorder or playback failure');
  const segments = validateCaptureSegments(capture);
  const output = resolve(args.out);
  await mkdir(output, { recursive: false });
  const files = [];
  for (const [segment, info] of segments) {
    const filename = `browser-receive-segment-${segment}.${info.ext}`;
    const file = await open(`${output}/${filename}`, 'wx');
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for (const chunk of info.chunks) {
        const base64 = await page.evaluate(async ({ runId, callId, segment, sequence }) => {
          const database = await new Promise((ok, fail) => {
            const request = indexedDB.open('sandra-reliability-capture-v2', 3);
            // A disappearing or uninitialized database must not be recreated
            // by this per-chunk read; leave initialization to the app.
            request.onupgradeneeded = () => request.transaction?.abort();
            request.onerror = () => fail(request.error ?? new Error('IndexedDB open failed'));
            request.onsuccess = () => ok(request.result);
          });
          try {
            const record = await new Promise((ok, fail) => {
              const request = database.transaction('chunks', 'readonly').objectStore('chunks')
                .get([runId, callId, segment, sequence]);
              request.onerror = () => fail(request.error ?? new Error('Chunk read failed'));
              request.onsuccess = () => ok(request.result);
            });
            if (!record?.blob) throw new Error('Capture chunk disappeared during export');
            return await new Promise((ok, fail) => {
              const reader = new FileReader();
              reader.onerror = () => fail(reader.error ?? new Error('Blob read failed'));
              reader.onload = () => ok(String(reader.result).split(',')[1]);
              reader.readAsDataURL(record.blob);
            });
          } finally { database.close(); }
        }, { runId: args.run, callId: args.call, segment, sequence: chunk.sequence });
        const data = Buffer.from(base64, 'base64');
        if (data.length !== chunk.size) throw new Error('Capture chunk size changed during export');
        let offset = 0;
        while (offset < data.length) {
          const result = await file.write(data, offset, data.length - offset);
          if (result.bytesWritten < 1) throw new Error('Capture output write stalled');
          offset += result.bytesWritten;
        }
        hash.update(data);
        bytes += data.length;
      }
    } finally { await file.close(); }
    files.push({ filename, mimeType: info.mimeType, mimeTypes: [...info.mimeTypes], segment, chunks: info.chunks.length,
      bytes, sha256: hash.digest('hex') });
  }
  const manifest = { schemaVersion: 2, runId: args.run, callId: args.call, origin: origin.origin,
    exportedAt: new Date().toISOString(), files, events: capture.events, timings: capture.timings,
    chunks: capture.chunks.map(({ segment, sequence, size, mimeType, atMonotonicMs, atEpochMs }) =>
      ({ segment, sequence, size, mimeType, atMonotonicMs, atEpochMs })) };
  await writeFile(`${output}/browser-receive-manifest.json`, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  process.stdout.write(`Exported ${files.length} browser-receive segment(s) for the exact QA call.\n`);
} finally { await browser.close(); }
