import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/errors/report', () => ({ reportError: vi.fn(), reportInfo: vi.fn() }));

import { reportError } from '@/lib/errors/report';

import {
  fetchDialpadRecap,
  fetchDialpadTranscript,
  parseDialpadRecap,
  parseDialpadTranscript,
  sweepDialpadArtifacts,
  type ArtifactFetchResult,
  type ArtifactFetchRow,
  type DialpadArtifactDb,
} from './artifact-fetch';
import type { DialpadDirectoryFetch } from './directory';

const CALL = '6543210987654321098';
const KEY = 'test-dialpad-key-value-0000000001';
const TRANSCRIPT = `{"call_id":${CALL},"lines":[{"name":"Jarrad","content":"Hi Sally.","user_id":5150000000000001},{"name":"Sally","content":"Hello."},{"name":"x","content":"  "}]}`;
const reply = (status: number, body = ''): DialpadDirectoryFetch => vi.fn(async () => ({ status, text: async () => body }));

describe('transcript parsing', () => {
  it('joins lines as speaker: text without rounding int64 ids, and skips blank lines', () => {
    expect(parseDialpadTranscript(TRANSCRIPT)).toEqual({ text: 'Jarrad: Hi Sally.\nSally: Hello.' });
  });
  it('is null when nothing usable is there yet', () => {
    expect(parseDialpadTranscript('')).toBeNull();
    expect(parseDialpadTranscript('not json')).toBeNull();
    expect(parseDialpadTranscript('{"lines":[]}')).toBeNull();
    expect(parseDialpadTranscript('[]')).toBeNull();
  });
  it('accepts only a plain language code', () => {
    expect(parseDialpadTranscript('{"language":"en-US","lines":[{"name":"a","content":"b"}]}')).toEqual({ text: 'a: b', language: 'en-US' });
    expect(parseDialpadTranscript('{"language":"<script>","lines":[{"name":"a","content":"b"}]}')).toEqual({ text: 'a: b' });
  });
  it.todo('parses the real Phase 0 transcript fixture');
  it.todo('parses the real Phase 0 AI Recap fixture');
});

describe('recap parsing', () => {
  it('takes only a top-level summary string', () => {
    expect(parseDialpadRecap('{"summary":" Wants 200k. "}')).toEqual({ summary: 'Wants 200k.' });
    expect(parseDialpadRecap('{"summary":""}')).toBeNull();
    expect(parseDialpadRecap('{"x":1}')).toBeNull();
  });
});

describe('fetchDialpadTranscript status mapping', () => {
  const run = (fetchImpl: DialpadDirectoryFetch) => fetchDialpadTranscript({ callId: CALL, apiKey: KEY, fetchImpl });
  it('200 with content is available', async () => {
    expect(await run(reply(200, TRANSCRIPT))).toMatchObject({ outcome: 'available', text: 'Jarrad: Hi Sally.\nSally: Hello.' });
  });
  it('200 empty and 404 are not ready; 429 is not ready', async () => {
    expect(await run(reply(200, '{"lines":[]}'))).toMatchObject({ outcome: 'not_ready' });
    expect(await run(reply(404))).toMatchObject({ outcome: 'not_ready', error: '404' });
    expect(await run(reply(429))).toMatchObject({ outcome: 'not_ready', error: '429' });
  });
  it('401 and 403 are denied', async () => {
    expect(await run(reply(401))).toEqual({ outcome: 'denied', error: '401' });
    expect(await run(reply(403))).toEqual({ outcome: 'denied', error: '403' });
  });
  it('5xx, timeout and network failures are errors', async () => {
    expect(await run(reply(503))).toEqual({ outcome: 'error', error: '503' });
    expect(await run(vi.fn(async () => { throw new Error('boom with secret'); }))).toEqual({ outcome: 'error', error: 'network' });
  });
  it('builds the URL from a digit-validated id and never sends a bad id', async () => {
    const f = reply(404);
    await run(f);
    expect(f).toHaveBeenCalledWith(`https://dialpad.com/api/v2/transcripts/${CALL}`, expect.objectContaining({ method: 'GET', redirect: 'error' }));
    const g = reply(200, TRANSCRIPT);
    expect(await fetchDialpadTranscript({ callId: '1/../2', apiKey: KEY, fetchImpl: g })).toEqual({ outcome: 'error', error: 'invalid_call_id' });
    expect(await fetchDialpadTranscript({ callId: '', apiKey: KEY, fetchImpl: g })).toMatchObject({ outcome: 'error' });
    expect(g).not.toHaveBeenCalled();
  });
  it('never puts the key or a response body in the result', async () => {
    const result = await run(reply(500, `secret body ${KEY}`));
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain('secret body');
  });
  it('the recap fetch stays off until Phase 0 names its endpoint', async () => {
    const f = reply(200, '{"summary":"x"}');
    expect(await fetchDialpadRecap({ callId: CALL, apiKey: KEY, fetchImpl: f })).toEqual({ outcome: 'error', error: 'recap_path_unset' });
    expect(f).not.toHaveBeenCalled();
  });
});

