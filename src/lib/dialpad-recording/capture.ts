import { createHash, randomBytes } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { reportError } from '@/lib/errors/report';
import type { Database, Json } from '@/lib/supabase/types';

import {
  classifyDialpadRecordingRpcError,
  DIALPAD_RECORDING_CHUNK_MAX_BYTES,
  DIALPAD_RECORDING_GRANT_TTL_SECONDS,
  DIALPAD_RECORDING_MAX_EPOCH,
  DIALPAD_RECORDING_MAX_SEQ,
  DIALPAD_RECORDING_TRACK_MAX_BYTES,
  DIALPAD_RECORDING_TRACKS,
  DIALPAD_RECORDING_VAD_MAX_RANGES_PER_BATCH,
  DIALPAD_RECORDING_VAD_MAX_SAMPLE,
  DialpadRecordingDbError,
  parseDialpadRecordingChunkResult,
  parseDialpadRecordingClaimResult,
  parseDialpadRecordingCloseResult,
  parseDialpadRecordingConsumeResult,
  parseDialpadRecordingGrantResult,
  parseDialpadRecordingBrowserGrantResult,
  parseDialpadRecordingBrowserStatus,
  parseDialpadRecordingOpenResult,
  parseDialpadRecordingRegisterResult,
  parseDialpadRecordingEofResult,
  parseDialpadRecordingLifecycle,
  parseDialpadRecordingSealInputs,
  parseDialpadRecordingVadResult,
  parseDialpadRecordingPcmProgressResult,
  parseDialpadRecordingVadSnapshot,
  parseDialpadRecordingCapture,
  type DialpadRecordingCapture,
  type DialpadRecordingChunkResult,
  type DialpadRecordingClaimResult,
  type DialpadRecordingConsumeResult,
  type DialpadRecordingConsumeDenial,
  type DialpadRecordingMintDenial,
  type DialpadRecordingBrowserMintDenial,
  type DialpadRecordingOpenDenial,
  type DialpadRecordingRegisterResult,
  type DialpadRecordingEofResult,
  type DialpadRecordingLifecycle,
  type DialpadRecordingSealInputsResult,
  type DialpadRecordingVadRange,
  type DialpadRecordingVadResult,
  type DialpadRecordingPcmProgressResult,
  type DialpadRecordingVadSnapshot,
  type DialpadRecordingTrack,
  type DialpadRecordingTrackReport,
  type DialpadRecordingBrowserStatus,
} from './contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const INGEST_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CODEC = /^[a-z0-9_.-]{1,64}$/;
const FAILURE_CODE = /^[a-z0-9_]{1,64}$/;

/** The database surface for recording capture; production wraps the service-role client, tests inject a fake. */
export interface DialpadRecordingDb {
  open(orgId: string, repUserId: string, intentId: string): Promise<Json>;
  get(orgId: string, repUserId: string, captureId: string): Promise<Json>;
  close(orgId: string, captureId: string, repUserId: string | null, reason: 'call_ended' | 'service_closed' | null): Promise<Json>;
  mintGrant(args: { orgId: string; repUserId: string; captureId: string; epoch: number; tokenHash: string; ttlSeconds: number }): Promise<Json>;
  mintNextEpoch?(args: { orgId: string; repUserId: string; captureId: string; expectedConsumedEpoch: number; tokenHash: string; ttlSeconds: number }): Promise<Json>;
  consumeGrant(tokenHash: string, workerId: string): Promise<Json>;
  recordChunk(args: {
    orgId: string;
    captureId: string;
    track: DialpadRecordingTrack;
    epoch: number;
    seq: number;
    sizeBytes: number;
    sha256: string;
    isEof: boolean;
  }): Promise<Json>;
  markEof(args: { orgId: string; captureId: string; track: DialpadRecordingTrack; epoch: number; eofSeq: number; eofSha256: string }): Promise<Json>;
  getLifecycle(orgId: string, captureId: string): Promise<Json>;
  getSealInputs(captureId: string, claimToken: string): Promise<Json>;
  recordVadRanges(args: { orgId: string; captureId: string; track: 'tab'; epoch: number; batchId: string; ranges: Json }): Promise<Json>;
  recordPcmProgress(args: { orgId: string; captureId: string; track: DialpadRecordingTrack; epoch: number; batchId: string; processedThroughSample: number; pcmEofSample: number | null; sourceSampleRateHz: number | null; sourceChannels: number | null; sourceCodec: string | null; degradedReasons: Json }): Promise<Json>;
  getVadSnapshot(orgId: string, captureId: string): Promise<Json>;
  claimSealWork(workerId: string, leaseSeconds: number): Promise<Json>;
  registerResult(captureId: string, claimToken: string, tracks: Json, failureCode: string | null): Promise<Json>;
  getBrowserStatus?(orgId: string, repUserId: string, captureId: string): Promise<Json>;
}

