import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/errors/report', () => ({ reportError }));

import {
  claimDialpadSealWork,
  closeDialpadRecordingCapture,
  consumeDialpadIngestGrant,
  createSupabaseDialpadRecordingDb,
  generateDialpadIngestToken,
  hashDialpadIngestToken,
  mintDialpadRecordingGrant,
  getDialpadRecordingLifecycle,
  getDialpadRecordingSealInputs,
  markDialpadRecordingEof,
  openDialpadRecordingCapture,
  recordDialpadRecordingChunk,
  recordDialpadRecordingVadRanges,
  registerDialpadSealResult,
  type DialpadRecordingDb,
} from './capture';
import { DialpadRecordingDbError } from './contracts';

const ACTOR = { orgId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222' };
const ID = '33333333-3333-4333-8333-333333333333';
const CLAIM = '44444444-4444-4444-8444-444444444444';
const SHA = 'a'.repeat(64);

const captureJson = (over: Record<string, unknown> = {}) => ({
  captureId: ID, orgId: ACTOR.orgId, repUserId: ACTOR.userId, intentId: ID, callActivityId: ID, providerCallId: 'p',
  status: 'open', openedAt: '2026-09-29T00:00:00Z', closedAt: null, closeReason: null, drainDeadlineAt: null, resultAt: null, failureCode: null,
  sealAttempts: 0, segments: [], ...over,
});

type FakeDb = DialpadRecordingDb & { [K in keyof DialpadRecordingDb]: DialpadRecordingDb[K] & ReturnType<typeof vi.fn> };

function fakeDb(): FakeDb {
  return {
    open: vi.fn(), get: vi.fn(), close: vi.fn(), mintGrant: vi.fn(), consumeGrant: vi.fn(),
    recordChunk: vi.fn(), claimSealWork: vi.fn(), registerResult: vi.fn(),
    markEof: vi.fn(), getLifecycle: vi.fn(), getSealInputs: vi.fn(), recordVadRanges: vi.fn(),
  } as unknown as FakeDb;
}

beforeEach(() => reportError.mockReset());

describe('ingest tokens', () => {
  it('generates 256-bit base64url tokens and hashes them with SHA-256', () => {
    const { token, tokenHash } = generateDialpadIngestToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDialpadIngestToken(token)).toBe(tokenHash);
    expect(generateDialpadIngestToken().token).not.toBe(token);
    expect(() => hashDialpadIngestToken('short')).toThrow();
  });
});

