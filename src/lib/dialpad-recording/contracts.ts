import type { Json } from '@/lib/supabase/types';

/**
 * Typed contracts for the Dialpad recording foundation (migration
 * 20260929210000). A capture is bound to one matched Dialpad call; audio is
 * ingested by a worker in per-(track, epoch) chunks of at most 1 MiB and is
 * "sealed" only when both tracks of epoch 1 carry complete EOF, contiguity and
 * decode evidence. Later epochs are separate partial segments, never stitched.
 */

export const DIALPAD_RECORDING_TRACKS = ['tab', 'mic'] as const;
export type DialpadRecordingTrack = (typeof DIALPAD_RECORDING_TRACKS)[number];

export const DIALPAD_RECORDING_MAX_EPOCH = 16;
export const DIALPAD_RECORDING_MAX_SEQ = 99_999;
export const DIALPAD_RECORDING_CHUNK_MAX_BYTES = 1_048_576;
/** Bounds one final track object (the bucket limit). Capacity for a three-hour call is extrapolated, not proven. */
export const DIALPAD_RECORDING_TRACK_MAX_BYTES = 536_870_912;
export const DIALPAD_RECORDING_BUCKET = 'dialpad-recordings';
export const DIALPAD_RECORDING_GRANT_TTL_SECONDS = { min: 10, max: 300, default: 60 } as const;

export const DIALPAD_CAPTURE_STATES = ['open', 'closing', 'sealing', 'sealed', 'partial', 'failed'] as const;
export type DialpadCaptureState = (typeof DIALPAD_CAPTURE_STATES)[number];

export const DIALPAD_CAPTURE_CLOSE_REASONS = ['rep_closed', 'call_ended', 'service_closed'] as const;
export type DialpadCaptureCloseReason = (typeof DIALPAD_CAPTURE_CLOSE_REASONS)[number];

export const DIALPAD_RECORDING_OPEN_DENIALS = ['rep_not_active', 'call_ended', 'call_not_connected', 'call_not_projected'] as const;
export type DialpadRecordingOpenDenial = (typeof DIALPAD_RECORDING_OPEN_DENIALS)[number];

export const DIALPAD_RECORDING_MINT_DENIALS = [
  'capture_not_open',
  'rep_not_active',
  'call_ended',
  'epoch_already_authorized',
  'epoch_out_of_order',
  'grant_limit',
] as const;
export type DialpadRecordingMintDenial = (typeof DIALPAD_RECORDING_MINT_DENIALS)[number];

export const DIALPAD_RECORDING_CONSUME_DENIALS = [
  'unknown',
  'consumed',
  'expired',
  'revoked',
  'capture_not_open',
  'rep_not_active',
  'call_ended',
  'epoch_already_authorized',
] as const;
export type DialpadRecordingConsumeDenial = (typeof DIALPAD_RECORDING_CONSUME_DENIALS)[number];

export type DialpadRecordingRpcFailure =
  | { kind: 'forbidden'; detail: string | null }
  | { kind: 'not_found' }
  | { kind: 'invalid_input'; detail: string | null }
  | { kind: 'conflict'; detail: string | null }
  | { kind: 'state'; detail: string | null }
  | { kind: 'unknown' };

/** Maps a Postgres error raised by the recording functions (SQLSTATE and detail) to a typed failure. */
export function classifyDialpadRecordingRpcError(
  error: { code?: string | null; details?: string | null; detail?: string | null } | null | undefined,
): DialpadRecordingRpcFailure {
  const detail = error?.details ?? error?.detail ?? null;
  switch (error?.code) {
    case '42501':
      return { kind: 'forbidden', detail };
    case 'P0002':
      return { kind: 'not_found' };
    case '22023':
      return { kind: 'invalid_input', detail };
    case '40001':
      return { kind: 'conflict', detail };
    case '55000':
      return { kind: 'state', detail };
    default:
      return { kind: 'unknown' };
  }
}

export class DialpadRecordingDbError extends Error {
  constructor(readonly failure: DialpadRecordingRpcFailure, readonly sqlstate: string | null) {
    super(`dialpad recording database call failed (${sqlstate ?? 'no sqlstate'})`);
    this.name = 'DialpadRecordingDbError';
  }
}

export interface DialpadRecordingSegmentSummary {
  track: DialpadRecordingTrack;
  epoch: number;
  chunkCount: number;
  totalBytes: number;
  maxSeq: number | null;
  eofSeq: number | null;
  final: {
    completeness: 'complete' | 'partial' | 'unusable';
    storagePath: string | null;
    sizeBytes: number | null;
    decodedDurationMs: number | null;
  } | null;
}

export interface DialpadRecordingCapture {
  captureId: string;
  orgId: string;
  repUserId: string;
  intentId: string;
  callActivityId: string;
  providerCallId: string;
  status: DialpadCaptureState;
  openedAt: string;
  closedAt: string | null;
  closeReason: DialpadCaptureCloseReason | null;
  drainDeadlineAt: string | null;
  resultAt: string | null;
  failureCode: string | null;
  sealAttempts: number;
  segments: DialpadRecordingSegmentSummary[];
}