type DbError = { code?: string | null; details?: string | null; message?: string } | null;

function unwrap<T>(result: { data: T; error: DbError }): T {
  if (result.error) throw new DialpadRecordingDbError(classifyDialpadRecordingRpcError(result.error), result.error.code ?? null);
  return result.data;
}

export function createSupabaseDialpadRecordingDb(client: SupabaseClient<Database>): DialpadRecordingDb {
  return {
    async open(orgId, repUserId, intentId) {
      return unwrap(await client.rpc('fn_open_dialpad_recording_capture', { p_org_id: orgId, p_rep_user_id: repUserId, p_intent_id: intentId }));
    },
    async get(orgId, repUserId, captureId) {
      return unwrap(await client.rpc('fn_get_dialpad_recording_capture', { p_org_id: orgId, p_rep_user_id: repUserId, p_capture_id: captureId }));
    },
    async close(orgId, captureId, repUserId, reason) {
      return unwrap(await client.rpc('fn_close_dialpad_recording_capture', { p_org_id: orgId, p_capture_id: captureId, p_rep_user_id: repUserId, p_reason: reason }));
    },
    async mintGrant(args) {
      return unwrap(await client.rpc('fn_mint_dialpad_recording_ingest_grant', {
        p_org_id: args.orgId,
        p_rep_user_id: args.repUserId,
        p_capture_id: args.captureId,
        p_epoch: args.epoch,
        p_token_hash: args.tokenHash,
        p_ttl_seconds: args.ttlSeconds,
      }));
    },
    async mintNextEpoch(args) {
      return unwrap(await client.rpc('fn_mint_dialpad_recording_next_epoch', {
        p_org_id: args.orgId,
        p_rep_user_id: args.repUserId,
        p_capture_id: args.captureId,
        p_expected_consumed_epoch: args.expectedConsumedEpoch,
        p_token_hash: args.tokenHash,
        p_ttl_seconds: args.ttlSeconds,
      }));
    },
    async consumeGrant(tokenHash, workerId) {
      return unwrap(await client.rpc('fn_consume_dialpad_recording_ingest_grant', { p_token_hash: tokenHash, p_worker_id: workerId }));
    },
    async recordChunk(args) {
      return unwrap(await client.rpc('fn_record_dialpad_recording_chunk', {
        p_org_id: args.orgId,
        p_capture_id: args.captureId,
        p_track: args.track,
        p_epoch: args.epoch,
        p_seq: args.seq,
        p_size_bytes: args.sizeBytes,
        p_sha256: args.sha256,
        p_is_eof: args.isEof,
      }));
    },
    async markEof(args) {
      return unwrap(await client.rpc('fn_mark_dialpad_recording_eof', {
        p_org_id: args.orgId,
        p_capture_id: args.captureId,
        p_track: args.track,
        p_epoch: args.epoch,
        p_eof_seq: args.eofSeq,
        p_eof_sha256: args.eofSha256,
      }));
    },
    async getLifecycle(orgId, captureId) {
      return unwrap(await client.rpc('fn_get_dialpad_recording_lifecycle', { p_org_id: orgId, p_capture_id: captureId }));
    },
    async getSealInputs(captureId, claimToken) {
      return unwrap(await client.rpc('fn_get_dialpad_recording_seal_inputs', { p_capture_id: captureId, p_claim_token: claimToken }));
    },
    async recordVadRanges(args) {
      return unwrap(await client.rpc('fn_record_dialpad_recording_vad_ranges', {
        p_org_id: args.orgId,
        p_capture_id: args.captureId,
        p_track: args.track,
        p_epoch: args.epoch,
        p_batch_id: args.batchId,
        p_ranges: args.ranges,
      }));
    },
    async recordPcmProgress(args) {
      return unwrap(await client.rpc('fn_record_dialpad_recording_pcm_progress', {
        p_org_id: args.orgId,
        p_capture_id: args.captureId,
        p_track: args.track,
        p_epoch: args.epoch,
        p_batch_id: args.batchId,
        p_processed_through_sample: args.processedThroughSample,
        p_pcm_eof_sample: args.pcmEofSample,
        p_source_sample_rate_hz: args.sourceSampleRateHz,
        p_source_channels: args.sourceChannels,
        p_source_codec: args.sourceCodec,
        p_degraded_reasons: args.degradedReasons,
      }));
    },
    async getVadSnapshot(orgId, captureId) {
      return unwrap(await client.rpc('fn_get_dialpad_recording_vad_snapshot', { p_org_id: orgId, p_capture_id: captureId }));
    },
    async claimSealWork(workerId, leaseSeconds) {
      return unwrap(await client.rpc('fn_claim_dialpad_recording_seal_work', { p_worker_id: workerId, p_lease_seconds: leaseSeconds }));
    },
    async registerResult(captureId, claimToken, tracks, failureCode) {
      return unwrap(await client.rpc('fn_register_dialpad_recording_result', {
        p_capture_id: captureId,
        p_claim_token: claimToken,
        p_tracks: tracks,
        p_failure_code: failureCode,
      }));
    },
    async getBrowserStatus(orgId, repUserId, captureId) {
      return unwrap(await client.rpc('fn_get_dialpad_recording_browser_status', {
        p_org_id: orgId,
        p_rep_user_id: repUserId,
        p_capture_id: captureId,
      }));
    },
  };
}

