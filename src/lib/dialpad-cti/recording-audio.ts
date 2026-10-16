import { createHash, randomUUID } from 'node:crypto';

import { reportError } from '@/lib/errors/report';

import { DIALPAD_API_ORIGIN, resolveDialpadDirectoryKey, type DialpadDirectoryEnv } from './directory';

/**
 * Dialpad call audio v1: Sandra keeps its own copy of the admin call recording (MP3).
 *
 * One strictly sequential worker (a singleton lease row; see `fn_dpa_worker_take`), driven by the cron route
 * `/api/cron/dialpad-recording-download`. The proven Dialpad flow is: create a company-privacy share link
 * (POST), download its `access_link` with the Bearer key (the link redirects once), then DELETE the link.
 * Nothing here runs until an org's `recording_download` flag is on; the artifact sweep is not touched.
 *
 * Timing contract (all anchored at the handler's first statement, `t0`; the deadline is never reset):
 *   deadline = t0 + 55 s (the last 5 s of Vercel's 60 s are kept for release + response)
 *   startup allowance 5 s (readiness, bucket check, take, blocked check, queue read), every DB/RPC/Storage-metadata
 *   call bounded to 1.5 s; startup not finished by t0 + 5 s releases and answers `slow_start` with zero requests.
 *   Every step is admitted only if `remaining >= its worst case` (ADMISSION below, each including its own DB
 *   writes). Any timeout stops the tick; rows keep their last committed state and later ticks recover them.
 *   An empty tick starts its download at <= t0 + 5 s, so remaining >= 50 s >= 49.5 s and a download is admitted.
 *
 * Pacing: one request in flight, at least 1 s between request starts (every redirect hop is its own request),
 * at least 8 s between call GETs (the endpoint allows 10 per minute). Both clocks persist across ticks.
 * 429: persist `recording_blocked_until` from Retry-After (no upper clamp), finish the row's own transition,
 * stop the tick. Never logs or stores a URL, key or response body.
 */

export const AUDIO_BUCKET = 'dialpad-call-audio';
export const MAX_AUDIO_BYTES = 32 * 1024 * 1024;

export const TICK_DEADLINE_MS = 55_000;
export const STARTUP_ALLOWANCE_MS = 5_000;
export const DB_TIMEOUT_MS = 1_500;
export const REQUEST_SPACING_MS = 1_000;
export const CALL_GET_SPACING_MS = 8_000;
export const HTTP_TIMEOUT_MS = 8_000;
export const AUDIO_GET_BUDGET_MS = 15_000;
export const DECODE_BUDGET_MS = 8_000;
export const STORAGE_TIMEOUT_MS = 10_000;
const MAX_REDIRECT_HOPS = 2;
const MIN_RETRY_AFTER_MS = 30_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const LONG_RETRY_AFTER_MS = 3_600_000;

/** Worst case of each step, including its own DB writes. A step starts only when `remaining >= ` its value. */
export const ADMISSION = {
  /** GET-by-id (1 + 8) + DB 1.5 + DELETE (1 + 8) + DB 1.5 */
  cleanup: 21_000,
  /** read 10 + decode 8 + remove 10 + DB 1.5: the widest branch is a matching object that fails decode and is removed */
  recover: 29_500,
  /** insert 1.5 + gap 1 + POST 8 + DB 1.5 + audio GET 15 + DB 1.5 + decode 8 + mark_uploading 1.5 + upload 10 + register 1.5 */
  download: 49_500,
  /** gap 1 + DELETE 8 + DB 1.5 */
  deleteOwn: 10_500,
  /** wait <= 8 + GET 8 + (on a 429) block 1.5 + record 1.5 */
  discovery: 19_000,
} as const;

/** The only host that gets the Authorization header, and the only host a hop may use. The canary records the real redirect host. */
export const AUDIO_HOST_ALLOWLIST: readonly string[] = ['dialpad.com'];

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DIGITS = /^[0-9]{1,20}$/;
const INT64_FIELDS = /"(id|call_id|item_id|created_by_id|company_id|master_call_id|user_id)"(\s*:\s*)(-?\d{1,20})(?=\s*[,}\]])/g;
const MAX_JSON_CHARS = 2_000_000;

export class RecordingTimeoutError extends Error {
  constructor(message = 'timeout') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** Stops the tick. Rows keep their last committed state. */
class TickStop extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'TickStop';
  }
}

export type AttemptState = 'requested' | 'live' | 'downloaded' | 'deleted' | 'not_sent' | 'not_created' | 'ambiguous';
export type AttemptReason = 'unknown_outcome' | 'mismatch' | 'post_mismatch';
export type AudioFailKind = 'error' | 'rate_limited' | 'invalid_media' | 'too_large' | 'decode_timeout' | 'denied' | 'recovery_reset';
export type DiscoveryOutcome = 'not_ready' | 'multi' | 'one' | 'denied' | 'error' | 'rate_limited';

