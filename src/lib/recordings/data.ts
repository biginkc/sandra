import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { SANDRA_ORG_ID } from '@/lib/auth/sandra-org';
import { hasActiveSandraAccess } from '@/lib/auth/access-state';
import type { RecordingFilters, RecordingScope } from './filters';

export class RecordingAccessError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export interface LibraryFile { id: string; duration: number | null; status: string; kind: string }
export interface LibraryCall {
  id: string; at: string; actor_id: string | null; actor_name: string; conflicting: boolean;
  source: string; outcome: string; direction: string; purpose: string; contact: string; address: string;
  phone: string | null; property_id: string | null; missing_association: boolean;
  transcript: boolean; summary: boolean; status: string; files: LibraryFile[];
}
export interface LibraryResult {
  rows: LibraryCall[]; total: number; availability: Record<string, number>;
  sources: string[]; outcomes: string[]; users: { id: string; name: string }[];
}
interface SourceCall { id: string; attemptId: string; scopeId: string; summaryPath?: string | null }
interface AudioCall { id: string; actorId: string | null; files: { id: string; duration: number | null; status: string; matchesSummary: boolean }[] }

export async function recordingViewer() {
  const db = await createClient();
  const { data: { user }, error: authError } = await db.auth.getUser();
  if (authError || !user) throw new RecordingAccessError(401, 'Sign in to view recordings');
  const { data, error } = await db.from('memberships')
    .select('role,acquisitions_enabled,access_status,access_expires_at,deletion_prepared_at')
    .eq('user_id', user.id).eq('org_id', SANDRA_ORG_ID).maybeSingle();
  if (error) throw new RecordingAccessError(503, 'Recording permissions are unavailable');
  const active = data?.access_status === 'active' && hasActiveSandraAccess(data);
  return { userId: user.id, owner: Boolean(active && data?.role === 'owner'), mine: Boolean(active && data?.acquisitions_enabled) };
}
export async function requireRecordingViewer(scope: RecordingScope) {
  const viewer = await recordingViewer();
  if (!(scope === 'owner' ? viewer.owner : viewer.mine)) throw new RecordingAccessError(403, 'You do not have access to this recording library');
  return viewer;
}
async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const db: SupabaseClient = createAdminClient();
  const { data, error } = await db.rpc(name, args);
  if (error) throw new RecordingAccessError(error.code === '42501' ? 403 : 503, error.code === '42501' ? 'Recording access has changed' : 'Recording catalog unavailable');
  return data as T;
}
async function broker(body: unknown) {
  const base = process.env.JITTER_API_BASE_URL;
  const token = process.env.JITTER_SANDRA_PLAYBACK_TOKEN;
  let url: URL;
  try {
    if (!base || !token) throw new Error();
    url = new URL('/api/internal/sandra/recording-library', base);
    if (url.protocol !== 'https:') throw new Error();
  } catch { throw new RecordingAccessError(503, 'Recording service is not configured'); }
  try {
    const response = await fetch(url, { method: 'POST', cache: 'no-store', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new RecordingAccessError(response.status === 404 ? 404 : 503, 'Recording service is unavailable');
    return await response.json() as Record<string, unknown>;
  } catch (e) {
    if (e instanceof RecordingAccessError) throw e;
    throw new RecordingAccessError(503, 'Recording service is unavailable');
  }
}
async function audioCatalog(userId: string, scope: RecordingScope, callId?: string) {
  const allowedSources = await rpc<SourceCall[]>('fn_recording_library_sources', { p_actor: userId, p_scope: scope });
  const sources = callId ? allowedSources.filter(c => c.id === callId) : allowedSources;
  const audio: AudioCall[] = [];
  // Each batch is tenant-scoped by the database; the broker independently
  // attests caller identity before the database applies self scope. No credentials or
  // cross-project calls reach the browser. Fail closed rather than return partial counts.
  for (let i = 0; i < sources.length; i += 100) {
    const calls = sources.slice(i, i + 100).map(c => ({ ...c, summaryPath: c.summaryPath ?? undefined }));
    const body = await broker({ calls });
    if (!Array.isArray(body.calls) || body.calls.length !== calls.length) throw new RecordingAccessError(503, 'Recording inventory is incomplete');
    const expected = new Set(calls.map(c => c.id));
    for (const item of body.calls as AudioCall[]) {
      if (!expected.delete(item.id) || (item.actorId !== null && (typeof item.actorId !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.actorId))) || !Array.isArray(item.files) || item.files.some(f => typeof f.id !== 'string' || !f.id || !['available','pending','failed','missing'].includes(f.status) || (f.duration !== null && (!Number.isFinite(f.duration) || f.duration < 0)))) throw new RecordingAccessError(503, 'Invalid recording inventory');
      audio.push(item);
    }
  }
  return audio;
}
export async function listRecordings(scope: RecordingScope, filters: RecordingFilters) {
  const viewer = await requireRecordingViewer(scope);
  const audio = await audioCatalog(viewer.userId, scope);
  // Database rechecks current membership after remote inventory lookup.
  const result = await rpc<LibraryResult>('fn_recording_library_search', { p_actor: viewer.userId, p_scope: scope, p_filters: filters, p_audio: audio });
  const hasMore = result.rows.length > 50;
  const rows = result.rows.slice(0, 50);
  const last = rows.at(-1);
  return { ...result, rows, nextCursor: hasMore && last ? JSON.stringify({ at: last.at, id: last.id }) : null, viewerId: viewer.userId };
}
interface PrivateFile { callId: string; source: string; file: LibraryFile & { url?: string; recordingId?: string; attemptKey?: string; scopeKey?: string } }
async function getFile(scope: RecordingScope, id: string) {
  if (!id || id.length > 500) throw new RecordingAccessError(400, 'Invalid recording');
  const viewer = await requireRecordingViewer(scope);
  const callId = /^jitter:([0-9a-f-]{36}):.+$/i.exec(id)?.[1]
    ?? await rpc<string | null>('fn_recording_library_file_parent', { p_actor: viewer.userId, p_scope: scope, p_file_id: id });
  const audio = callId ? await audioCatalog(viewer.userId, scope, callId) : [];
  const found = await rpc<PrivateFile | null>('fn_recording_library_file', { p_actor: viewer.userId, p_scope: scope, p_file_id: id, p_audio: audio });
  if (!found) throw new RecordingAccessError(404, 'Recording not found');
  return found;
}
export async function recordingDetails(scope: RecordingScope, id: string) {
  const { file } = await getFile(scope, id);
  return { id: file.id, duration: file.duration, status: file.status, kind: file.kind };
}
export async function recordingPlayback(scope: RecordingScope, id: string) {
  const { file, callId } = await getFile(scope, id);
  if (file.kind === 'reference' && file.url) {
    let external: URL;
    try { external = new URL(file.url); } catch { throw new RecordingAccessError(409, 'Unsupported recording reference'); }
    if (external.protocol !== 'https:' || external.username || external.password) throw new RecordingAccessError(409, 'Unsupported recording reference');
    return { externalUrl: external.href };
  }
  if (file.status !== 'available' || !file.recordingId || !file.attemptKey || !file.scopeKey) throw new RecordingAccessError(409, 'This recording reference is not available for playback');
  const body = await broker({ calls: [{ id: callId.slice('call:'.length), attemptId: file.attemptKey, scopeId: file.scopeKey }], recordingId: file.recordingId });
  if (typeof body.signedUrl !== 'string' || typeof body.expiresAt !== 'string') throw new RecordingAccessError(503, 'Invalid playback response');
  let url: URL;
  try { url = new URL(body.signedUrl); } catch { throw new RecordingAccessError(503, 'Invalid playback response'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new RecordingAccessError(503, 'Invalid playback response');
  // Do not deliver a newly issued link after an observed membership revocation.
  await requireRecordingViewer(scope);
  return { signedUrl: body.signedUrl, expiresAt: body.expiresAt };
}
