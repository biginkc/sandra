import type { AudioStorage, AttemptReason, AttemptState, AudioFailKind, DiscoveryOutcome, QueueAmbiguous, QueueAttempt, QueueDenied, QueueDiscovery, QueueDownload, QueueUploading, RecordingAudioDb, RecordingQueue, TakeResult } from './recording-audio';
import { AUDIO_BUCKET, MAX_AUDIO_BYTES } from './recording-audio';

type RpcError = { code?: string; message?: string } | null;
type RpcResult = PromiseLike<{ data: unknown; error: RpcError }>;

/** The slice of the Supabase admin client the worker uses. The new RPCs are not in the generated types. */
export interface AudioSupabaseClient {
  rpc(fn: string, args?: Record<string, unknown>): RpcResult;
  storage: {
    getBucket(id: string): PromiseLike<{ data: { public?: boolean; file_size_limit?: number | null; allowed_mime_types?: string[] | null } | null; error: RpcError }>;
    from(bucket: string): {
      upload(path: string, body: Uint8Array, options: { contentType: string; upsert: boolean; cacheControl?: string }): PromiseLike<{ data: unknown; error: ({ message?: string; statusCode?: string | number; status?: number } & Record<string, unknown>) | null }>;
      download(path: string): PromiseLike<{ data: Blob | null; error: ({ message?: string; statusCode?: string | number; status?: number } & Record<string, unknown>) | null }>;
      remove(paths: string[]): PromiseLike<{ data: unknown; error: RpcError }>;
    };
  };
}

const obj = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const ms = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function fail(name: string, error: RpcError): never {
  throw new Error(`${name} failed (${error?.code ?? 'unknown'})`);
}

function parseQueue(data: unknown): RecordingQueue {
  const body = obj(data);
  if (!body) throw new Error('queue returned no object');
  const list = (key: string): Record<string, unknown>[] =>
    Array.isArray(body[key]) ? (body[key] as unknown[]).flatMap((item) => (obj(item) ? [obj(item)!] : [])) : [];
  const cleanup: QueueAttempt[] = list('cleanup').flatMap((r) => {
    const id = str(r.id), audioId = str(r.audioId), orgId = str(r.orgId), shareLinkId = str(r.shareLinkId);
    const itemId = str(r.itemId), createdById = str(r.createdById), callId = str(r.callId);
    return id && audioId && orgId && shareLinkId && itemId && createdById && callId && (r.state === 'live' || r.state === 'downloaded')
      ? [{ id, audioId, orgId, state: r.state, shareLinkId, itemId, createdById, callId, keyRef: str(r.keyRef) }]
      : [];
  });
  const ambiguous: QueueAmbiguous[] = list('ambiguous').flatMap((r) => {
    const id = str(r.id), audioId = str(r.audioId), reason = str(r.reason);
    return id && audioId && reason ? [{ id, audioId, reason, shareLinkId: str(r.shareLinkId) }] : [];
  });
  const uploading: QueueUploading[] = list('uploading').flatMap((r) => {
    const id = str(r.id), orgId = str(r.orgId), callActivityId = str(r.callActivityId), providerRecordingId = str(r.providerRecordingId);
    const storagePath = str(r.storagePath), expectedSha256 = str(r.expectedSha256), expectedSize = num(r.expectedSize);
    return id && orgId && callActivityId && providerRecordingId && storagePath && expectedSha256 && expectedSize !== null
      ? [{ id, orgId, callActivityId, providerRecordingId, storagePath, expectedSha256, expectedSize, providerDurationMs: num(r.providerDurationMs) }]
      : [];
  });
  const downloadRow = obj(body.download);
  let download: QueueDownload | null = null;
  if (downloadRow) {
    const id = str(downloadRow.id), orgId = str(downloadRow.orgId), callActivityId = str(downloadRow.callActivityId);
    const providerCallId = str(downloadRow.providerCallId), providerRecordingId = str(downloadRow.providerRecordingId);
    const providerDurationMs = num(downloadRow.providerDurationMs);
    if (id && orgId && callActivityId && providerCallId && providerRecordingId && providerDurationMs !== null) {
      download = { id, orgId, callActivityId, providerCallId, providerRecordingId, providerDurationMs, keyRef: str(downloadRow.keyRef) };
    }
  }
  const discovery: QueueDiscovery[] = list('discovery').flatMap((r) => {
    const id = str(r.id), orgId = str(r.orgId), providerCallId = str(r.providerCallId), endedAt = str(r.endedAt), attempts = num(r.attempts);
    return id && orgId && providerCallId && endedAt && attempts !== null ? [{ id, orgId, providerCallId, endedAt, attempts, keyRef: str(r.keyRef) }] : [];
  });
  const deniedOrgs: QueueDenied[] = list('deniedOrgs').flatMap((r) => {
    const orgId = str(r.orgId);
    return orgId ? [{ orgId, keyRef: str(r.keyRef) }] : [];
  });
  return { cleanup, ambiguous, uploading, download, discovery, deniedOrgs };
}

