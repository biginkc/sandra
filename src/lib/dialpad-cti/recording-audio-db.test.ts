import { describe, expect, it, vi } from 'vitest';

import { createSupabaseAudioStorage, createSupabaseRecordingAudioDb, dialpadAudioBucketReady, type AudioSupabaseClient } from './recording-audio-db';

const client = (over: Partial<AudioSupabaseClient> = {}): AudioSupabaseClient => ({
  rpc: vi.fn(async () => ({ data: null, error: null })),
  storage: { getBucket: vi.fn(), from: vi.fn() } as unknown as AudioSupabaseClient['storage'],
  ...over,
});

describe('bucketReady', () => {
  const bucket = (data: unknown) => client({ storage: { getBucket: async () => ({ data, error: null }), from: vi.fn() } as unknown as AudioSupabaseClient['storage'] });
  it('accepts exactly the private 32 MB audio/mpeg bucket', async () => {
    expect(await dialpadAudioBucketReady(bucket({ public: false, file_size_limit: 33554432, allowed_mime_types: ['audio/mpeg'] }))).toBe(true);
  });
  it.each([
    [{ public: true, file_size_limit: 33554432, allowed_mime_types: ['audio/mpeg'] }],
    [{ public: false, file_size_limit: 536870912, allowed_mime_types: ['audio/mpeg'] }],
    [{ public: false, file_size_limit: null, allowed_mime_types: ['audio/mpeg'] }],
    [{ public: false, file_size_limit: 33554432, allowed_mime_types: ['audio/mpeg', 'audio/wav'] }],
    [{ public: false, file_size_limit: 33554432, allowed_mime_types: null }],
    [null],
  ])('a missing or different bucket (%j) is not ready', async (data) => {
    expect(await dialpadAudioBucketReady(bucket(data))).toBe(false);
  });
  it('an error or a throw is not ready', async () => {
    expect(await dialpadAudioBucketReady(client({ storage: { getBucket: async () => ({ data: null, error: { message: 'x' } }), from: vi.fn() } as unknown as AudioSupabaseClient['storage'] }))).toBe(false);
    expect(await dialpadAudioBucketReady(client({ storage: { getBucket: async () => { throw new Error('down'); }, from: vi.fn() } as unknown as AudioSupabaseClient['storage'] }))).toBe(false);
  });
});