/** Org and rep always come from the authenticated session, never from client input. */
export interface DialpadRecordingActor {
  orgId: string;
  userId: string;
}

export type DialpadRecordingFailureCode = 'invalid_input' | 'denied' | 'not_found' | 'conflict' | 'state' | 'unavailable';

export interface DialpadRecordingFailure {
  ok: false;
  code: DialpadRecordingFailureCode;
  message: string;
  reason?: DialpadRecordingOpenDenial | DialpadRecordingMintDenial | DialpadRecordingBrowserMintDenial | DialpadRecordingConsumeDenial;
}

function fail(code: DialpadRecordingFailureCode, message: string, reason?: DialpadRecordingFailure['reason']): DialpadRecordingFailure {
  return reason ? { ok: false, code, message, reason } : { ok: false, code, message };
}

const REASON_MESSAGES: Record<string, string> = {
  rep_not_active: 'Your Acquisitions access is not active.',
  call_ended: 'This call has already ended.',
  call_not_connected: 'Recording starts once the call is connected.',
  call_not_projected: 'Sandra has not linked this call yet. Try again in a moment.',
  capture_not_open: 'This recording is no longer accepting audio.',
  epoch_already_authorized: 'Recording was already started for this call segment.',
  epoch_out_of_order: 'Recording segments must be started in order.',
  grant_limit: 'Too many recording connections were requested for this call.',
  epoch_stale: 'This recording session is out of date. Refresh and try again.',
  grant_pending: 'A recording session is already active for this call.',
  ingest_not_configured: 'Recording transport is not configured for this call.',
};