export interface QueueAttempt {
  id: string; audioId: string; orgId: string; state: 'live' | 'downloaded';
  shareLinkId: string; itemId: string; createdById: string; callId: string; keyRef: string | null;
}
export interface QueueAmbiguous { id: string; audioId: string; reason: string; shareLinkId: string | null }
export interface QueueUploading {
  id: string; orgId: string; callActivityId: string; providerRecordingId: string; storagePath: string;
  expectedSha256: string; expectedSize: number; providerDurationMs: number | null;
}
export interface QueueDownload {
  id: string; orgId: string; callActivityId: string; providerCallId: string; providerRecordingId: string;
  providerDurationMs: number; keyRef: string | null;
}
export interface QueueDiscovery { id: string; orgId: string; providerCallId: string; endedAt: string; attempts: number; keyRef: string | null }
export interface QueueDenied { orgId: string; keyRef: string | null }
export interface RecordingQueue {
  cleanup: QueueAttempt[]; ambiguous: QueueAmbiguous[]; uploading: QueueUploading[];
  download: QueueDownload | null; discovery: QueueDiscovery[]; deniedOrgs: QueueDenied[];
}

export interface TakeResult { taken: boolean; lastRequestAt: number | null; lastCallGetAt: number | null; blockedUntil: number | null }

/** The database side. Every method is one PostgREST RPC; the worker bounds each call to 1.5 s. */
export interface RecordingAudioDb {
  take(holder: string): Promise<TakeResult>;
  release(holder: string, lastRequestAt: number | null, lastCallGetAt: number | null): Promise<void>;
  block(holder: string, untilMs: number): Promise<void>;
  queue(holder: string, discoveryLimit: number): Promise<RecordingQueue>;
  discoveryResult(holder: string, audioId: string, outcome: DiscoveryOutcome, extra?: { recordingId?: string; durationMs?: number; keyFp?: string; error?: string }): Promise<void>;
  requeueDenied(holder: string, orgId: string, keyFp: string): Promise<number>;
  attemptBegin(holder: string, audioId: string): Promise<{ blocked: true } | { blocked: false; attemptId: string }>;
  attemptSet(holder: string, attemptId: string, to: AttemptState, extra?: { reason?: AttemptReason; shareLinkId?: string | null; itemId?: string | null; createdById?: string | null; callId?: string | null }): Promise<void>;
  audioFail(holder: string, audioId: string, kind: AudioFailKind, extra?: { error?: string; keyFp?: string; warning?: string }): Promise<void>;
  markUploading(holder: string, audioId: string, sha256: string, size: number, decodedMs: number): Promise<void>;
  registerStored(holder: string, audioId: string, path: string, size: number, sha256: string, decodedMs: number): Promise<void>;
}

export interface AudioStorage {
  /** `exists` when an object is already at the path (never overwritten). */
  upload(path: string, bytes: Uint8Array): Promise<'ok' | 'exists'>;
  /** null when there is no object. */
  download(path: string): Promise<Uint8Array | null>;
  remove(path: string): Promise<void>;
}

export type DecodeResult = { ok: true; durationMs: number } | { ok: false; reason: 'invalid' | 'timeout' };

export type AudioFetchInit = { method: 'GET' | 'POST' | 'DELETE'; headers: Record<string, string>; body?: string; redirect: 'manual'; cache: 'no-store'; signal: AbortSignal };
export type AudioFetch = (url: string, init: AudioFetchInit) => Promise<Response>;

export interface RecordingAudioDeps {
  db: RecordingAudioDb;
  storage: AudioStorage;
  fetchImpl: AudioFetch;
  clock: { now(): number; sleep(ms: number): Promise<void> };
  decode: (bytes: Uint8Array, budgetMs: number) => Promise<DecodeResult>;
  env: DialpadDirectoryEnv;
  /** `schemaReady('dialpad_call_audio')`. */
  schemaReady: () => Promise<boolean>;
  /** The private bucket exists with the expected settings. */
  bucketReady: () => Promise<boolean>;
  /** Bounds an operation; rejects with a TimeoutError. Defaults to a real timer race. */
  bound?: <T>(ms: number, run: () => Promise<T>) => Promise<T>;
  /** A signal that aborts after `ms`. Defaults to AbortSignal.timeout. */
  signalFor?: (ms: number) => AbortSignal;
  holder?: string;
}

export interface RecordingTickSummary {
  status: 'disabled' | 'busy' | 'blocked' | 'slow_start' | 'idle' | 'ok' | 'stopped';
  reason?: string;
  requests: number;
  callGets: number;
  discovered: number;
  downloaded: number;
  stored: number;
  linksDeleted: number;
  recovered: number;
  ambiguous: number;
  /** Hostnames only, never a URL. */
  hosts: string[];
}