type Obj = { [key: string]: Json | undefined };

function record(value: Json | null | undefined, label: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label} response.`);
  return value;
}

function str(value: Json | undefined, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${label}.`);
  return value;
}

function nullableStr(value: Json | undefined, label: string): string | null {
  if (value === null || value === undefined) return null;
  return str(value, label);
}

function int(value: Json | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function nullableInt(value: Json | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  return int(value, label);
}

// Postgres returns bigint sums inside jsonb as numbers; accept a numeric string too.
function bigish(value: Json | undefined, label: string): number {
  if (typeof value === 'string' && /^[0-9]{1,15}$/.test(value)) return Number(value);
  return int(value, label);
}

function oneOf<T extends string>(value: Json | undefined, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new Error(`Invalid ${label}.`);
  return value as T;
}

function nullableOneOf<T extends string>(value: Json | undefined, allowed: readonly T[], label: string): T | null {
  if (value === null || value === undefined) return null;
  return oneOf(value, allowed, label);
}

const COMPLETENESS = ['complete', 'partial', 'unusable'] as const;

function parseSegment(value: Json | undefined): DialpadRecordingSegmentSummary {
  const data = record(value, 'segment');
  const finalValue = data.final;
  let final: DialpadRecordingSegmentSummary['final'] = null;
  if (finalValue !== null && finalValue !== undefined) {
    const f = record(finalValue, 'segment final');
    final = {
      completeness: oneOf(f.completeness, COMPLETENESS, 'completeness'),
      storagePath: nullableStr(f.storagePath, 'storagePath'),
      sizeBytes: f.sizeBytes === null || f.sizeBytes === undefined ? null : bigish(f.sizeBytes, 'sizeBytes'),
      decodedDurationMs: nullableInt(f.decodedDurationMs, 'decodedDurationMs'),
    };
  }
  return {
    track: oneOf(data.track, DIALPAD_RECORDING_TRACKS, 'track'),
    epoch: int(data.epoch, 'epoch'),
    chunkCount: int(data.chunkCount, 'chunkCount'),
    totalBytes: bigish(data.totalBytes, 'totalBytes'),
    maxSeq: nullableInt(data.maxSeq, 'maxSeq'),
    eofSeq: nullableInt(data.eofSeq, 'eofSeq'),
    final,
  };
}

export function parseDialpadRecordingCapture(value: Json | null | undefined): DialpadRecordingCapture {
  const data = record(value, 'recording capture');
  const segments = data.segments;
  if (!Array.isArray(segments)) throw new Error('Invalid segments.');
  return {
    captureId: str(data.captureId, 'captureId'),
    orgId: str(data.orgId, 'orgId'),
    repUserId: str(data.repUserId, 'repUserId'),
    intentId: str(data.intentId, 'intentId'),
    callActivityId: str(data.callActivityId, 'callActivityId'),
    providerCallId: str(data.providerCallId, 'providerCallId'),
    status: oneOf(data.status, DIALPAD_CAPTURE_STATES, 'status'),
    openedAt: str(data.openedAt, 'openedAt'),
    closedAt: nullableStr(data.closedAt, 'closedAt'),
    closeReason: nullableOneOf(data.closeReason, DIALPAD_CAPTURE_CLOSE_REASONS, 'closeReason'),
    drainDeadlineAt: nullableStr(data.drainDeadlineAt, 'drainDeadlineAt'),
    resultAt: nullableStr(data.resultAt, 'resultAt'),
    failureCode: nullableStr(data.failureCode, 'failureCode'),
    sealAttempts: int(data.sealAttempts, 'sealAttempts'),
    segments: segments.map(parseSegment),
  };
}

export type DialpadRecordingOpenResult =
  | { status: 'opened' | 'replayed'; capture: DialpadRecordingCapture }
  | { status: 'denied'; reason: DialpadRecordingOpenDenial };

export function parseDialpadRecordingOpenResult(value: Json | null | undefined): DialpadRecordingOpenResult {
  const data = record(value, 'open capture');
  const status = oneOf(data.status, ['opened', 'replayed', 'denied'] as const, 'status');
  if (status === 'denied') return { status, reason: oneOf(data.reason, DIALPAD_RECORDING_OPEN_DENIALS, 'reason') };
  return { status, capture: parseDialpadRecordingCapture(data.capture) };
}

export type DialpadRecordingCloseResult = { status: 'closed' | 'replayed'; capture: DialpadRecordingCapture };

export function parseDialpadRecordingCloseResult(value: Json | null | undefined): DialpadRecordingCloseResult {
  const data = record(value, 'close capture');
  return { status: oneOf(data.status, ['closed', 'replayed'] as const, 'status'), capture: parseDialpadRecordingCapture(data.capture) };
}

export type DialpadRecordingGrantResult =
  | { status: 'minted' | 'replayed'; grantId: string; captureId: string; epoch: number; expiresAt: string }
  | { status: 'denied'; reason: DialpadRecordingMintDenial };

export function parseDialpadRecordingGrantResult(value: Json | null | undefined): DialpadRecordingGrantResult {
  const data = record(value, 'ingest grant');
  const status = oneOf(data.status, ['minted', 'replayed', 'denied'] as const, 'status');
  if (status === 'denied') return { status, reason: oneOf(data.reason, DIALPAD_RECORDING_MINT_DENIALS, 'reason') };
  return {
    status,
    grantId: str(data.grantId, 'grantId'),
    captureId: str(data.captureId, 'captureId'),
    epoch: int(data.epoch, 'epoch'),
    expiresAt: str(data.expiresAt, 'expiresAt'),
  };
}

export type DialpadRecordingConsumeResult =
  | {
      status: 'consumed';
      grantId: string;
      captureId: string;
      orgId: string;
      repUserId: string;
      epoch: number;
      intentId: string;
      callActivityId: string;
      providerCallId: string;
    }
  | { status: 'denied'; reason: DialpadRecordingConsumeDenial };

export function parseDialpadRecordingConsumeResult(value: Json | null | undefined): DialpadRecordingConsumeResult {
  const data = record(value, 'consume grant');
  const status = oneOf(data.status, ['consumed', 'denied'] as const, 'status');
  if (status === 'denied') return { status, reason: oneOf(data.reason, DIALPAD_RECORDING_CONSUME_DENIALS, 'reason') };
  return {
    status,
    grantId: str(data.grantId, 'grantId'),
    captureId: str(data.captureId, 'captureId'),
    orgId: str(data.orgId, 'orgId'),
    repUserId: str(data.repUserId, 'repUserId'),
    epoch: int(data.epoch, 'epoch'),
    intentId: str(data.intentId, 'intentId'),
    callActivityId: str(data.callActivityId, 'callActivityId'),
    providerCallId: str(data.providerCallId, 'providerCallId'),
  };
}

export interface DialpadRecordingChunkResult {
  status: 'recorded' | 'replayed';
  /** Server-derived object path inside the private bucket. */
  storagePath: string;
}

export function parseDialpadRecordingChunkResult(value: Json | null | undefined): DialpadRecordingChunkResult {
  const data = record(value, 'chunk');
  return { status: oneOf(data.status, ['recorded', 'replayed'] as const, 'status'), storagePath: str(data.storagePath, 'storagePath') };
}

export type DialpadRecordingClaimResult =
  | { status: 'none' }
  | {
      status: 'claimed';
      claimToken: string;
      attempt: number;
      leaseExpiresAt: string;
      capture: DialpadRecordingCapture;
      finalPaths: { track: DialpadRecordingTrack; epoch: number; finalPath: string }[];
    };

export function parseDialpadRecordingClaimResult(value: Json | null | undefined): DialpadRecordingClaimResult {
  const data = record(value, 'seal claim');
  const status = oneOf(data.status, ['none', 'claimed'] as const, 'status');
  if (status === 'none') return { status };
  const paths = data.finalPaths;
  if (!Array.isArray(paths)) throw new Error('Invalid finalPaths.');
  return {
    status,
    claimToken: str(data.claimToken, 'claimToken'),
    attempt: int(data.attempt, 'attempt'),
    leaseExpiresAt: str(data.leaseExpiresAt, 'leaseExpiresAt'),
    capture: parseDialpadRecordingCapture(data.capture),
    finalPaths: paths.map((entry) => {
      const p = record(entry, 'final path');
      return { track: oneOf(p.track, DIALPAD_RECORDING_TRACKS, 'track'), epoch: int(p.epoch, 'epoch'), finalPath: str(p.finalPath, 'finalPath') };
    }),
  };
}

/** One worker report per (track, epoch). Ledger facts are read from the database, never taken from this report. */
export type DialpadRecordingTrackReport =
  | { track: DialpadRecordingTrack; epoch: number; decodeOk: false }
  | {
      track: DialpadRecordingTrack;
      epoch: number;
      decodeOk: true;
      sizeBytes: number;
      sha256: string;
      codec: string;
      sampleRateHz: number;
      channels: 1 | 2;
      decodedDurationMs: number;
    };

export type DialpadRecordingOutcome = 'sealed' | 'partial' | 'failed';

export interface DialpadRecordingRegisterResult {
  status: 'registered' | 'replayed';
  outcome: DialpadRecordingOutcome;
  capture: DialpadRecordingCapture;
}

export function parseDialpadRecordingRegisterResult(value: Json | null | undefined): DialpadRecordingRegisterResult {
  const data = record(value, 'register result');
  return {
    status: oneOf(data.status, ['registered', 'replayed'] as const, 'status'),
    outcome: oneOf(data.outcome, ['sealed', 'partial', 'failed'] as const, 'outcome'),
    capture: parseDialpadRecordingCapture(data.capture),
  };
}
