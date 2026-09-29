import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Database } from '@/lib/supabase/types';

export const DIALPAD_RECORDINGS_BUCKET = 'dialpad-recordings';
const SIGNED_URL_SECONDS = 60;

export interface DialpadPlaybackFile {
  id: string;
  duration: number | null;
  status: 'available';
  kind: 'stored';
  source: 'dialpad';
  track: 'tab' | 'mic';
  epoch: number;
  completeness: 'complete' | 'partial';
  partialReason: string | null;
  recordingStatus: 'sealed' | 'partial' | 'failed';
  captureId: string;
  orgId: string;
  bucket: typeof DIALPAD_RECORDINGS_BUCKET;
  storagePath: string;
}

export interface DialpadPlayback {
  callId: string;
  source: 'dialpad';
  file: DialpadPlaybackFile;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseFile(value: unknown): DialpadPlaybackFile | null {
  if (!value || typeof value !== 'object') return null;
  const file = value as Record<string, unknown>;
  if (typeof file.id !== 'string' || !/^dpf_[0-9a-f]{64}$/.test(file.id)) return null;
  if (file.status !== 'available' || file.kind !== 'stored' || file.source !== 'dialpad') return null;
  if (file.track !== 'tab' && file.track !== 'mic') return null;
  if (!Number.isInteger(file.epoch) || (file.epoch as number) < 1 || (file.epoch as number) > 16) return null;
  if (file.completeness !== 'complete' && file.completeness !== 'partial') return null;
  if (file.partialReason !== null && typeof file.partialReason !== 'string') return null;
  if (!['sealed', 'partial', 'failed'].includes(String(file.recordingStatus))) return null;
  if (!isUuid(file.captureId) || !isUuid(file.orgId) || file.bucket !== DIALPAD_RECORDINGS_BUCKET) return null;
  if (typeof file.storagePath !== 'string') return null;
  const expectedPath = `${file.orgId}/${file.captureId}/final/${file.epoch}/${file.track}`;
  if (file.storagePath !== expectedPath) return null;
  if (file.duration !== null && (typeof file.duration !== 'number' || !Number.isFinite(file.duration) || file.duration < 0)) return null;
  return {
    id: file.id,
    duration: file.duration as number | null,
    status: 'available',
    kind: 'stored',
    source: 'dialpad',
    track: file.track,
    epoch: file.epoch as number,
    completeness: file.completeness,
    partialReason: file.partialReason as string | null,
    recordingStatus: file.recordingStatus as DialpadPlaybackFile['recordingStatus'],
    captureId: file.captureId,
    orgId: file.orgId,
    bucket: DIALPAD_RECORDINGS_BUCKET,
    storagePath: file.storagePath,
  };
}

export async function getDialpadPlaybackFile(
  actorId: string,
  scope: 'owner' | 'mine',
  fileId: string,
  db: SupabaseClient<Database> = createAdminClient(),
): Promise<DialpadPlayback | null> {
  const { data, error } = await db.rpc('fn_dialpad_recording_playback_file', {
    p_actor: actorId,
    p_scope: scope,
    p_file_id: fileId,
  });
  if (error) throw error;
  if (!data || typeof data !== 'object') return null;
  const result = data as Record<string, unknown>;
  if (typeof result.callId !== 'string' || result.source !== 'dialpad') return null;
  const file = parseFile(result.file);
  return file ? { callId: result.callId, source: 'dialpad', file } : null;
}

async function signValidatedDialpadPlaybackFile(file: DialpadPlaybackFile, db: SupabaseClient<Database>) {
  const { data, error } = await db.storage.from(DIALPAD_RECORDINGS_BUCKET).createSignedUrl(file.storagePath, SIGNED_URL_SECONDS);
  if (error || typeof data?.signedUrl !== 'string') throw new Error('Unable to sign Dialpad recording');
  let url: URL;
  try { url = new URL(data.signedUrl); } catch { throw new Error('Unable to sign Dialpad recording'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Unable to sign Dialpad recording');
  return { signedUrl: data.signedUrl, expiresAt: new Date(Date.now() + SIGNED_URL_SECONDS * 1000).toISOString() };
}

export async function signDialpadPlaybackFile(
  actorId: string,
  scope: 'owner' | 'mine',
  fileId: string,
  db: SupabaseClient<Database> = createAdminClient(),
) {
  const found = await getDialpadPlaybackFile(actorId, scope, fileId, db);
  if (!found) throw new Error('Unable to sign Dialpad recording');
  return signValidatedDialpadPlaybackFile(found.file, db);
}