export function realBound<T>(ms: number, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RecordingTimeoutError()), ms);
  });
  return Promise.race([run(), timeout]).finally(() => clearTimeout(timer));
}

const isTimeout = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

export const keyFingerprint = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 16);
const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const hashId = (id: string): string => createHash('sha256').update(id).digest('hex').slice(0, 12);

function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (raw.length === 0 || raw.length > MAX_JSON_CHARS) return null;
  try {
    const parsed: unknown = JSON.parse(raw.replace(INT64_FIELDS, '"$1"$2"$3"'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A Dialpad id as text: a safe id string, or an integer (the int64 rewrite normally quotes it first). */
function idText(value: unknown): string | null {
  if (typeof value === 'string') return ID.test(value) ? value : null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date, floor 30 s, missing or unparseable 60 s, no upper clamp. */
export function parseRetryAfterMs(header: string | null, now: number): number {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const text = header.trim();
  let ms: number | null = null;
  if (/^[0-9]{1,9}$/.test(text)) ms = Number(text) * 1000;
  else {
    const at = Date.parse(text);
    if (Number.isFinite(at)) ms = at - now;
  }
  if (ms === null) return DEFAULT_RETRY_AFTER_MS;
  return Math.max(ms, MIN_RETRY_AFTER_MS);
}

/** The single admin recording of a call GET body: null = nothing usable yet. */
export type CallRecordingView =
  | { kind: 'none' }
  | { kind: 'multi' }
  | { kind: 'one'; recordingId: string; durationMs: number };

export function parseCallRecording(raw: string): CallRecordingView | null {
  const body = parseJsonObject(raw);
  if (!body) return null;
  const details = body.recording_details;
  if (details === undefined || details === null) return { kind: 'none' };
  if (!Array.isArray(details)) return null;
  const admin = details.filter((item): item is Record<string, unknown> =>
    Boolean(item) && typeof item === 'object' && (item as Record<string, unknown>).recording_type === 'admincallrecording');
  if (admin.length === 0) return { kind: 'none' };
  if (admin.length > 1) return { kind: 'multi' };
  const item = admin[0]!;
  const recordingId = idText(item.id);
  if (!recordingId) return null;
  const duration = item.duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return { kind: 'none' };
  return { kind: 'one', recordingId, durationMs: Math.round(duration) };
}

interface ShareLinkView { id: string | null; accessLink: string | null; itemId: string | null; createdById: string | null; callId: string | null }

export function parseShareLink(raw: string): ShareLinkView | null {
  const body = parseJsonObject(raw);
  if (!body) return null;
  return {
    id: idText(body.id),
    accessLink: typeof body.access_link === 'string' ? body.access_link : null,
    itemId: idText(body.item_id),
    createdById: idText(body.created_by_id),
    callId: idText(body.call_id),
  };
}

function validAudioUrl(raw: string, base?: string): URL | null {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  return url;
}

type DownloadResult =
  | { ok: true; bytes: Uint8Array; sha256: string }
  | { ok: false; kind: 'too_large' | 'error' | 'rate_limited' | 'timeout'; detail: string; retryAfter?: string | null; warning?: string };

class RecordingTick {
  private readonly deps: RecordingAudioDeps;
  private readonly holder: string;
  private readonly t0: number;
  readonly deadline: number;
  private readonly startupDeadline: number;
  private readonly bound: <T>(ms: number, run: () => Promise<T>) => Promise<T>;
  private readonly signalFor: (ms: number) => AbortSignal;
  private lastRequestAt: number | null = null;
  private lastCallGetAt: number | null = null;
  private taken = false;
  private readonly hosts = new Set<string>();
  readonly summary: RecordingTickSummary = {
    status: 'ok', requests: 0, callGets: 0, discovered: 0, downloaded: 0, stored: 0, linksDeleted: 0, recovered: 0, ambiguous: 0, hosts: [],
  };

  constructor(deps: RecordingAudioDeps, t0: number) {
    this.deps = deps;
    this.holder = deps.holder ?? randomUUID();
    this.t0 = t0;
    this.deadline = t0 + TICK_DEADLINE_MS;
    this.startupDeadline = t0 + STARTUP_ALLOWANCE_MS;
    this.bound = deps.bound ?? realBound;
    this.signalFor = deps.signalFor ?? ((ms) => AbortSignal.timeout(ms));
  }

  private now(): number {
    return this.deps.clock.now();
  }

  private remaining(): number {
    return this.deadline - this.now();
  }

  /** One DB/RPC/Storage-metadata call: bounded to 1.5 s. A timeout or failure stops the tick. */
  private async db<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await this.bound(DB_TIMEOUT_MS, run);
    } catch (error) {
      if (!isTimeout(error)) reportError(error, { tags: { surface: 'dialpad_recording_db' } });
      throw new TickStop(isTimeout(error) ? 'timeout' : 'db_error');
    }
  }

  private finish(status: RecordingTickSummary['status'], reason?: string): RecordingTickSummary {
    this.summary.status = status;
    if (reason) this.summary.reason = reason;
    this.summary.hosts = [...this.hosts].sort();
    return this.summary;
  }

  async run(): Promise<RecordingTickSummary> {
    const { deps } = this;
    try {
      // 1. Readiness. `schemaReady` takes no signal, so it is raced against the startup bound.
      let ready: boolean;
      try {
        ready = await this.bound(DB_TIMEOUT_MS, () => deps.schemaReady());
      } catch {
        return this.finish('slow_start', 'schema_check');
      }
      if (!ready) return this.finish('disabled', 'schema');
      let bucket: boolean;
      try {
        bucket = await this.bound(DB_TIMEOUT_MS, () => deps.bucketReady());
      } catch {
        return this.finish('slow_start', 'bucket_check');
      }
      if (!bucket) return this.finish('disabled', 'bucket');
      if (this.now() > this.startupDeadline) return this.finish('slow_start', 'startup');

      // 2. Singleton.
      let take: TakeResult;
      try {
        take = await this.bound(DB_TIMEOUT_MS, () => deps.db.take(this.holder));
      } catch {
        return this.finish('slow_start', 'take');
      }
      if (!take.taken) return this.finish('busy');
      this.taken = true;
      this.lastRequestAt = take.lastRequestAt;
      this.lastCallGetAt = take.lastCallGetAt;

      // 3. Blocked by an earlier 429.
      if (take.blockedUntil !== null && take.blockedUntil > this.now()) return this.finish('blocked');

      // 4. Queue read. Startup must be done by t0 + 5 s.
      const queue = await this.db(() => deps.db.queue(this.holder, 4));
      if (this.now() > this.startupDeadline) return this.finish('slow_start', 'startup');
      this.reportAmbiguous(queue.ambiguous);
      const work = queue.cleanup.length + queue.uploading.length + (queue.download ? 1 : 0) + queue.discovery.length + queue.deniedOrgs.length;
      if (work === 0) return this.finish(queue.ambiguous.length > 0 ? 'ok' : 'idle');

      await this.steps(queue);
      return this.finish('ok');
    } catch (error) {
      if (error instanceof TickStop) return this.finish('stopped', error.reason);
      reportError(error, { tags: { surface: 'dialpad_recording_tick' } });
      return this.finish('stopped', 'unexpected');
    } finally {
      if (this.taken) {
        try {
          await this.bound(DB_TIMEOUT_MS, () => deps.db.release(this.holder, this.lastRequestAt, this.lastCallGetAt));
        } catch (error) {
          reportError(error, { tags: { surface: 'dialpad_recording_release' } });
        }
      }
    }
  }

  private reportAmbiguous(rows: QueueAmbiguous[]): void {
    this.summary.ambiguous = rows.length;
    for (const row of rows) {
      reportError(new Error('Dialpad share link needs owner resolution'), {
        level: 'warning',
        tags: { surface: 'dialpad_share_link_ambiguous' },
        extra: { attempt: hashId(row.id), reason: row.reason, link: row.shareLinkId ? hashId(row.shareLinkId) : null },
      });
    }
  }

  private async steps(queue: RecordingQueue): Promise<void> {
    // a. cleanup of unresolved links Sandra created (always, regardless of flags and audio state)
    for (const attempt of queue.cleanup) {
      if (this.remaining() < ADMISSION.cleanup) break;
      await this.cleanupAttempt(attempt);
    }
    // b. upload recovery (no Dialpad request)
    for (const row of queue.uploading) {
      if (this.remaining() < ADMISSION.recover) break;
      await this.recoverUpload(row);
    }
    // c. one download (K = 1), then c'. its link
    if (queue.download && this.remaining() >= ADMISSION.download) {
      await this.download(queue.download);
    }
    // d. discovery call GETs
    for (const row of queue.discovery) {
      if (this.remaining() < ADMISSION.discovery) break;
      await this.discover(row);
    }
    // credential repair: DB only, never a request
    for (const denied of queue.deniedOrgs) {
      if (this.remaining() < 2 * DB_TIMEOUT_MS) break;
      const key = this.keyFor(denied.keyRef);
      if (!key) continue;
      await this.db(() => this.deps.db.requeueDenied(this.holder, denied.orgId, keyFingerprint(key)));
    }
  }

  private keyFor(ref: string | null): string | null {
    return resolveDialpadDirectoryKey(ref, this.deps.env);
  }

  // -- requests ---------------------------------------------------------------------------------------------

  /** Waits for the spacing gaps, then marks the request start. Returns false if the deadline passed while waiting. */
  private async gap(kind: 'call_get' | 'other'): Promise<boolean> {
    const earliest = Math.max(
      this.lastRequestAt === null ? 0 : this.lastRequestAt + REQUEST_SPACING_MS,
      kind === 'call_get' && this.lastCallGetAt !== null ? this.lastCallGetAt + CALL_GET_SPACING_MS : 0,
    );
    const wait = earliest - this.now();
    if (wait > 0) await this.deps.clock.sleep(wait);
    if (this.now() >= this.deadline) return false;
    return true;
  }

  private markStart(kind: 'call_get' | 'other'): void {
    const at = this.now();
    this.lastRequestAt = at;
    if (kind === 'call_get') {
      this.lastCallGetAt = at;
      this.summary.callGets += 1;
    }
    this.summary.requests += 1;
  }

  /** One paced request. Returns null when the deadline passed before it could start. Throws on a network error or timeout. */
  private async send(kind: 'call_get' | 'other', method: AudioFetchInit['method'], url: string, key: string | null, timeoutMs: number, body?: string): Promise<Response | null> {
    if (!(await this.gap(kind))) return null;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    this.markStart(kind);
    return this.deps.fetchImpl(url, { method, headers, ...(body !== undefined ? { body } : {}), redirect: 'manual', cache: 'no-store', signal: this.signalFor(timeoutMs) });
  }

  /** A 429: persist the block from Retry-After before anything else. The caller finishes its own transition, then stops. */
  private async blockFor(retryAfter: string | null): Promise<void> {
    const delta = parseRetryAfterMs(retryAfter, this.now());
    if (delta > LONG_RETRY_AFTER_MS) {
      reportError(new Error('Dialpad asked for a long Retry-After'), { level: 'warning', tags: { surface: 'dialpad_long_retry_after' }, extra: { minutes: Math.round(delta / 60_000) } });
    }
    await this.db(() => this.deps.db.block(this.holder, this.now() + delta));
  }

  private api(path: string): string {
    return `${DIALPAD_API_ORIGIN}${path}`;
  }

  private async text(response: Response, ms: number): Promise<string | null> {
    try {
      return await this.bound(ms, () => response.text());
    } catch {
      return null;
    }
  }

  // -- step a ---------------------------------------------------------------------------------------------

  private async cleanupAttempt(attempt: QueueAttempt): Promise<void> {
    const key = this.keyFor(attempt.keyRef);
    if (!key) {
      reportError(new Error('Dialpad link cleanup has no key'), { level: 'warning', tags: { surface: 'dialpad_recording_no_key' } });
      return;
    }
    if (!ID.test(attempt.shareLinkId)) return;
    const path = `/api/v2/recordingsharelink/${attempt.shareLinkId}`;
    let get: Response | null;
    try {
      get = await this.send('other', 'GET', this.api(path), key, HTTP_TIMEOUT_MS);
    } catch (error) {
      if (isTimeout(error)) throw new TickStop('timeout');
      return; // network error: unchanged, retried next tick
    }
    if (!get) return;
    if (get.status === 429) {
      await this.blockFor(get.headers.get('retry-after'));
      throw new TickStop('rate_limited');
    }
    if (get.status === 404) {
      await this.db(() => this.deps.db.attemptSet(this.holder, attempt.id, 'deleted'));
      this.summary.linksDeleted += 1;
      return;
    }
    if (get.status !== 200) return; // 401/403/5xx: unchanged, retried next tick
    const raw = await this.text(get, HTTP_TIMEOUT_MS);
    const view = raw === null ? null : parseShareLink(raw);
    const matches = view !== null && view.itemId === attempt.itemId && view.createdById === attempt.createdById && view.callId === attempt.callId;
    if (!matches) {
      // Never delete a link whose identity cannot be verified; it is retained, reported every tick, and owner-resolved.
      await this.db(() => this.deps.db.attemptSet(this.holder, attempt.id, 'ambiguous', { reason: 'mismatch' }));
      return;
    }
    await this.deleteLink(key, attempt.id, attempt.shareLinkId);
  }

  /** Paced DELETE of a link Sandra created and verified. 200/404 -> deleted; anything else leaves it for the next tick. */
  private async deleteLink(key: string, attemptId: string, shareLinkId: string): Promise<void> {
    let res: Response | null;
    try {
      res = await this.send('other', 'DELETE', this.api(`/api/v2/recordingsharelink/${shareLinkId}`), key, HTTP_TIMEOUT_MS);
    } catch (error) {
      if (isTimeout(error)) throw new TickStop('timeout');
      return;
    }
    if (!res) return;
    if (res.status === 429) {
      await this.blockFor(res.headers.get('retry-after'));
      throw new TickStop('rate_limited');
    }
    if (res.status === 200 || res.status === 404) {
      await this.db(() => this.deps.db.attemptSet(this.holder, attemptId, 'deleted'));
      this.summary.linksDeleted += 1;
    }
  }

  // -- step b ---------------------------------------------------------------------------------------------

  private async recoverUpload(row: QueueUploading): Promise<void> {
    // No Dialpad request here, ever.
    const bytes = await this.storageCall(() => this.deps.storage.download(row.storagePath));
    if (bytes === null) {
      await this.db(() => this.deps.db.audioFail(this.holder, row.id, 'recovery_reset', { error: 'object_missing' }));
      return;
    }
    const sha = sha256Hex(bytes);
    if (sha === row.expectedSha256 && bytes.length === row.expectedSize) {
      const decoded = await this.safeDecode(bytes);
      if (decoded.ok) {
        await this.db(() => this.deps.db.registerStored(this.holder, row.id, row.storagePath, bytes.length, sha, decoded.durationMs));
        this.summary.recovered += 1;
        this.summary.stored += 1;
        return;
      }
    }
    await this.storageCall(() => this.deps.storage.remove(row.storagePath));
    await this.db(() => this.deps.db.audioFail(this.holder, row.id, 'recovery_reset', { error: 'object_mismatch' }));
  }

  private async storageCall<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await this.bound(STORAGE_TIMEOUT_MS, run);
    } catch (error) {
      if (!isTimeout(error)) reportError(error, { tags: { surface: 'dialpad_recording_storage' } });
      throw new TickStop(isTimeout(error) ? 'timeout' : 'storage_error');
    }
  }

  // -- step c ---------------------------------------------------------------------------------------------

  private async download(row: QueueDownload): Promise<void> {
    const key = this.keyFor(row.keyRef);
    if (!key) {
      await this.db(() => this.deps.db.audioFail(this.holder, row.id, 'error', { error: 'no_key' }));
      return;
    }
    const begun = await this.db(() => this.deps.db.attemptBegin(this.holder, row.id));
    if (begun.blocked) return; // an unresolved link exists for this recording; step a / the owner resolve it
    const attemptId = begun.attemptId;
    const fail = (kind: AudioFailKind, error: string, extra: { keyFp?: string; warning?: string } = {}) =>
      this.db(() => this.deps.db.audioFail(this.holder, row.id, kind, { error, ...extra }));

    // POST (the gap runs after the insert; a deadline that passes while waiting leaves `not_sent`)
    let post: Response | null;
    try {
      post = await this.send('other', 'POST', this.api('/api/v2/recordingsharelink'), key, HTTP_TIMEOUT_MS,
        JSON.stringify({ recording_id: row.providerRecordingId, recording_type: 'admincallrecording', privacy: 'company' }));
    } catch (error) {
      await this.db(() => this.deps.db.attemptSet(this.holder, attemptId, 'ambiguous', { reason: 'unknown_outcome' }));
      await fail('error', isTimeout(error) ? 'post_timeout' : 'post_network');
      if (isTimeout(error)) throw new TickStop('timeout');
      return;
    }
    if (!post) {
      await this.db(() => this.deps.db.attemptSet(this.holder, attemptId, 'not_sent'));
      return;
    }
    if (post.status === 429) {
      await this.blockFor(post.headers.get('retry-after'));
      await this.db(() => this.deps.db.attemptSet(this.holder, attemptId, 'not_created'));
      await fail('rate_limited', '429');
      throw new TickStop('rate_limited');
    }
    if (post.status === 401 || post.status === 403) {
      await this.db(() => this.deps.db.attemptSet(this.holder, attemptId, 'not_created'));
      await fail('denied', String(post.status), { keyFp: keyFingerprint(key) });
      return;
    }
    if (post.status >= 400 && post.status < 500) {
      await this.db(() => this.deps.db.attemptSet(this.holder, attemptId, 'not_created'));
      await fail('error', `post_${post.status}`);
      return;
    }
    if (post.status < 200 || post.status >= 300) {
      await this.db(() => this.deps.db.attemptSet(this.holder, attemptId, 'ambiguous', { reason: 'unknown_outcome' }));
      await fail('error', `post_${post.status}`);
      return;
    }
    const raw = await this.text(post, HTTP_TIMEOUT_MS);
    const link = raw === null ? null : parseShareLink(raw);
    if (!link || !link.id || link.itemId !== row.providerRecordingId || link.callId !== row.providerCallId || !link.createdById || !link.accessLink) {
      // Created, but not provably ours: retained and owner-resolved, never deleted.
      await this.db(() => this.deps.db.attemptSet(this.holder, attemptId, 'ambiguous', {
        reason: 'post_mismatch', shareLinkId: link?.id ?? null, itemId: link?.itemId ?? null, createdById: link?.createdById ?? null, callId: link?.callId ?? null,
      }));
      await fail('error', 'post_mismatch');
      return;
    }
    const linkId = link.id;
    await this.db(() => this.deps.db.attemptSet(this.holder, attemptId, 'live', {
      shareLinkId: linkId, itemId: link.itemId, createdById: link.createdById, callId: link.callId,
    }));

    let stopReason: string | null = null;
    try {
      const got = await this.fetchAudio(link.accessLink, key);
      if (!got.ok) {
        if (got.kind === 'too_large') await fail('too_large', 'too_large');
        else if (got.kind === 'rate_limited') {
          await this.blockFor(got.retryAfter ?? null);
          await fail('rate_limited', '429');
          stopReason = 'rate_limited';
        } else {
          await fail('error', got.detail, got.warning ? { warning: got.warning } : {});
          if (got.kind === 'timeout') stopReason = 'timeout';
        }
      } else {
        await this.db(() => this.deps.db.attemptSet(this.holder, attemptId, 'downloaded'));
        this.summary.downloaded += 1;
        await this.processAudio(row, got.bytes, got.sha256, fail);
      }
    } catch (error) {
      if (error instanceof TickStop) stopReason = error.reason;
      else throw error;
    }
    if (stopReason) throw new TickStop(stopReason);

    // c'. delete our own link now only if there is time; otherwise the next tick's step a does it
    if (this.remaining() >= ADMISSION.deleteOwn) await this.deleteLink(key, attemptId, linkId);
  }

  private async safeDecode(bytes: Uint8Array): Promise<DecodeResult> {
    try {
      return await this.deps.decode(bytes, DECODE_BUDGET_MS);
    } catch {
      return { ok: false, reason: 'invalid' };
    }
  }

  private async processAudio(
    row: QueueDownload, bytes: Uint8Array, sha: string,
    fail: (kind: AudioFailKind, error: string, extra?: { keyFp?: string; warning?: string }) => Promise<void>,
  ): Promise<void> {
    const decoded = await this.safeDecode(bytes);
    if (!decoded.ok) {
      await fail(decoded.reason === 'timeout' ? 'decode_timeout' : 'invalid_media', decoded.reason === 'timeout' ? 'decode_timeout' : 'decode_invalid');
      return;
    }
    const tolerance = Math.max(2_000, Math.round(row.providerDurationMs * 0.05));
    if (decoded.durationMs < 1_000 || Math.abs(decoded.durationMs - row.providerDurationMs) > tolerance) {
      await fail('invalid_media', 'duration_mismatch');
      return;
    }
    await this.db(() => this.deps.db.markUploading(this.holder, row.id, sha, bytes.length, decoded.durationMs));
    const path = `${row.orgId}/${row.callActivityId}/${row.providerRecordingId}.mp3`;
    const uploaded = await this.storageCall(() => this.deps.storage.upload(path, bytes));
    // An object already at the path is never overwritten: step b verifies its sha and registers or removes it.
    if (uploaded === 'exists') return;
    await this.db(() => this.deps.db.registerStored(this.holder, row.id, path, bytes.length, sha, decoded.durationMs));
    this.summary.stored += 1;
  }

  /** The audio GET: manual redirects (every hop is a paced request), Authorization only to dialpad.com, 15 s in total. */
  private async fetchAudio(accessLink: string, key: string): Promise<DownloadResult> {
    const end = this.now() + AUDIO_GET_BUDGET_MS;
    let url = validAudioUrl(accessLink);
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      if (!url) return { ok: false, kind: 'error', detail: 'bad_url' };
      this.hosts.add(url.hostname);
      if (!AUDIO_HOST_ALLOWLIST.includes(url.hostname)) return { ok: false, kind: 'error', detail: 'bad_host', warning: url.hostname.slice(0, 200) };
      const sendKey = url.origin === DIALPAD_API_ORIGIN ? key : null;
      // The 1 s gap sits inside the 15 s budget; each hop's timeout is whatever is left of it.
      const earliest = this.lastRequestAt === null ? 0 : this.lastRequestAt + REQUEST_SPACING_MS;
      const wait = earliest - this.now();
      if (wait > 0) await this.deps.clock.sleep(wait);
      const left = end - this.now();
      if (left <= 0) return { ok: false, kind: 'timeout', detail: 'audio_timeout' };
      let response: Response;
      try {
        this.markStart('other');
        const headers: Record<string, string> = { Accept: 'audio/mpeg, */*' };
        if (sendKey) headers.Authorization = `Bearer ${sendKey}`;
        response = await this.deps.fetchImpl(url.toString(), { method: 'GET', headers, redirect: 'manual', cache: 'no-store', signal: this.signalFor(left) });
      } catch (error) {
        return { ok: false, kind: isTimeout(error) ? 'timeout' : 'error', detail: isTimeout(error) ? 'audio_timeout' : 'audio_network' };
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        void response.body?.cancel().catch(() => undefined);
        if (!location || hop === MAX_REDIRECT_HOPS) return { ok: false, kind: 'error', detail: 'bad_redirect' };
        url = validAudioUrl(location, url.toString());
        continue;
      }
      if (response.status === 429) return { ok: false, kind: 'rate_limited', detail: '429', retryAfter: response.headers.get('retry-after') };
      if (response.status !== 200 && response.status !== 206) {
        void response.body?.cancel().catch(() => undefined);
        return { ok: false, kind: 'error', detail: `audio_${response.status}` };
      }
      return this.readAudio(response);
    }
    return { ok: false, kind: 'error', detail: 'bad_redirect' };
  }

  private async readAudio(response: Response): Promise<DownloadResult> {
    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!(type.startsWith('audio/') || type.startsWith('application/octet-stream') || type.startsWith('binary/octet-stream'))) {
      void response.body?.cancel().catch(() => undefined);
      return { ok: false, kind: 'error', detail: 'audio_type' };
    }
    const declared = Number(response.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
      void response.body?.cancel().catch(() => undefined);
      return { ok: false, kind: 'too_large', detail: 'too_large' };
    }
    let expected: number | null = Number.isFinite(declared) && declared > 0 ? declared : null;
    if (response.status === 206) {
      // Accepted only when it covers the whole file.
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
      if (!range || Number(range[1]) !== 0 || Number(range[2]) + 1 !== Number(range[3])) {
        void response.body?.cancel().catch(() => undefined);
        return { ok: false, kind: 'error', detail: 'audio_partial' };
      }
      expected = Number(range[3]);
      if (expected > MAX_AUDIO_BYTES) {
        void response.body?.cancel().catch(() => undefined);
        return { ok: false, kind: 'too_large', detail: 'too_large' };
      }
    }
    if (!response.body) return { ok: false, kind: 'error', detail: 'audio_empty' };
    const hash = createHash('sha256');
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.length;
        if (total > MAX_AUDIO_BYTES) {
          void reader.cancel().catch(() => undefined);
          return { ok: false, kind: 'too_large', detail: 'too_large' };
        }
        chunks.push(value);
        hash.update(value);
      }
    } catch (error) {
      return { ok: false, kind: isTimeout(error) ? 'timeout' : 'error', detail: isTimeout(error) ? 'audio_timeout' : 'audio_network' };
    }
    if (total === 0 || (expected !== null && total !== expected)) return { ok: false, kind: 'error', detail: 'audio_incomplete' };
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return { ok: true, bytes, sha256: hash.digest('hex') };
  }

  // -- step d ---------------------------------------------------------------------------------------------

  private async discover(row: QueueDiscovery): Promise<void> {
    const key = this.keyFor(row.keyRef);
    if (!key || !DIGITS.test(row.providerCallId)) {
      await this.db(() => this.deps.db.discoveryResult(this.holder, row.id, 'error', { error: key ? 'bad_call_id' : 'no_key' }));
      return;
    }
    const record = (outcome: DiscoveryOutcome, extra?: { recordingId?: string; durationMs?: number; keyFp?: string; error?: string }) =>
      this.db(() => this.deps.db.discoveryResult(this.holder, row.id, outcome, extra));
    let res: Response | null;
    try {
      res = await this.send('call_get', 'GET', this.api(`/api/v2/call/${row.providerCallId}`), key, HTTP_TIMEOUT_MS);
    } catch (error) {
      await record('error', { error: isTimeout(error) ? 'timeout' : 'network' });
      if (isTimeout(error)) throw new TickStop('timeout');
      return;
    }
    if (!res) return;
    if (res.status === 429) {
      await this.blockFor(res.headers.get('retry-after'));
      await record('rate_limited');
      throw new TickStop('rate_limited');
    }
    if (res.status === 404) return void (await record('not_ready', { error: '404' }));
    if (res.status === 401 || res.status === 403) return void (await record('denied', { keyFp: keyFingerprint(key), error: String(res.status) }));
    if (res.status !== 200) return void (await record('error', { error: String(res.status) }));
    const raw = await this.text(res, HTTP_TIMEOUT_MS);
    const view = raw === null ? null : parseCallRecording(raw);
    if (!view) return void (await record('error', { error: 'bad_body' }));
    if (view.kind === 'none') return void (await record('not_ready'));
    if (view.kind === 'multi') return void (await record('multi'));
    await record('one', { recordingId: view.recordingId, durationMs: view.durationMs });
    this.summary.discovered += 1;
  }
}

/** One cron tick. `t0` is the handler's first statement (the deadline is anchored there and never reset). */
export async function runRecordingTick(deps: RecordingAudioDeps, t0: number): Promise<RecordingTickSummary> {
  return new RecordingTick(deps, t0).run();
}