function failureFromDbError(error: unknown): DialpadRecordingFailure {
  if (error instanceof DialpadRecordingDbError) {
    switch (error.failure.kind) {
      case 'forbidden':
        return fail('denied', 'You cannot record this call.');
      case 'not_found':
        return fail('not_found', 'That call or recording is no longer available.');
      case 'invalid_input':
        return fail('invalid_input', 'Sandra could not accept that recording request.');
      case 'conflict':
        return fail('conflict', 'That recording request conflicts with one already recorded.');
      case 'state':
        return fail('state', 'This recording is no longer accepting changes.');
      default:
        break;
    }
  }
  reportError(error instanceof Error ? error : new Error('dialpad recording operation failed'), {
    errorClass: 'database',
    tags: { surface: 'server', operation: 'dialpad_recording', kind: error instanceof DialpadRecordingDbError ? 'db_error' : 'unexpected' },
  });
  return fail('unavailable', 'Sandra could not reach recording storage. Try again.');
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isIntIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** A fresh 256-bit token. Only its SHA-256 ever reaches the database; the raw value is returned once to the caller. */
export function generateDialpadIngestToken(random: (size: number) => Buffer = randomBytes): { token: string; tokenHash: string } {
  const token = random(32).toString('base64url');
  return { token, tokenHash: hashDialpadIngestToken(token) };
}

export function hashDialpadIngestToken(token: string): string {
  if (!INGEST_TOKEN.test(token)) throw new Error('Invalid ingest token.');
  return createHash('sha256').update(token).digest('hex');
}

// ---- session-owned actions (org and rep from the session only) ----

export type OpenRecordingResult =
  | { ok: true; replayed: boolean; capture: DialpadRecordingCapture }
  | DialpadRecordingFailure;

export async function openDialpadRecordingCapture(db: DialpadRecordingDb, actor: DialpadRecordingActor, intentId: unknown): Promise<OpenRecordingResult> {
  if (!isUuid(intentId)) return fail('invalid_input', 'Choose a call first.');
  try {
    const result = parseDialpadRecordingOpenResult(await db.open(actor.orgId, actor.userId, intentId));
    if (result.status === 'denied') return fail('denied', REASON_MESSAGES[result.reason] ?? 'Recording is not available for this call.', result.reason);
    return { ok: true, replayed: result.status === 'replayed', capture: result.capture };
  } catch (error) {
    return failureFromDbError(error);
  }
}

export type CloseRecordingResult = { ok: true; replayed: boolean; capture: DialpadRecordingCapture } | DialpadRecordingFailure;

export async function closeDialpadRecordingCapture(db: DialpadRecordingDb, actor: DialpadRecordingActor, captureId: unknown): Promise<CloseRecordingResult> {
  if (!isUuid(captureId)) return fail('invalid_input', 'Choose a recording first.');
  try {
    const result = parseDialpadRecordingCloseResult(await db.close(actor.orgId, captureId, actor.userId, null));
    return { ok: true, replayed: result.status === 'replayed', capture: result.capture };
  } catch (error) {
    return failureFromDbError(error);
  }
}

export type MintGrantResult =
  | { ok: true; replayed: boolean; grantId: string; captureId: string; epoch: number; expiresAt: string; token: string }
  | DialpadRecordingFailure;

export interface MintGrantDeps {
  generateToken?: () => { token: string; tokenHash: string };
  ttlSeconds?: number;
}

/**
 * Mints a short-lived, single-use ingest grant for the session's own open
 * capture. The raw token exists only in this return value, for the caller to
 * hand to the worker transport; it is never logged or stored.
 */
export async function mintDialpadRecordingGrant(
  db: DialpadRecordingDb,
  actor: DialpadRecordingActor,
  input: { captureId: unknown; epoch: unknown },
  deps: MintGrantDeps = {},
): Promise<MintGrantResult> {
  if (!isUuid(input.captureId) || !isIntIn(input.epoch, 1, DIALPAD_RECORDING_MAX_EPOCH)) return fail('invalid_input', 'Choose a recording and segment first.');
  const ttlSeconds = deps.ttlSeconds ?? DIALPAD_RECORDING_GRANT_TTL_SECONDS.default;
  if (!isIntIn(ttlSeconds, DIALPAD_RECORDING_GRANT_TTL_SECONDS.min, DIALPAD_RECORDING_GRANT_TTL_SECONDS.max)) return fail('invalid_input', 'Invalid grant lifetime.');
  const { token, tokenHash } = (deps.generateToken ?? generateDialpadIngestToken)();
  try {
    const result = parseDialpadRecordingGrantResult(
      await db.mintGrant({ orgId: actor.orgId, repUserId: actor.userId, captureId: input.captureId, epoch: input.epoch, tokenHash, ttlSeconds }),
    );
    if (result.status === 'denied') return fail('denied', REASON_MESSAGES[result.reason] ?? 'Recording is not available for this call.', result.reason);
    return { ok: true, replayed: result.status === 'replayed', grantId: result.grantId, captureId: result.captureId, epoch: result.epoch, expiresAt: result.expiresAt, token };
  } catch (error) {
    return failureFromDbError(error);
  }
}

export type MintNextEpochResult =
  | {
      ok: true;
      replayed: boolean;
      grantId: string;
      captureId: string;
      epoch: number;
      expiresAt: string;
      token: string;
      ingestEndpoint: string;
      controlVersion: 2;
    }
  | DialpadRecordingFailure;

export interface MintNextEpochDeps {
  generateToken?: () => { token: string; tokenHash: string };
  ttlSeconds?: number;
}

/** Allocates a recovery epoch from the authoritative consumed-grant watermark. */
export async function mintDialpadRecordingNextEpoch(
  db: DialpadRecordingDb,
  actor: DialpadRecordingActor,
  input: { captureId: unknown; expectedConsumedEpoch: unknown },
  deps: MintNextEpochDeps = {},
): Promise<MintNextEpochResult> {
  if (!db.mintNextEpoch) return fail('unavailable', 'Browser recording transport is unavailable.');
  if (!isUuid(input.captureId) || !isIntIn(input.expectedConsumedEpoch, 0, DIALPAD_RECORDING_MAX_EPOCH)) return fail('invalid_input', 'Choose a recording and current session first.');
  const ttlSeconds = deps.ttlSeconds ?? DIALPAD_RECORDING_GRANT_TTL_SECONDS.default;
  if (!isIntIn(ttlSeconds, DIALPAD_RECORDING_GRANT_TTL_SECONDS.min, DIALPAD_RECORDING_GRANT_TTL_SECONDS.max)) return fail('invalid_input', 'Invalid grant lifetime.');
  const { token, tokenHash } = (deps.generateToken ?? generateDialpadIngestToken)();
  try {
    const result = parseDialpadRecordingBrowserGrantResult(await db.mintNextEpoch({
      orgId: actor.orgId,
      repUserId: actor.userId,
      captureId: input.captureId,
      expectedConsumedEpoch: input.expectedConsumedEpoch,
      tokenHash,
      ttlSeconds,
    }));
    if (result.status === 'denied') return fail('denied', REASON_MESSAGES[result.reason] ?? 'Recording is not available for this call.', result.reason);
    return {
      ok: true,
      replayed: result.status === 'replayed',
      grantId: result.grantId,
      captureId: result.captureId,
      epoch: result.epoch,
      expiresAt: result.expiresAt,
      token,
      ingestEndpoint: result.ingestEndpoint,
      controlVersion: result.controlVersion,
    };
  } catch (error) {
    return failureFromDbError(error);
  }
}

export type BrowserStatusResult = { ok: true; status: DialpadRecordingBrowserStatus } | DialpadRecordingFailure;

/** Returns lifecycle/bootstrap facts safe for the browser; storage locators are excluded by the parser. */
export async function getDialpadRecordingBrowserStatus(
  db: DialpadRecordingDb,
  actor: DialpadRecordingActor,
  captureId: unknown,
): Promise<BrowserStatusResult> {
  if (!db.getBrowserStatus) return fail('unavailable', 'Browser recording transport is unavailable.');
  if (!isUuid(captureId)) return fail('invalid_input', 'Choose a recording first.');
  try {
    return { ok: true, status: parseDialpadRecordingBrowserStatus(await db.getBrowserStatus(actor.orgId, actor.userId, captureId)) };
  } catch (error) {
    return failureFromDbError(error);
  }
}

// ---- trusted worker-side adapters (service role only; never reachable from a browser action) ----

export type ConsumeGrantResult = { ok: true; grant: Extract<DialpadRecordingConsumeResult, { status: 'consumed' }> } | DialpadRecordingFailure;

export async function consumeDialpadIngestGrant(db: DialpadRecordingDb, rawToken: unknown, workerId: unknown): Promise<ConsumeGrantResult> {
  if (typeof rawToken !== 'string' || !INGEST_TOKEN.test(rawToken) || typeof workerId !== 'string' || workerId.length < 1 || workerId.length > 200) {
    return fail('invalid_input', 'Invalid ingest authorization.');
  }
  try {
    const result = parseDialpadRecordingConsumeResult(await db.consumeGrant(hashDialpadIngestToken(rawToken), workerId));
    if (result.status === 'denied') return fail('denied', 'This ingest authorization cannot be used.', result.reason);
    return { ok: true, grant: result };
  } catch (error) {
    return failureFromDbError(error);
  }
}

export interface RecordChunkInput {
  orgId: unknown;
  captureId: unknown;
  track: unknown;
  epoch: unknown;
  seq: unknown;
  sizeBytes: unknown;
  sha256: unknown;
  isEof: unknown;
}

export type RecordChunkResult = ({ ok: true } & DialpadRecordingChunkResult) | DialpadRecordingFailure;

export async function recordDialpadRecordingChunk(db: DialpadRecordingDb, input: RecordChunkInput): Promise<RecordChunkResult> {
  if (
    !isUuid(input.orgId) || !isUuid(input.captureId)
    || !(DIALPAD_RECORDING_TRACKS as readonly unknown[]).includes(input.track)
    || !isIntIn(input.epoch, 1, DIALPAD_RECORDING_MAX_EPOCH)
    || !isIntIn(input.seq, 0, DIALPAD_RECORDING_MAX_SEQ)
    || !isIntIn(input.sizeBytes, 1, DIALPAD_RECORDING_CHUNK_MAX_BYTES)
    || typeof input.sha256 !== 'string' || !SHA256_HEX.test(input.sha256)
    || typeof input.isEof !== 'boolean'
  ) {
    return fail('invalid_input', 'Invalid recording chunk.');
  }
  try {
    const result = parseDialpadRecordingChunkResult(await db.recordChunk({
      orgId: input.orgId,
      captureId: input.captureId,
      track: input.track as DialpadRecordingTrack,
      epoch: input.epoch,
      seq: input.seq,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      isEof: input.isEof,
    }));
    return { ok: true, ...result };
  } catch (error) {
    return failureFromDbError(error);
  }
}

export type MarkEofResult = ({ ok: true } & DialpadRecordingEofResult) | DialpadRecordingFailure;

export async function markDialpadRecordingEof(
  db: DialpadRecordingDb,
  input: { orgId: unknown; captureId: unknown; track: unknown; epoch: unknown; eofSeq: unknown; eofSha256: unknown },
): Promise<MarkEofResult> {
  if (
    !isUuid(input.orgId) || !isUuid(input.captureId)
    || !(DIALPAD_RECORDING_TRACKS as readonly unknown[]).includes(input.track)
    || !isIntIn(input.epoch, 1, DIALPAD_RECORDING_MAX_EPOCH)
    || !isIntIn(input.eofSeq, 0, DIALPAD_RECORDING_MAX_SEQ)
    || typeof input.eofSha256 !== 'string' || !SHA256_HEX.test(input.eofSha256)
  ) return fail('invalid_input', 'Invalid recording EOF.');
  try {
    const result = parseDialpadRecordingEofResult(await db.markEof({
      orgId: input.orgId,
      captureId: input.captureId,
      track: input.track as DialpadRecordingTrack,
      epoch: input.epoch,
      eofSeq: input.eofSeq,
      eofSha256: input.eofSha256,
    }));
    return { ok: true, ...result };
  } catch (error) {
    return failureFromDbError(error);
  }
}

export type RecordingLifecycleResult = ({ ok: true; lifecycle: DialpadRecordingLifecycle }) | DialpadRecordingFailure;

export async function getDialpadRecordingLifecycle(
  db: DialpadRecordingDb,
  orgId: unknown,
  captureId: unknown,
): Promise<RecordingLifecycleResult> {
  if (!isUuid(orgId) || !isUuid(captureId)) return fail('invalid_input', 'Choose a recording first.');
  try {
    return { ok: true, lifecycle: parseDialpadRecordingLifecycle(await db.getLifecycle(orgId, captureId)) };
  } catch (error) {
    return failureFromDbError(error);
  }
}

export type SealInputsResult = ({ ok: true; inputs: DialpadRecordingSealInputsResult }) | DialpadRecordingFailure;

export async function getDialpadRecordingSealInputs(
  db: DialpadRecordingDb,
  captureId: unknown,
  claimToken: unknown,
): Promise<SealInputsResult> {
  if (!isUuid(captureId) || !isUuid(claimToken)) return fail('invalid_input', 'Invalid seal claim.');
  try {
    return { ok: true, inputs: parseDialpadRecordingSealInputs(await db.getSealInputs(captureId, claimToken)) };
  } catch (error) {
    return failureFromDbError(error);
  }
}

export interface RecordVadRangesInput {
  orgId: unknown;
  captureId: unknown;
  track: unknown;
  epoch: unknown;
  batchId: unknown;
  ranges: unknown;
}

export type RecordVadRangesResult = ({ ok: true } & DialpadRecordingVadResult) | DialpadRecordingFailure;

function validVadRange(value: unknown): value is DialpadRecordingVadRange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const range = value as Partial<DialpadRecordingVadRange>;
  return (
    isIntIn(range.startSample, 0, DIALPAD_RECORDING_VAD_MAX_SAMPLE)
    && isIntIn(range.endSample, 1, DIALPAD_RECORDING_VAD_MAX_SAMPLE)
    && range.endSample > range.startSample
    && typeof range.evidenceRef === 'string'
    && range.evidenceRef.length >= 1 && range.evidenceRef.length <= 256
  );
}

