import { describe, expect, it, vi } from 'vitest';
import { createSupabaseDialpadRecordingFinalizerDb } from './provider-window-finalizer';

const digest = 'a'.repeat(64);
const base = { algorithmVersion: 'provider-window-finalizer-v1', policyVersion: 'fixture-v1', policyHash: digest, epoch: 1, inputDigest: digest, observedSamples: 4_800_001, eligibleSamples: 4_800_001, status: 'eligible', reasons: ['eligible'], sampleWindow: { lowerSample: 0, upperSample: 4_800_001 }, selectedSummary: {} };

describe('provider-window finalizer adapter', () => {
  it('calls service RPCs and strictly parses the numeric result', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: base, error: null })
      .mockResolvedValueOnce({ data: { ...base, replayed: false }, error: null })
      .mockResolvedValueOnce({ data: { status: 'eligible', currentAtRead: true, currentInputDigest: digest, result: { captureId: 'capture', observedSamples: 4_800_001, eligibleSamples: 4_800_001, status: 'eligible', reasons: ['eligible'], evaluatedAt: '2026-09-29T00:00:00.000Z' } }, error: null });
    const db = createSupabaseDialpadRecordingFinalizerDb({ rpc } as never);
    expect(await db.getInput('org', 'capture', 'fixture-v1')).toMatchObject({ eligibleSamples: 4_800_001 });
    expect(await db.finalize('org', 'capture', 'fixture-v1', digest)).toMatchObject({ replayed: false });
    expect(await db.getResult('org', 'rep', 'capture')).toMatchObject({ status: 'eligible', currentAtRead: true });
    expect(rpc).toHaveBeenNthCalledWith(1, 'fn_get_dialpad_recording_final_input', { p_org_id: 'org', p_capture_id: 'capture', p_policy_version: 'fixture-v1' });
    expect(rpc).toHaveBeenNthCalledWith(2, 'fn_finalize_dialpad_recording_provider_window', { p_org_id: 'org', p_capture_id: 'capture', p_policy_version: 'fixture-v1', p_expected_input_digest: digest });
  });

  it('rejects a response that claims unknown while supplying eligible samples', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ...base, status: 'unknown', eligibleSamples: 1 }, error: null });
    const db = createSupabaseDialpadRecordingFinalizerDb({ rpc } as never);
    await expect(db.getInput('org', 'capture', 'fixture-v1')).rejects.toThrow('Unknown finalizer input');
  });
});
