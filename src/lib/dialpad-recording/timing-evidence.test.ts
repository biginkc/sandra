import { describe, expect, it, vi } from 'vitest'

import {
  createSupabaseDialpadTimingDb,
  encodeDialpadTimingBatch,
  parseDialpadTimingRecord,
  type DialpadTimingAnchor,
} from './timing-evidence'

const contextId = '00000000-0000-4000-8000-000000000001'
const batchId = '00000000-0000-4000-8000-000000000002'
const anchor: DialpadTimingAnchor = {
  kind: 'anchor', track: 'tab', seq: 0, contextId, anchor: 'start', contextFrame: 123,
  sourceCursor: 0, blockLength: 128, sourceRateHz: 48_000, outputCursor: 0,
  outputFrameIndex: 0, phaseNumerator: 0, continuity: 'continuous',
  previousContextEndFrame: null, discardedTailSamples: null,
  uncertainOutputStartSample: null, uncertainOutputEndSample: null,
}

describe('Dialpad timing evidence', () => {
  it('strictly parses diagnostic records and enforces the 12 KiB wire bound', () => {
    expect(parseDialpadTimingRecord(anchor)).toEqual(anchor)
    expect(() => parseDialpadTimingRecord({ ...anchor, extra: true })).toThrow('Invalid Dialpad timing anchor')
    expect(() => encodeDialpadTimingBatch(1, batchId, Array.from({ length: 16 }, (_, seq) => ({ ...anchor, seq, contextId: `${contextId.slice(0, -1)}${(seq % 9) + 1}` })))).not.toThrow()
    expect(() => encodeDialpadTimingBatch(1, batchId, [{ ...anchor, uncertainOutputStartSample: Number.MAX_SAFE_INTEGER }])).not.toThrow()
  })

  it('uses only the two service RPCs and rejects invented terminal status', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { status: 'recorded', recordCount: 1, captureRecordCount: 1 }, error: null })
      .mockResolvedValueOnce({ data: { status: 'incomplete', reasons: ['persistence_failed'] }, error: null })
    const db = createSupabaseDialpadTimingDb({ rpc } as never)
    await expect(db.append('org', 'capture', 1, batchId, [anchor])).resolves.toEqual({ status: 'recorded', recordCount: 1, captureRecordCount: 1 })
    await expect(db.finish('org', 'capture', 1, { tabAnchor: 0, micAnchor: -1, tabContext: 0, micContext: -1, exchange: -1 }, 'collected', [])).resolves.toEqual({ status: 'incomplete', reasons: ['persistence_failed'] })
    expect(rpc).toHaveBeenNthCalledWith(1, 'fn_append_dialpad_recording_timing', expect.objectContaining({ p_org_id: 'org', p_capture_id: 'capture', p_epoch: 1, p_batch_id: batchId }))
    expect(rpc).toHaveBeenNthCalledWith(2, 'fn_finish_dialpad_recording_timing', expect.objectContaining({ p_outcome: 'collected' }))
    const badRpc = vi.fn().mockResolvedValue({ data: { status: 'finalized', reasons: [] }, error: null })
    await expect(createSupabaseDialpadTimingDb({ rpc: badRpc } as never).finish('org', 'capture', 1, { tabAnchor: -1, micAnchor: -1, tabContext: -1, micContext: -1, exchange: -1 }, 'incomplete', [])).rejects.toThrow('Invalid Dialpad timing finish response')
  })
})