export async function recordDialpadRecordingVadRanges(
  db: DialpadRecordingDb,
  input: RecordVadRangesInput,
): Promise<RecordVadRangesResult> {
  if (
    !isUuid(input.orgId) || !isUuid(input.captureId) || input.track !== 'tab'
    || !isIntIn(input.epoch, 1, DIALPAD_RECORDING_MAX_EPOCH) || !isUuid(input.batchId)
    || !Array.isArray(input.ranges) || input.ranges.length > DIALPAD_RECORDING_VAD_MAX_RANGES_PER_BATCH
    || !input.ranges.every(validVadRange)
  ) return fail('invalid_input', 'Invalid VAD sample ranges.');
  try {
    const result = parseDialpadRecordingVadResult(await db.recordVadRanges({
      orgId: input.orgId,
      captureId: input.captureId,
      track: 'tab',
      epoch: input.epoch,
      batchId: input.batchId,
      ranges: input.ranges as unknown as Json,
    }));
    return { ok: true, ...result };
  } catch (error) {
    return failureFromDbError(error);
  }
}

export interface RecordPcmProgressInput {
  orgId: unknown;
  captureId: unknown;
  track: unknown;
  epoch: unknown;
  batchId: unknown;
  processedThroughSample: unknown;
  pcmEofSample: unknown;
  sourceSampleRateHz: unknown;
  sourceChannels: unknown;
  sourceCodec: unknown;
  degradedReasons: unknown;
}

