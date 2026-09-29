import { describe, expect, it, vi } from 'vitest';

import { createSupabaseDialpadRecordingShadowDb } from './shadow-measurement';

const digest = 'a'.repeat(64);

describe('createSupabaseDialpadRecordingShadowDb', () => {
  it('calls the service RPCs and preserves snapshot-only null eligibility', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: {
        algorithmVersion: 'provider-window-shadow-v1', inputDigest: digest, manifest: {}, observedSamples: 12,
        observedSamplesByEpoch: { '1': 12 }, eligibleSamples: null, timingStatus: 'unmapped', evidenceStatus: 'insufficient',
        reasons: ['timing_mapping_missing'], snapshotOnly: true,
      }, error: null })
      .mockResolvedValueOnce({ data: {
        version: 1, algorithmVersion: 'provider-window-shadow-v1', inputDigest: digest, evidenceStatus: 'insufficient',
        reasons: ['timing_mapping_missing'], observedSamples: 12, eligibleSamples: null, timingStatus: 'unmapped', replayed: false, snapshotOnly: true,
      }, error: null })
      .mockResolvedValueOnce({ data: {
        currentAtRead: true, currentInputDigest: digest, staleReason: null, snapshotOnly: true,
        measurement: {
          captureId: '00000000-0000-0000-0000-000000000001', orgId: '00000000-0000-0000-0000-000000000002',
          callActivityId: '00000000-0000-0000-0000-000000000003', intentId: '00000000-0000-0000-0000-000000000004',
          algorithmVersion: 'provider-window-shadow-v1', inputDigest: digest, evidenceManifest: {}, observedSamples: 12,
          observedSamplesByEpoch: { '1': 12 }, eligibleSamples: null, timingStatus: 'unmapped', evidenceStatus: 'insufficient',
          reasons: ['timing_mapping_missing'], evaluatedAt: '2026-09-29T00:00:00.000Z',
        },
      }, error: null });
    const db = createSupabaseDialpadRecordingShadowDb({ rpc } as never);

    expect(await db.getInput('org', 'capture')).toMatchObject({ inputDigest: digest, eligibleSamples: null, snapshotOnly: true });
    expect(await db.finalize('org', 'capture', digest)).toMatchObject({ inputDigest: digest, replayed: false, eligibleSamples: null });
    expect((await db.getMeasurement('org', 'capture')).measurement).toMatchObject({ inputDigest: digest, timingStatus: 'unmapped' });
    expect(rpc).toHaveBeenNthCalledWith(1, 'fn_get_dialpad_recording_shadow_input', { p_org_id: 'org', p_capture_id: 'capture' });
    expect(rpc).toHaveBeenNthCalledWith(2, 'fn_finalize_dialpad_recording_shadow', { p_org_id: 'org', p_capture_id: 'capture', p_expected_input_digest: digest });
    expect(rpc).toHaveBeenNthCalledWith(3, 'fn_get_dialpad_recording_shadow_measurement', { p_org_id: 'org', p_capture_id: 'capture' });
  });

  it('rejects a provider response that invents eligibility or a non-shadow timing status', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {
      algorithmVersion: 'provider-window-shadow-v1', inputDigest: digest, manifest: {}, observedSamples: 0,
      observedSamplesByEpoch: {}, eligibleSamples: 1, timingStatus: 'mapped', evidenceStatus: 'insufficient',
      reasons: ['timing_mapping_missing'], snapshotOnly: true,
    }, error: null });
    const db = createSupabaseDialpadRecordingShadowDb({ rpc } as never);
    await expect(db.getInput('org', 'capture')).rejects.toThrow('Invalid Dialpad shadow input');
  });
});
