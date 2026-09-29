import { describe, expect, it } from 'vitest';

import {
  classifyDialpadRecordingRpcError,
  DIALPAD_RECORDING_CHUNK_MAX_BYTES,
  DIALPAD_RECORDING_TRACK_MAX_BYTES,
  DIALPAD_RECORDING_VAD_THRESHOLD_SAMPLES,
  parseDialpadRecordingCapture,
  parseDialpadRecordingClaimResult,
  parseDialpadRecordingConsumeResult,
  parseDialpadRecordingGrantResult,
  parseDialpadRecordingOpenResult,
  parseDialpadRecordingEofResult,
  parseDialpadRecordingLifecycle,
  parseDialpadRecordingSealInputs,
  parseDialpadRecordingVadResult,
} from './contracts';

const capture = (over: Record<string, unknown> = {}) => ({
  captureId: 'c', orgId: 'o', repUserId: 'r', intentId: 'i', callActivityId: 'a', providerCallId: 'p',
  status: 'open', openedAt: '2026-09-29T00:00:00Z', closedAt: null, closeReason: null, drainDeadlineAt: null, resultAt: null, failureCode: null,
  sealAttempts: 0,
  segments: [{ track: 'tab', epoch: 1, chunkCount: 2, totalBytes: '2000', maxSeq: 1, eofSeq: null, final: null }],
  ...over,
});

describe('recording contracts', () => {
  it('pins the storage bounds', () => {
    expect(DIALPAD_RECORDING_CHUNK_MAX_BYTES).toBe(1024 * 1024);
    expect(DIALPAD_RECORDING_TRACK_MAX_BYTES).toBe(512 * 1024 * 1024);
    expect(DIALPAD_RECORDING_VAD_THRESHOLD_SAMPLES).toBe(4_800_000);
  });

  it('classifies database errors by SQLSTATE', () => {
    expect(classifyDialpadRecordingRpcError({ code: '42501', details: 'lease_lost' })).toEqual({ kind: 'forbidden', detail: 'lease_lost' });
    expect(classifyDialpadRecordingRpcError({ code: 'P0002' })).toEqual({ kind: 'not_found' });
    expect(classifyDialpadRecordingRpcError({ code: '22023' }).kind).toBe('invalid_input');
    expect(classifyDialpadRecordingRpcError({ code: '40001' }).kind).toBe('conflict');
    expect(classifyDialpadRecordingRpcError({ code: '55000' }).kind).toBe('state');
    expect(classifyDialpadRecordingRpcError({ code: '23505' })).toEqual({ kind: 'unknown' });
    expect(classifyDialpadRecordingRpcError(null)).toEqual({ kind: 'unknown' });
  });

  it('parses a capture and accepts bigint totals as strings', () => {
    const parsed = parseDialpadRecordingCapture(capture() as never);
    expect(parsed.status).toBe('open');
    expect(parsed.drainDeadlineAt).toBeNull();
    expect(parsed.segments[0]).toMatchObject({ totalBytes: 2000, eofSeq: null, final: null });
  });

  it('rejects malformed captures instead of guessing', () => {
    expect(() => parseDialpadRecordingCapture(capture({ status: 'available' }) as never)).toThrow();
    expect(() => parseDialpadRecordingCapture(capture({ segments: null }) as never)).toThrow();
    expect(() => parseDialpadRecordingCapture(null)).toThrow();
    expect(() => parseDialpadRecordingCapture(capture({ segments: [{ track: 'speaker', epoch: 1 }] }) as never)).toThrow();
  });

  it('parses denials and refuses unknown reasons', () => {
    expect(parseDialpadRecordingOpenResult({ status: 'denied', reason: 'call_not_connected' })).toEqual({ status: 'denied', reason: 'call_not_connected' });
    expect(() => parseDialpadRecordingOpenResult({ status: 'denied', reason: 'because' })).toThrow();
    expect(parseDialpadRecordingGrantResult({ status: 'denied', reason: 'epoch_already_authorized' })).toMatchObject({ status: 'denied' });
    expect(parseDialpadRecordingConsumeResult({ status: 'denied', reason: 'consumed' })).toEqual({ status: 'denied', reason: 'consumed' });
    expect(() => parseDialpadRecordingConsumeResult({ status: 'consumed' })).toThrow();
  });

  it('parses the no-work and claimed seal responses', () => {
    expect(parseDialpadRecordingClaimResult({ status: 'none' })).toEqual({ status: 'none' });
    const claimed = parseDialpadRecordingClaimResult({
      status: 'claimed', claimToken: 't', attempt: 1, leaseExpiresAt: '2026-09-29T00:05:00Z', capture: capture({ status: 'sealing' }),
      finalPaths: [{ track: 'tab', epoch: 1, finalPath: 'o/c/final/1/tab' }],
    } as never);
    expect(claimed).toMatchObject({ status: 'claimed', attempt: 1, finalPaths: [{ track: 'tab', epoch: 1 }] });
  });

  it('parses explicit EOF and ordered claim-fenced seal inputs', () => {
    expect(parseDialpadRecordingEofResult({ status: 'replayed', captureId: 'c', track: 'tab', epoch: 1, seq: 4, sha256: 'a'.repeat(64) })).toMatchObject({ status: 'replayed', seq: 4 });
    expect(() => parseDialpadRecordingEofResult({ status: 'recorded', captureId: 'c', track: 'tab', epoch: 1, seq: 4, sha256: 'bad' })).toThrow();
    const result = parseDialpadRecordingSealInputs({
      status: 'ready', captureId: 'c', claimToken: 't', inputs: [
        { captureId: 'c', orgId: 'o', track: 'tab', epoch: 1, seq: 0, sizeBytes: 100, sha256: 'a'.repeat(64), storagePath: 'o/c/chunks/1/tab/00000000', isEof: false },
      ],
    });
    expect(result.inputs[0]).toMatchObject({ epoch: 1, seq: 0, isEof: false });
  });

  it('requires authoritative lifecycle flags and preserves provisional VAD threshold state', () => {
    const lifecycle = parseDialpadRecordingLifecycle({
      captureId: 'c', orgId: 'o', repUserId: 'r', intentId: 'i', callActivityId: 'a', providerCallId: 'p',
      captureStatus: 'open', callState: 'connected', connected: true, ended: false, acceptsLivePcm: true, allowsRetentionDrain: true,
      closedAt: null, closeReason: null, drainDeadlineAt: '2026-09-29T00:01:00Z',
      callStatus: { intentId: 'i', state: 'connected', connected: true, propertyId: 'p', expiresAt: '2026-09-29T00:10:00Z', dispatchAuthorizedAt: null, callActivityId: 'a', attemptId: null, startedAt: null, endedAt: null, durationSeconds: null, talkDurationSeconds: null },
    });
    expect(lifecycle.acceptsLivePcm).toBe(true);
    const vad = parseDialpadRecordingVadResult({
      status: 'recorded', captureId: 'c', track: 'tab', epoch: 1, batchId: 'b', rangeCount: 1, voicedSamples: '4800000',
      measurementStatus: 'provisional', highWaterEpoch: 1, highWaterEndSample: '4800000',
      threshold: { status: 'not_latched', thresholdSamples: '4800000' },
    });
    expect(vad).toMatchObject({ voicedSamples: 4_800_000, measurementStatus: 'provisional', threshold: { status: 'not_latched' } });
  });
});