describe('session-owned capture operations', () => {
  it('opens for the session rep and org and rejects a non-uuid intent without calling the database', async () => {
    const db = fakeDb();
    db.open.mockResolvedValue({ status: 'opened', capture: captureJson() });
    const ok = await openDialpadRecordingCapture(db, ACTOR, ID);
    expect(db.open).toHaveBeenCalledWith(ACTOR.orgId, ACTOR.userId, ID);
    expect(ok).toMatchObject({ ok: true, replayed: false, capture: { status: 'open' } });
    expect(await openDialpadRecordingCapture(db, ACTOR, 'nope')).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(db.open).toHaveBeenCalledTimes(1);
  });

  it('reports open replays and typed denials', async () => {
    const db = fakeDb();
    db.open.mockResolvedValueOnce({ status: 'replayed', capture: captureJson() });
    expect(await openDialpadRecordingCapture(db, ACTOR, ID)).toMatchObject({ ok: true, replayed: true });
    db.open.mockResolvedValueOnce({ status: 'denied', reason: 'call_not_connected' });
    expect(await openDialpadRecordingCapture(db, ACTOR, ID)).toMatchObject({ ok: false, code: 'denied', reason: 'call_not_connected' });
  });

  it('maps database failures without leaking details and reports only unexpected ones', async () => {
    const db = fakeDb();
    db.open.mockRejectedValueOnce(new DialpadRecordingDbError({ kind: 'not_found' }, 'P0002'));
    expect(await openDialpadRecordingCapture(db, ACTOR, ID)).toMatchObject({ ok: false, code: 'not_found' });
    expect(reportError).not.toHaveBeenCalled();
    db.open.mockRejectedValueOnce(new Error('connection reset secret-host'));
    const result = await openDialpadRecordingCapture(db, ACTOR, ID);
    expect(result).toMatchObject({ ok: false, code: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('secret-host');
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('closes as the session rep with no service reason', async () => {
    const db = fakeDb();
    db.close.mockResolvedValue({ status: 'closed', capture: captureJson({ status: 'closing', closeReason: 'rep_closed', closedAt: '2026-09-29T00:01:00Z' }) });
    expect(await closeDialpadRecordingCapture(db, ACTOR, ID)).toMatchObject({ ok: true, replayed: false, capture: { status: 'closing' } });
    expect(db.close).toHaveBeenCalledWith(ACTOR.orgId, ID, ACTOR.userId, null);
    expect(await closeDialpadRecordingCapture(db, ACTOR, undefined)).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('mints with a generated token, storing only its hash and returning the raw token once', async () => {
    const db = fakeDb();
    db.mintGrant.mockResolvedValue({ status: 'minted', grantId: ID, captureId: ID, epoch: 2, expiresAt: '2026-09-29T00:01:00Z' });
    const generated = { token: 'T'.repeat(43), tokenHash: 'b'.repeat(64) };
    const result = await mintDialpadRecordingGrant(db, ACTOR, { captureId: ID, epoch: 2 }, { generateToken: () => generated });
    expect(result).toMatchObject({ ok: true, epoch: 2, token: generated.token });
    expect(db.mintGrant).toHaveBeenCalledWith({ orgId: ACTOR.orgId, repUserId: ACTOR.userId, captureId: ID, epoch: 2, tokenHash: generated.tokenHash, ttlSeconds: 60 });
    expect(JSON.stringify(db.mintGrant.mock.calls)).not.toContain(generated.token);
  });

  it('returns no token when minting is denied and validates inputs and lifetime', async () => {
    const db = fakeDb();
    db.mintGrant.mockResolvedValue({ status: 'denied', reason: 'epoch_already_authorized' });
    const denied = await mintDialpadRecordingGrant(db, ACTOR, { captureId: ID, epoch: 1 });
    expect(denied).toMatchObject({ ok: false, code: 'denied', reason: 'epoch_already_authorized' });
    expect(denied).not.toHaveProperty('token');
    for (const bad of [{ captureId: 'x', epoch: 1 }, { captureId: ID, epoch: 0 }, { captureId: ID, epoch: 17 }, { captureId: ID, epoch: 1.5 }, { captureId: ID, epoch: '1' }]) {
      expect(await mintDialpadRecordingGrant(db, ACTOR, bad)).toMatchObject({ ok: false, code: 'invalid_input' });
    }
    expect(await mintDialpadRecordingGrant(db, ACTOR, { captureId: ID, epoch: 1 }, { ttlSeconds: 301 })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(db.mintGrant).toHaveBeenCalledTimes(1);
  });
});

describe('worker-side adapters', () => {
  it('hashes the raw token before redeeming and never forwards it', async () => {
    const db = fakeDb();
    const { token, tokenHash } = generateDialpadIngestToken();
    db.consumeGrant.mockResolvedValue({
      status: 'consumed', grantId: ID, captureId: ID, orgId: ACTOR.orgId, repUserId: ACTOR.userId, epoch: 1, intentId: ID, callActivityId: ID, providerCallId: 'p',
    });
    expect(await consumeDialpadIngestGrant(db, token, 'worker-1')).toMatchObject({ ok: true, grant: { captureId: ID, epoch: 1 } });
    expect(db.consumeGrant).toHaveBeenCalledWith(tokenHash, 'worker-1');
    expect(JSON.stringify(db.consumeGrant.mock.calls)).not.toContain(token);
    expect(await consumeDialpadIngestGrant(db, 'nope', 'worker-1')).toMatchObject({ ok: false, code: 'invalid_input' });
    db.consumeGrant.mockResolvedValue({ status: 'denied', reason: 'consumed' });
    expect(await consumeDialpadIngestGrant(db, token, 'worker-1')).toMatchObject({ ok: false, code: 'denied', reason: 'consumed' });
  });

  const chunkInput = { orgId: ACTOR.orgId, captureId: ID, track: 'tab', epoch: 1, seq: 0, sizeBytes: 1024, sha256: SHA, isEof: false };

  it('records chunks and enforces the 1 MiB, sequence, track and hash bounds before the database', async () => {
    const db = fakeDb();
    db.recordChunk.mockResolvedValue({ status: 'recorded', storagePath: 'o/c/chunks/1/tab/00000000' });
    expect(await recordDialpadRecordingChunk(db, chunkInput)).toMatchObject({ ok: true, status: 'recorded' });
    expect(await recordDialpadRecordingChunk(db, { ...chunkInput, sizeBytes: 1_048_576 })).toMatchObject({ ok: true });
    for (const bad of [
      { sizeBytes: 1_048_577 }, { sizeBytes: 0 }, { seq: -1 }, { seq: 100_000 }, { epoch: 0 }, { track: 'speaker' }, { sha256: 'A'.repeat(64) }, { isEof: 'true' }, { captureId: 'x' },
    ]) {
      expect(await recordDialpadRecordingChunk(db, { ...chunkInput, ...bad })).toMatchObject({ ok: false, code: 'invalid_input' });
    }
    expect(db.recordChunk).toHaveBeenCalledTimes(2);
  });

  it('surfaces a conflicting chunk replay as a conflict', async () => {
    const db = fakeDb();
    db.recordChunk.mockRejectedValue(new DialpadRecordingDbError({ kind: 'conflict', detail: 'chunk_conflict' }, '40001'));
    expect(await recordDialpadRecordingChunk(db, chunkInput)).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('marks an acknowledged EOF idempotently and validates its fence inputs', async () => {
    const db = fakeDb();
    db.markEof.mockResolvedValue({ status: 'replayed', captureId: ID, track: 'tab', epoch: 1, seq: 3, sha256: SHA });
    expect(await markDialpadRecordingEof(db, { orgId: ACTOR.orgId, captureId: ID, track: 'tab', epoch: 1, eofSeq: 3, eofSha256: SHA })).toMatchObject({ ok: true, status: 'replayed', seq: 3 });
    expect(await markDialpadRecordingEof(db, { orgId: ACTOR.orgId, captureId: ID, track: 'tab', epoch: 1, eofSeq: 3, eofSha256: 'bad' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(db.markEof).toHaveBeenCalledTimes(1);
  });

  it('reads lifecycle and claim-fenced seal inputs through worker-only adapters', async () => {
    const db = fakeDb();
    db.getLifecycle.mockResolvedValue({
      captureId: ID, orgId: ACTOR.orgId, repUserId: ACTOR.userId, intentId: ID, callActivityId: ID, providerCallId: 'p',
      captureStatus: 'open', callState: 'connected', connected: true, ended: false, acceptsLivePcm: true, allowsRetentionDrain: true,
      closedAt: null, closeReason: null, drainDeadlineAt: null,
      callStatus: { intentId: ID, state: 'connected', connected: true, propertyId: ID, expiresAt: '2026-09-29T00:10:00Z', dispatchAuthorizedAt: null, callActivityId: ID, attemptId: null, startedAt: null, endedAt: null, durationSeconds: null, talkDurationSeconds: null },
    });
    expect(await getDialpadRecordingLifecycle(db, ACTOR.orgId, ID)).toMatchObject({ ok: true, lifecycle: { acceptsLivePcm: true } });
    db.getSealInputs.mockResolvedValue({ status: 'ready', captureId: ID, claimToken: CLAIM, inputs: [] });
    expect(await getDialpadRecordingSealInputs(db, ID, CLAIM)).toMatchObject({ ok: true, inputs: { claimToken: CLAIM, inputs: [] } });
    expect(await getDialpadRecordingSealInputs(db, ID, 'bad')).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('records exact VAD ranges and rejects client totals or invalid range shape', async () => {
    const db = fakeDb();
    db.recordVadRanges.mockResolvedValue({ status: 'recorded', captureId: ID, track: 'tab', epoch: 1, batchId: CLAIM, rangeCount: 1, voicedSamples: 100, measurementStatus: 'provisional', highWaterEpoch: 1, highWaterEndSample: 100, threshold: { status: 'not_latched', thresholdSamples: 4_800_000 } });
    const ranges = [{ startSample: 0, endSample: 100, evidenceRef: 'window:1' }];
    expect(await recordDialpadRecordingVadRanges(db, { orgId: ACTOR.orgId, captureId: ID, track: 'tab', epoch: 1, batchId: CLAIM, ranges })).toMatchObject({ ok: true, voicedSamples: 100, measurementStatus: 'provisional' });
    expect(await recordDialpadRecordingVadRanges(db, { orgId: ACTOR.orgId, captureId: ID, track: 'tab', epoch: 1, batchId: CLAIM, ranges: [{ startSample: 0, endSample: 0, evidenceRef: 'bad' }] })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(db.recordVadRanges).toHaveBeenCalledWith(expect.objectContaining({ ranges }));
  });

  it('claims seal work within lease bounds', async () => {
    const db = fakeDb();
    db.claimSealWork.mockResolvedValue({ status: 'none' });
    expect(await claimDialpadSealWork(db, 'worker-1')).toEqual({ ok: true, claim: { status: 'none' } });
    expect(db.claimSealWork).toHaveBeenCalledWith('worker-1', 300);
    expect(await claimDialpadSealWork(db, 'worker-1', 29)).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await claimDialpadSealWork(db, 'worker-1', 1801)).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await claimDialpadSealWork(db, '')).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  const decodedReport = { track: 'tab' as const, epoch: 1, decodeOk: true as const, sizeBytes: 3000, sha256: SHA, codec: 'opus', sampleRateHz: 48000, channels: 1 as const, decodedDurationMs: 61_000 };

  it('registers results and rejects malformed decode evidence before the database', async () => {
    const db = fakeDb();
    db.registerResult.mockResolvedValue({ status: 'registered', outcome: 'sealed', capture: captureJson({ status: 'sealed' }) });
    const ok = await registerDialpadSealResult(db, { captureId: ID, claimToken: CLAIM, tracks: [decodedReport, { ...decodedReport, track: 'mic' }] });
    expect(ok).toMatchObject({ ok: true, outcome: 'sealed' });
    expect(db.registerResult).toHaveBeenCalledWith(ID, CLAIM, expect.any(Array), null);
    const before = db.registerResult.mock.calls.length;
    const bad = [
      { tracks: [{ ...decodedReport, sha256: 'xyz' }] },
      { tracks: [{ ...decodedReport, sizeBytes: 0 }] },
      { tracks: [{ ...decodedReport, decodedDurationMs: 0 }] },
      { tracks: [{ ...decodedReport, channels: 6 as never }] },
      { tracks: [{ ...decodedReport, track: 'speaker' as never }] },
      { tracks: [decodedReport], failureCode: 'Bad Code!' },
      { claimToken: 'not-a-uuid', tracks: [decodedReport] },
    ];
    for (const extra of bad) {
      expect(await registerDialpadSealResult(db, { captureId: ID, claimToken: CLAIM, ...extra })).toMatchObject({ ok: false, code: 'invalid_input' });
    }
    expect(db.registerResult.mock.calls.length).toBe(before);
  });

  it('allows an undecodable track report and a worker failure code', async () => {
    const db = fakeDb();
    db.registerResult.mockResolvedValue({ status: 'registered', outcome: 'failed', capture: captureJson({ status: 'failed', failureCode: 'decode_failed' }) });
    expect(await registerDialpadSealResult(db, { captureId: ID, claimToken: CLAIM, tracks: [{ track: 'tab', epoch: 1, decodeOk: false }], failureCode: 'decode_failed' })).toMatchObject({ ok: true, outcome: 'failed' });
  });

  it('classifies a lost lease as denied', async () => {
    const db = fakeDb();
    db.registerResult.mockRejectedValue(new DialpadRecordingDbError({ kind: 'forbidden', detail: 'lease_lost' }, '42501'));
    expect(await registerDialpadSealResult(db, { captureId: ID, claimToken: CLAIM, tracks: [decodedReport] })).toMatchObject({ ok: false, code: 'denied' });
  });
});

describe('createSupabaseDialpadRecordingDb', () => {
  it('calls the named RPCs with parameter names and throws typed errors', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { status: 'none' }, error: null });
    const db = createSupabaseDialpadRecordingDb({ rpc } as never);
    await db.claimSealWork('w', 300);
    expect(rpc).toHaveBeenCalledWith('fn_claim_dialpad_recording_seal_work', { p_worker_id: 'w', p_lease_seconds: 300 });
    await db.mintGrant({ orgId: 'o', repUserId: 'r', captureId: 'c', epoch: 1, tokenHash: 'h', ttlSeconds: 60 });
    expect(rpc).toHaveBeenLastCalledWith('fn_mint_dialpad_recording_ingest_grant', { p_org_id: 'o', p_rep_user_id: 'r', p_capture_id: 'c', p_epoch: 1, p_token_hash: 'h', p_ttl_seconds: 60 });
    rpc.mockResolvedValueOnce({ data: null, error: { code: '40001', message: 'x', details: 'chunk_conflict' } });
    await expect(db.consumeGrant('h', 'w')).rejects.toMatchObject({ name: 'DialpadRecordingDbError', sqlstate: '40001', failure: { kind: 'conflict' } });
  });
});