export type RecordPcmProgressResult = ({ ok: true } & DialpadRecordingPcmProgressResult) | DialpadRecordingFailure;

export async function recordDialpadRecordingPcmProgress(
  db: DialpadRecordingDb,
  input: RecordPcmProgressInput,
): Promise<RecordPcmProgressResult> {
  const reasons = input.degradedReasons;
  if (
    !isUuid(input.orgId) || !isUuid(input.captureId) || !(DIALPAD_RECORDING_TRACKS as readonly unknown[]).includes(input.track)
    || !isIntIn(input.epoch, 1, DIALPAD_RECORDING_MAX_EPOCH) || !isUuid(input.batchId)
    || !isIntIn(input.processedThroughSample, 0, DIALPAD_RECORDING_VAD_MAX_SAMPLE)
    || (input.pcmEofSample !== null && !isIntIn(input.pcmEofSample, 0, DIALPAD_RECORDING_VAD_MAX_SAMPLE))
    || (input.pcmEofSample !== null && input.pcmEofSample !== input.processedThroughSample)
    || !(
      (input.sourceSampleRateHz === null && input.sourceChannels === null && input.sourceCodec === null)
      || (isIntIn(input.sourceSampleRateHz, 8000, 192000)
        && isIntIn(input.sourceChannels, 1, 2)
        && typeof input.sourceCodec === 'string'
        && CODEC.test(input.sourceCodec))
    )
    || !Array.isArray(reasons) || reasons.length > 64
    || !reasons.every((reason) => typeof reason === 'string' && /^[a-z0-9_]{1,64}$/.test(reason))
  ) return fail('invalid_input', 'Invalid PCM continuity progress.');
  try {
    const result = parseDialpadRecordingPcmProgressResult(await db.recordPcmProgress({
      orgId: input.orgId,
      captureId: input.captureId,
      track: input.track as DialpadRecordingTrack,
      epoch: input.epoch,
      batchId: input.batchId,
      processedThroughSample: input.processedThroughSample,
      pcmEofSample: input.pcmEofSample as number | null,
      sourceSampleRateHz: input.sourceSampleRateHz as number | null,
      sourceChannels: input.sourceChannels as number | null,
      sourceCodec: input.sourceCodec as string | null,
      degradedReasons: reasons as unknown as Json,
    }));
    return { ok: true, ...result };
  } catch (error) {
    return failureFromDbError(error);
  }
}