export function createSupabaseRecordingAudioDb(client: AudioSupabaseClient): RecordingAudioDb {
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await client.rpc(name, args);
    if (error) fail(name, error);
    return data;
  };
  return {
    async take(holder): Promise<TakeResult> {
      const body = obj(await call('fn_dpa_worker_take', { p_holder: holder }));
      if (!body) throw new Error('take returned no object');
      return {
        taken: body.taken === true,
        lastRequestAt: ms(body.lastRequestAt),
        lastCallGetAt: ms(body.lastCallGetAt),
        blockedUntil: ms(body.blockedUntil),
      };
    },
    async release(holder, lastRequestAt, lastCallGetAt) {
      await call('fn_dpa_worker_release', {
        p_holder: holder,
        p_last_request_at: lastRequestAt === null ? null : new Date(lastRequestAt).toISOString(),
        p_last_call_get_at: lastCallGetAt === null ? null : new Date(lastCallGetAt).toISOString(),
      });
    },
    async block(holder, untilMs) {
      await call('fn_dpa_worker_block', { p_holder: holder, p_until: new Date(untilMs).toISOString() });
    },
    async queue(holder, discoveryLimit) {
      return parseQueue(await call('fn_dpa_queue', { p_holder: holder, p_discovery_limit: discoveryLimit }));
    },
    async discoveryResult(holder, audioId, outcome: DiscoveryOutcome, extra = {}) {
      await call('fn_dpa_discovery_result', {
        p_holder: holder, p_audio_id: audioId, p_outcome: outcome,
        p_recording_id: extra.recordingId ?? null, p_duration_ms: extra.durationMs ?? null,
        p_key_fp: extra.keyFp ?? null, p_error: extra.error ?? null,
      });
    },
    async requeueDenied(holder, orgId, keyFp) {
      const count = await call('fn_dpa_requeue_denied', { p_holder: holder, p_org_id: orgId, p_key_fp: keyFp });
      return typeof count === 'number' ? count : 0;
    },
    async attemptBegin(holder, audioId) {
      const body = obj(await call('fn_dpa_attempt_begin', { p_holder: holder, p_audio_id: audioId }));
      if (!body) throw new Error('attempt begin returned no object');
      if (body.blocked === true) return { blocked: true };
      const attemptId = str(body.attemptId);
      if (!attemptId) throw new Error('attempt begin returned no id');
      return { blocked: false, attemptId };
    },
    async attemptSet(holder, attemptId, to: AttemptState, extra: { reason?: AttemptReason; shareLinkId?: string | null; itemId?: string | null; createdById?: string | null; callId?: string | null } = {}) {
      await call('fn_dpa_attempt_set', {
        p_holder: holder, p_attempt_id: attemptId, p_to: to, p_reason: extra.reason ?? null,
        p_share_link_id: extra.shareLinkId ?? null, p_item_id: extra.itemId ?? null,
        p_created_by_id: extra.createdById ?? null, p_call_id: extra.callId ?? null,
      });
    },
    async audioFail(holder, audioId, kind: AudioFailKind, extra = {}) {
      await call('fn_dpa_audio_fail', { p_holder: holder, p_audio_id: audioId, p_kind: kind, p_error: extra.error ?? null, p_key_fp: extra.keyFp ?? null, p_warning: extra.warning ?? null });
    },
    async markUploading(holder, audioId, sha256, size, decodedMs) {
      await call('fn_dpa_mark_uploading', { p_holder: holder, p_audio_id: audioId, p_sha256: sha256, p_size: size, p_decoded_ms: decodedMs });
    },
    async registerStored(holder, audioId, path, size, sha256, decodedMs) {
      await call('fn_dpa_register_stored', { p_holder: holder, p_audio_id: audioId, p_path: path, p_size: size, p_sha256: sha256, p_decoded_ms: decodedMs });
    },
  };
}

/** Private bucket, 32 MB, audio/mpeg only. Missing or different means the route stays disabled (`bucket`). */
export async function dialpadAudioBucketReady(client: AudioSupabaseClient): Promise<boolean> {
  try {
    const { data, error } = await client.storage.getBucket(AUDIO_BUCKET);
    if (error || !data) return false;
    const mimes = data.allowed_mime_types ?? [];
    return data.public === false && data.file_size_limit === MAX_AUDIO_BYTES && mimes.length === 1 && mimes[0] === 'audio/mpeg';
  } catch {
    return false;
  }
}

const isMissing = (error: { message?: string; statusCode?: string | number; status?: number }): boolean =>
  String(error.statusCode ?? error.status ?? '') === '404' || /not.?found/i.test(error.message ?? '');
const isDuplicate = (error: { message?: string; statusCode?: string | number; status?: number }): boolean =>
  String(error.statusCode ?? error.status ?? '') === '409' || /already exists|duplicate/i.test(error.message ?? '');

export function createSupabaseAudioStorage(client: AudioSupabaseClient): AudioStorage {
  const bucket = () => client.storage.from(AUDIO_BUCKET);
  return {
    async upload(path, bytes) {
      const { error } = await bucket().upload(path, bytes, { contentType: 'audio/mpeg', upsert: false, cacheControl: '3600' });
      if (!error) return 'ok';
      if (isDuplicate(error)) return 'exists';
      throw new Error(`audio upload failed (${String(error.statusCode ?? error.status ?? 'unknown')})`);
    },
    async download(path) {
      const { data, error } = await bucket().download(path);
      if (error) {
        if (isMissing(error)) return null;
        throw new Error(`audio download failed (${String(error.statusCode ?? error.status ?? 'unknown')})`);
      }
      return data ? new Uint8Array(await data.arrayBuffer()) : null;
    },
    async remove(path) {
      const { error } = await bucket().remove([path]);
      if (error) throw new Error(`audio remove failed (${error.code ?? 'unknown'})`);
    },
  };
}