function makeDb(rows: ArtifactFetchRow[], o: Partial<DialpadArtifactDb> = {}) {
  const recorded: { id: string; result: ArtifactFetchResult }[] = [];
  const db: DialpadArtifactDb = {
    claim: vi.fn(async () => rows),
    record: vi.fn(async (id, result) => { recorded.push({ id, result }); }),
    loadKey: vi.fn(async () => KEY),
    resolveRecordingLinks: vi.fn(async () => ({ available: 0, flagged: [] })),
    ...o,
  };
  return { db, recorded };
}
const row = (id: string, artifact: 'transcript' | 'recap', orgId = 'org-1'): ArtifactFetchRow =>
  ({ id, orgId, artifact, providerCallId: CALL, callActivityId: `act-${id}`, attempts: 0, endedAt: '2026-10-06T10:00:00Z' });

describe('sweepDialpadArtifacts', () => {
  it('claims only transcripts while the recap endpoint is unset, records each outcome and counts them', async () => {
    const answers = [reply(200, TRANSCRIPT), reply(404), reply(403), reply(500)];
    let n = 0;
    const fetchImpl: DialpadDirectoryFetch = (url, init) => answers[n++]!(url, init);
    const { db, recorded } = makeDb([row('1', 'transcript'), row('2', 'transcript'), row('3', 'transcript'), row('4', 'transcript')]);
    const summary = await sweepDialpadArtifacts(db, { fetchImpl });
    expect(db.claim).toHaveBeenCalledWith(10, ['transcript']);
    expect(summary).toMatchObject({ claimed: 4, available: 1, notReady: 1, denied: 1, errors: 1 });
    expect(recorded.map((r) => r.result.outcome).sort()).toEqual(['available', 'denied', 'error', 'not_ready']);
  });

  it('claims recaps too when an endpoint is configured, and loads each org key once', async () => {
    const { db } = makeDb([row('1', 'transcript'), row('2', 'transcript')]);
    await sweepDialpadArtifacts(db, { fetchImpl: reply(404), recapPath: '/api/v2/whatever/{call_id}' });
    expect(db.claim).toHaveBeenCalledWith(10, ['transcript', 'recap']);
    expect(db.loadKey).toHaveBeenCalledTimes(1);
  });

  it('a missing key is a retryable error (never a terminal denial) and Dialpad is not called', async () => {
    const fetchImpl = reply(200, TRANSCRIPT);
    const { db, recorded } = makeDb([row('1', 'transcript')], { loadKey: vi.fn(async () => null) });
    const summary = await sweepDialpadArtifacts(db, { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(recorded[0]).toEqual({ id: '1', result: { outcome: 'error', error: 'no_key' } });
    expect(summary).toMatchObject({ denied: 0, errors: 1 });
  });

  it('fetches in parallel with a bounded pool so a full claim fits the route budget', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl: DialpadDirectoryFetch = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { status: 404, text: async () => '' };
    };
    const rows = Array.from({ length: 10 }, (_, i) => row(String(i), 'transcript'));
    const { db, recorded } = makeDb(rows);
    const summary = await sweepDialpadArtifacts(db, { fetchImpl });
    expect(summary.notReady).toBe(10);
    expect(recorded).toHaveLength(10);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
  });

  it('an unexpected throw while fetching becomes a bounded error, not a crash', async () => {
    const { db, recorded } = makeDb([row('1', 'transcript')], { loadKey: vi.fn(async () => { throw new Error('db'); }) });
    const summary = await sweepDialpadArtifacts(db, { fetchImpl: reply(200) });
    expect(recorded[0]!.result).toEqual({ outcome: 'error', error: 'unexpected' });
    expect(summary.errors).toBe(1);
  });

  it('a failed record call is reported and counted, and the sweep continues', async () => {
    const record = vi.fn().mockRejectedValueOnce(new Error('rpc')).mockResolvedValue(undefined);
    const { db } = makeDb([row('1', 'transcript'), row('2', 'transcript')], { record });
    const summary = await sweepDialpadArtifacts(db, { fetchImpl: reply(404) });
    expect(record).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ errors: 1, notReady: 1 });
    expect(reportError).toHaveBeenCalled();
  });

  it('reports every flagged missing recording link', async () => {
    vi.mocked(reportError).mockClear();
    const { db } = makeDb([], { resolveRecordingLinks: vi.fn(async () => ({ available: 2, flagged: [{ id: 'f1', callActivityId: 'a1' }] })) });
    const summary = await sweepDialpadArtifacts(db, { fetchImpl: reply(404) });
    expect(summary).toMatchObject({ claimed: 0, linksAvailable: 2, linksFlagged: 1 });
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