export type VadSnapshotResult = ({ ok: true; snapshot: DialpadRecordingVadSnapshot } | DialpadRecordingFailure);

export async function getDialpadRecordingVadSnapshot(
  db: DialpadRecordingDb,
  orgId: unknown,
  captureId: unknown,
): Promise<VadSnapshotResult> {
  if (!isUuid(orgId) || !isUuid(captureId)) return fail('invalid_input', 'Choose a recording first.');
  try {
    return { ok: true, snapshot: parseDialpadRecordingVadSnapshot(await db.getVadSnapshot(orgId, captureId)) };
  } catch (error) {
    return failureFromDbError(error);
  }
}

export type ClaimSealWorkResult = { ok: true; claim: DialpadRecordingClaimResult } | DialpadRecordingFailure;

export async function claimDialpadSealWork(db: DialpadRecordingDb, workerId: unknown, leaseSeconds: unknown = 300): Promise<ClaimSealWorkResult> {
  if (typeof workerId !== 'string' || workerId.length < 1 || workerId.length > 200 || !isIntIn(leaseSeconds, 30, 1800)) {
    return fail('invalid_input', 'Invalid seal claim.');
  }
  try {
    return { ok: true, claim: parseDialpadRecordingClaimResult(await db.claimSealWork(workerId, leaseSeconds)) };
  } catch (error) {
    return failureFromDbError(error);
  }
}

