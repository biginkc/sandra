import { describe, expect, it, vi } from 'vitest';
import { getDialpadPlaybackFile, signDialpadPlaybackFile } from './playback';

const valid = {
  id: `dpf_${'a'.repeat(64)}`,
  duration: 4.25,
  status: 'available',
  kind: 'stored',
  source: 'dialpad',
  track: 'tab',
  epoch: 1,
  completeness: 'partial',
  partialReason: 'missing_eof',
  recordingStatus: 'partial',
  captureId: '10000000-0000-4000-8000-000000000010',
  orgId: '00000000-0000-0000-0000-000000000bbb',
  bucket: 'dialpad-recordings',
  storagePath: '00000000-0000-0000-0000-000000000bbb/10000000-0000-4000-8000-000000000010/final/1/tab',
} as const;

function dbWithRpc(data: unknown) {
  return { rpc: vi.fn().mockResolvedValue({ data, error: null }) } as never;
}

describe('Dialpad playback DAL', () => {
  it('drops a database response whose path is not the registered final path', async () => {
    const db = dbWithRpc({ callId: 'call:one', source: 'dialpad', file: { ...valid, storagePath: 'org/guessed/path' } });
    await expect(getDialpadPlaybackFile('10000000-0000-4000-8000-000000000001', 'mine', valid.id, db)).resolves.toBeNull();
  });

  it('signs only the private final path and validates the signed URL', async () => {
    const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: 'https://audio.example/signed' }, error: null });
    const db = { rpc: vi.fn().mockResolvedValue({ data: { callId: 'call:one', source: 'dialpad', file: valid }, error: null }), storage: { from: vi.fn().mockReturnValue({ createSignedUrl }) } } as unknown as { storage: { from: ReturnType<typeof vi.fn> } };
    const signed = await signDialpadPlaybackFile('10000000-0000-4000-8000-000000000001', 'mine', valid.id, db as never);
    expect(db.storage.from).toHaveBeenCalledWith('dialpad-recordings');
    expect(createSignedUrl).toHaveBeenCalledWith(valid.storagePath, 60);
    expect(signed.signedUrl).toBe('https://audio.example/signed');
  });
});