describe('db adapter', () => {
  it('maps the queue, dropping malformed rows, and parses dates to milliseconds', async () => {
    const rpc = vi.fn(async (fn: string) => {
      if (fn === 'fn_dpa_worker_take') return { data: { taken: true, lastRequestAt: '2026-10-06T12:00:10+00:00', lastCallGetAt: null, blockedUntil: '2026-10-06T14:00:00Z' }, error: null };
      return { data: {
        cleanup: [{ id: 'a', audioId: 'b', orgId: 'o', state: 'live', shareLinkId: 'L', itemId: 'i', createdById: 'c', callId: 'k', keyRef: 'env:X' }, { id: 'bad' }],
        ambiguous: [{ id: 'a', audioId: 'b', reason: 'mismatch', shareLinkId: null }],
        uploading: [{ id: 'u', orgId: 'o', callActivityId: 'c', providerRecordingId: 'r', storagePath: 'p', expectedSha256: 's', expectedSize: 5, providerDurationMs: null }],
        download: { id: 'd', orgId: 'o', callActivityId: 'c', providerCallId: '1', providerRecordingId: 'r', providerDurationMs: 36000, keyRef: null },
        discovery: [{ id: 'x', orgId: 'o', providerCallId: '1', endedAt: '2026-10-06T12:00:00Z', attempts: 2, keyRef: 'env:X' }],
        deniedOrgs: [{ orgId: 'o', keyRef: 'env:X' }],
      }, error: null };
    });
    const db = createSupabaseRecordingAudioDb(client({ rpc }));
    expect(await db.take('h')).toEqual({ taken: true, lastRequestAt: Date.parse('2026-10-06T12:00:10Z'), lastCallGetAt: null, blockedUntil: Date.parse('2026-10-06T14:00:00Z') });
    const q = await db.queue('h', 4);
    expect(q.cleanup).toHaveLength(1);
    expect(q.cleanup[0]).toMatchObject({ shareLinkId: 'L', keyRef: 'env:X' });
    expect(q.ambiguous[0]).toMatchObject({ reason: 'mismatch' });
    expect(q.uploading[0]).toMatchObject({ expectedSize: 5 });
    expect(q.download).toMatchObject({ id: 'd', providerDurationMs: 36000 });
    expect(q.discovery[0]).toMatchObject({ attempts: 2 });
    expect(q.deniedOrgs).toEqual([{ orgId: 'o', keyRef: 'env:X' }]);
    expect(rpc).toHaveBeenCalledWith('fn_dpa_queue', { p_holder: 'h', p_discovery_limit: 4 });
  });

  it('an empty queue has no download; an RPC error throws with the code only', async () => {
    const empty = createSupabaseRecordingAudioDb(client({ rpc: async () => ({ data: { cleanup: [], ambiguous: [], uploading: [], download: null, discovery: [], deniedOrgs: [] }, error: null }) }));
    expect((await empty.queue('h', 4)).download).toBeNull();
    const failing = createSupabaseRecordingAudioDb(client({ rpc: async () => ({ data: null, error: { code: '57014', message: 'secret detail' } }) }));
    await expect(failing.take('h')).rejects.toThrow('fn_dpa_worker_take failed (57014)');
  });

  it('writes the exact RPC argument names the migration declares', async () => {
    const rpc = vi.fn<AudioSupabaseClient['rpc']>(async () => ({ data: { blocked: false, attemptId: 'att' }, error: null }));
    const db = createSupabaseRecordingAudioDb(client({ rpc }));
    await db.attemptBegin('h', 'audio');
    await db.attemptSet('h', 'att', 'ambiguous', { reason: 'mismatch' });
    await db.audioFail('h', 'audio', 'denied', { error: '403', keyFp: 'f'.repeat(16) });
    await db.markUploading('h', 'audio', 's', 10, 36000);
    await db.registerStored('h', 'audio', 'path', 10, 's', 36000);
    await db.discoveryResult('h', 'audio', 'one', { recordingId: 'r', durationMs: 36000 });
    await db.requeueDenied('h', 'org', 'f'.repeat(16));
    await db.block('h', Date.parse('2026-10-06T14:00:00Z'));
    await db.release('h', Date.parse('2026-10-06T12:00:10Z'), null);
    expect(rpc.mock.calls.map(([fn, args]) => [fn, Object.keys(args ?? {})])).toEqual([
      ['fn_dpa_attempt_begin', ['p_holder', 'p_audio_id']],
      ['fn_dpa_attempt_set', ['p_holder', 'p_attempt_id', 'p_to', 'p_reason', 'p_share_link_id', 'p_item_id', 'p_created_by_id', 'p_call_id']],
      ['fn_dpa_audio_fail', ['p_holder', 'p_audio_id', 'p_kind', 'p_error', 'p_key_fp', 'p_warning']],
      ['fn_dpa_mark_uploading', ['p_holder', 'p_audio_id', 'p_sha256', 'p_size', 'p_decoded_ms']],
      ['fn_dpa_register_stored', ['p_holder', 'p_audio_id', 'p_path', 'p_size', 'p_sha256', 'p_decoded_ms']],
      ['fn_dpa_discovery_result', ['p_holder', 'p_audio_id', 'p_outcome', 'p_recording_id', 'p_duration_ms', 'p_key_fp', 'p_error']],
      ['fn_dpa_requeue_denied', ['p_holder', 'p_org_id', 'p_key_fp']],
      ['fn_dpa_worker_block', ['p_holder', 'p_until']],
      ['fn_dpa_worker_release', ['p_holder', 'p_last_request_at', 'p_last_call_get_at']],
    ]);
  });
});

describe('storage adapter', () => {
  const storage = (bucket: Record<string, unknown>) => createSupabaseAudioStorage(client({ storage: { getBucket: vi.fn(), from: vi.fn(() => bucket) } as unknown as AudioSupabaseClient['storage'] }));
  it('uploads with upsert off as audio/mpeg; a duplicate is `exists`; any other error throws without detail', async () => {
    const upload = vi.fn()
      .mockResolvedValueOnce({ data: {}, error: null })
      .mockResolvedValueOnce({ data: null, error: { statusCode: '409', message: 'The resource already exists' } })
      .mockResolvedValueOnce({ data: null, error: { statusCode: '500', message: 'secret' } });
    const s = storage({ upload });
    expect(await s.upload('p', new Uint8Array([1]))).toBe('ok');
    expect(upload).toHaveBeenCalledWith('p', expect.any(Uint8Array), expect.objectContaining({ contentType: 'audio/mpeg', upsert: false }));
    expect(await s.upload('p', new Uint8Array([1]))).toBe('exists');
    await expect(s.upload('p', new Uint8Array([1]))).rejects.toThrow('audio upload failed (500)');
  });
  it('downloads bytes, maps not-found to null and other errors to a throw', async () => {
    const download = vi.fn()
      .mockResolvedValueOnce({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null })
      .mockResolvedValueOnce({ data: null, error: { statusCode: '404', message: 'Object not found' } })
      .mockResolvedValueOnce({ data: null, error: { statusCode: '503', message: 'down' } });
    const s = storage({ download });
    expect(await s.download('p')).toEqual(new Uint8Array([1, 2, 3]));
    expect(await s.download('p')).toBeNull();
    await expect(s.download('p')).rejects.toThrow('audio download failed (503)');
  });
  it('removes by path', async () => {
    const remove = vi.fn(async () => ({ data: [], error: null }));
    await storage({ remove }).remove('p');
    expect(remove).toHaveBeenCalledWith(['p']);
  });
});