function validTrackReport(report: DialpadRecordingTrackReport): boolean {
  if (!(DIALPAD_RECORDING_TRACKS as readonly unknown[]).includes(report.track) || !isIntIn(report.epoch, 1, DIALPAD_RECORDING_MAX_EPOCH)) return false;
  if (!report.decodeOk) return true;
  return (
    isIntIn(report.sizeBytes, 1, DIALPAD_RECORDING_TRACK_MAX_BYTES)
    && SHA256_HEX.test(report.sha256)
    && CODEC.test(report.codec)
    && isIntIn(report.sampleRateHz, 8000, 192_000)
    && (report.channels === 1 || report.channels === 2)
    && isIntIn(report.decodedDurationMs, 1, 14_400_000)
  );
}

export type RegisterResult = ({ ok: true } & DialpadRecordingRegisterResult) | DialpadRecordingFailure;

/**
 * Registers a worker's per-track decode evidence under its fencing token. The
 * database recomputes EOF, contiguity and byte counts from the chunk ledger and
 * derives completeness; nothing here can mark a capture complete.
 */
export async function registerDialpadSealResult(
  db: DialpadRecordingDb,
  input: { captureId: unknown; claimToken: unknown; tracks: DialpadRecordingTrackReport[]; failureCode?: string | null },
): Promise<RegisterResult> {
  const failureCode = input.failureCode ?? null;
  if (
    !isUuid(input.captureId) || !isUuid(input.claimToken)
    || !Array.isArray(input.tracks) || input.tracks.length > 32 || !input.tracks.every(validTrackReport)
    || (failureCode !== null && !FAILURE_CODE.test(failureCode))
  ) {
    return fail('invalid_input', 'Invalid seal result.');
  }
  try {
    const result = parseDialpadRecordingRegisterResult(await db.registerResult(input.captureId, input.claimToken, input.tracks as unknown as Json, failureCode));
    return { ok: true, ...result };
  } catch (error) {
    return failureFromDbError(error);
  }
}

export async function getDialpadRecordingCapture(
  db: DialpadRecordingDb,
  actor: DialpadRecordingActor,
  captureId: unknown,
): Promise<{ ok: true; capture: DialpadRecordingCapture } | DialpadRecordingFailure> {
  if (!isUuid(captureId)) return fail('invalid_input', 'Choose a recording first.');
  try {
    return { ok: true, capture: parseDialpadRecordingCapture(await db.get(actor.orgId, actor.userId, captureId)) };
  } catch (error) {
    return failureFromDbError(error);
  }
}
