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
/** VAD evidence is integer 16 kHz samples; this strict crossing is transport evidence only. */
export const DIALPAD_RECORDING_VAD_SAMPLE_RATE_HZ = 16_000;
export const DIALPAD_RECORDING_VAD_THRESHOLD_SAMPLES = 4_800_000;
export const DIALPAD_RECORDING_VAD_MAX_RANGES_PER_BATCH = 256;
export const DIALPAD_RECORDING_VAD_MAX_SAMPLE = 1_000_000_000_000;
export const DIALPAD_RECORDING_BUCKET = 'dialpad-recordings';
export const DIALPAD_RECORDING_GRANT_TTL_SECONDS = { min: 10, max: 300, default: 60 } as const;
const SHA256_HEX = /^[0-9a-f]{64}$/;

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

/** Denials returned by the browser-session epoch allocator. */
export const DIALPAD_RECORDING_BROWSER_MINT_DENIALS = [
  ...DIALPAD_RECORDING_MINT_DENIALS,
  'epoch_stale',
  'grant_pending',
  'epoch_limit',
  'ingest_not_configured',
] as const;
export type DialpadRecordingBrowserMintDenial = (typeof DIALPAD_RECORDING_BROWSER_MINT_DENIALS)[number];

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
  eofSha256: string | null;
  eofMarkedAt: string | null;
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

function strings(value: Json | undefined, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry.length > 0)) throw new Error(`Invalid ${label}.`);
  return value as string[];
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
    eofSha256: nullableStr(data.eofSha256, 'eofSha256'),
    eofMarkedAt: nullableStr(data.eofMarkedAt, 'eofMarkedAt'),
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

export type DialpadRecordingBrowserGrantResult =
  | {
      status: 'minted' | 'replayed';
      grantId: string;
      captureId: string;
      epoch: number;
      expiresAt: string;
      ingestEndpoint: string;
      controlVersion: 2;
    }
  | { status: 'denied'; reason: DialpadRecordingBrowserMintDenial; latestConsumedEpoch?: number };

function trustedIngestEndpoint(value: Json | undefined): string {
  const endpoint = str(value, 'ingestEndpoint');
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('Invalid ingestEndpoint.');
  }
  if (parsed.protocol !== 'wss:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/dialpad-browser-ingest') {
    throw new Error('Invalid ingestEndpoint.');
  }
  return endpoint;
}

export function parseDialpadRecordingBrowserGrantResult(value: Json | null | undefined): DialpadRecordingBrowserGrantResult {
  const data = record(value, 'browser ingest grant');
  const status = oneOf(data.status, ['minted', 'replayed', 'denied'] as const, 'status');
  if (status === 'denied') {
    const latest = data.latestConsumedEpoch;
    if (latest !== undefined && latest !== null && (typeof latest !== 'number' || !Number.isSafeInteger(latest) || latest < 0 || latest > DIALPAD_RECORDING_MAX_EPOCH)) throw new Error('Invalid latestConsumedEpoch.');
    return { status, reason: oneOf(data.reason, DIALPAD_RECORDING_BROWSER_MINT_DENIALS, 'reason'), ...(latest === undefined || latest === null ? {} : { latestConsumedEpoch: latest }) };
  }
  if (data.controlVersion !== 2) throw new Error('Invalid controlVersion.');
  return {
    status,
    grantId: str(data.grantId, 'grantId'),
    captureId: str(data.captureId, 'captureId'),
    epoch: int(data.epoch, 'epoch'),
    expiresAt: str(data.expiresAt, 'expiresAt'),
    ingestEndpoint: trustedIngestEndpoint(data.ingestEndpoint),
    controlVersion: 2,
  };
}

export interface DialpadRecordingBrowserCrossing {
  status: 'latched';
  thresholdSamples: number;
  crossingTotalSamples: number;
  crossingEpoch: number;
  crossingSample: number;
  crossingStartSample: number;
  crossingEndSample: number;
}

export interface DialpadRecordingBrowserFinalResult {
  status: 'stale' | 'eligible' | 'ineligible' | 'unknown';
  observedSamples: number;
  eligibleSamples: number | null;
  reasons: string[];
  evaluatedAt: string;
}

export interface DialpadRecordingBrowserStatus {
  captureId: string;
  captureStatus: DialpadCaptureState;
  closedAt: string | null;
  drainDeadlineAt: string | null;
  latestConsumedEpoch: number;
  ingestEndpoint: string | null;
  controlVersion: 2;
  tracks: DialpadRecordingTrack[];
  totalSamples: number;
  measurementStatus: 'provisional' | 'partial' | 'finalized';
  crossing: DialpadRecordingBrowserCrossing | null;
  finalResult: DialpadRecordingBrowserFinalResult | null;
}

export function parseDialpadRecordingBrowserStatus(value: Json | null | undefined): DialpadRecordingBrowserStatus {
  const data = record(value, 'browser recording status');
  if (data.controlVersion !== 2) throw new Error('Invalid controlVersion.');
  if (!Array.isArray(data.tracks) || data.tracks.length !== 2 || data.tracks[0] !== 'tab' || data.tracks[1] !== 'mic') throw new Error('Invalid tracks.');
  const endpoint = data.ingestEndpoint === null || data.ingestEndpoint === undefined ? null : trustedIngestEndpoint(data.ingestEndpoint);
  let crossing: DialpadRecordingBrowserCrossing | null = null;
  if (data.crossing !== null && data.crossing !== undefined) {
    const value = record(data.crossing, 'browser crossing');
    crossing = {
      status: oneOf(value.status, ['latched'] as const, 'crossing status'),
      thresholdSamples: bigish(value.thresholdSamples, 'thresholdSamples'),
      crossingTotalSamples: bigish(value.crossingTotalSamples, 'crossingTotalSamples'),
      crossingEpoch: int(value.crossingEpoch, 'crossingEpoch'),
      crossingSample: bigish(value.crossingSample, 'crossingSample'),
      crossingStartSample: bigish(value.crossingStartSample, 'crossingStartSample'),
      crossingEndSample: bigish(value.crossingEndSample, 'crossingEndSample'),
    };
  }
  let finalResult: DialpadRecordingBrowserFinalResult | null = null;
  if (data.finalResult !== null && data.finalResult !== undefined) {
    const value = record(data.finalResult, 'browser final result');
    finalResult = {
      status: oneOf(value.status, ['stale', 'eligible', 'ineligible', 'unknown'] as const, 'final result status'),
      observedSamples: bigish(value.observedSamples, 'final result observed samples'),
      eligibleSamples: nullableInt(value.eligibleSamples, 'final result eligible samples'),
      reasons: strings(value.reasons, 'final result reasons'),
      evaluatedAt: str(value.evaluatedAt, 'final result evaluatedAt'),
    };
  }
  return {
    captureId: str(data.captureId, 'captureId'),
    captureStatus: oneOf(data.captureStatus, DIALPAD_CAPTURE_STATES, 'captureStatus'),
    closedAt: nullableStr(data.closedAt, 'closedAt'),
    drainDeadlineAt: nullableStr(data.drainDeadlineAt, 'drainDeadlineAt'),
    latestConsumedEpoch: int(data.latestConsumedEpoch, 'latestConsumedEpoch'),
    ingestEndpoint: endpoint,
    controlVersion: 2,
    tracks: ['tab', 'mic'],
    totalSamples: bigish(data.totalSamples, 'totalSamples'),
    measurementStatus: oneOf(data.measurementStatus, ['provisional', 'partial', 'finalized'] as const, 'measurementStatus'),
    crossing,
    finalResult,
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

export interface DialpadRecordingEofResult {
  status: 'recorded' | 'replayed';
  captureId: string;
  track: DialpadRecordingTrack;
  epoch: number;
  seq: number;
  sha256: string;
}

export function parseDialpadRecordingEofResult(value: Json | null | undefined): DialpadRecordingEofResult {
  const data = record(value, 'recording EOF');
  const sha256 = str(data.sha256, 'sha256');
  if (!SHA256_HEX.test(sha256)) throw new Error('Invalid sha256.');
  return {
    status: oneOf(data.status, ['recorded', 'replayed'] as const, 'status'),
    captureId: str(data.captureId, 'captureId'),
    track: oneOf(data.track, DIALPAD_RECORDING_TRACKS, 'track'),
    epoch: int(data.epoch, 'epoch'),
    seq: int(data.seq, 'seq'),
    sha256,
  };
}

const CALL_STATES = ['prepared', 'awaiting_provider', 'dialing', 'connected', 'ended', 'cancelled', 'expired'] as const;
type DialpadCallState = (typeof CALL_STATES)[number];

export interface DialpadRecordingCallStatus {
  intentId: string;
  state: DialpadCallState;
  connected: boolean;
  propertyId: string;
  expiresAt: string;
  dispatchAuthorizedAt: string | null;
  callActivityId: string | null;
  attemptId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  talkDurationSeconds: number | null;
}

export interface DialpadRecordingLifecycle {
  captureId: string;
  orgId: string;
  repUserId: string;
  intentId: string;
  callActivityId: string;
  providerCallId: string;
  captureStatus: DialpadCaptureState;
  callStatus: DialpadRecordingCallStatus;
  callState: DialpadCallState;
  connected: boolean;
  ended: boolean;
  acceptsLivePcm: boolean;
  allowsRetentionDrain: boolean;
  closedAt: string | null;
  closeReason: DialpadCaptureCloseReason | null;
  drainDeadlineAt: string | null;
}

function nullableBool(value: Json | undefined, label: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'boolean') throw new Error(`Invalid ${label}.`);
  return value;
}

function parseCallStatus(value: Json | undefined): DialpadRecordingCallStatus {
  const data = record(value, 'call status');
  return {
    intentId: str(data.intentId, 'intentId'),
    state: oneOf(data.state, CALL_STATES, 'state'),
    connected: nullableBool(data.connected, 'connected') ?? false,
    propertyId: str(data.propertyId, 'propertyId'),
    expiresAt: str(data.expiresAt, 'expiresAt'),
    dispatchAuthorizedAt: nullableStr(data.dispatchAuthorizedAt, 'dispatchAuthorizedAt'),
    callActivityId: nullableStr(data.callActivityId, 'callActivityId'),
    attemptId: nullableStr(data.attemptId, 'attemptId'),
    startedAt: nullableStr(data.startedAt, 'startedAt'),
    endedAt: nullableStr(data.endedAt, 'endedAt'),
    durationSeconds: nullableInt(data.durationSeconds, 'durationSeconds'),
    talkDurationSeconds: nullableInt(data.talkDurationSeconds, 'talkDurationSeconds'),
  };
}

export function parseDialpadRecordingLifecycle(value: Json | null | undefined): DialpadRecordingLifecycle {
  const data = record(value, 'recording lifecycle');
  return {
    captureId: str(data.captureId, 'captureId'),
    orgId: str(data.orgId, 'orgId'),
    repUserId: str(data.repUserId, 'repUserId'),
    intentId: str(data.intentId, 'intentId'),
    callActivityId: str(data.callActivityId, 'callActivityId'),
    providerCallId: str(data.providerCallId, 'providerCallId'),
    captureStatus: oneOf(data.captureStatus, DIALPAD_CAPTURE_STATES, 'captureStatus'),
    callStatus: parseCallStatus(data.callStatus),
    callState: oneOf(data.callState, CALL_STATES, 'callState'),
    connected: nullableBool(data.connected, 'connected') ?? false,
    ended: typeof data.ended === 'boolean' ? data.ended : (() => { throw new Error('Invalid ended.'); })(),
    acceptsLivePcm: typeof data.acceptsLivePcm === 'boolean' ? data.acceptsLivePcm : (() => { throw new Error('Invalid acceptsLivePcm.'); })(),
    allowsRetentionDrain: typeof data.allowsRetentionDrain === 'boolean' ? data.allowsRetentionDrain : (() => { throw new Error('Invalid allowsRetentionDrain.'); })(),
    closedAt: nullableStr(data.closedAt, 'closedAt'),
    closeReason: nullableOneOf(data.closeReason, DIALPAD_CAPTURE_CLOSE_REASONS, 'closeReason'),
    drainDeadlineAt: nullableStr(data.drainDeadlineAt, 'drainDeadlineAt'),
  };
}

export interface DialpadRecordingSealInput {
  captureId: string;
  orgId: string;
  track: DialpadRecordingTrack;
  epoch: number;
  seq: number;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
  isEof: boolean;
  eofSha256?: string | null;
}

export interface DialpadRecordingSealInputsResult {
  status: 'ready';
  captureId: string;
  claimToken: string;
  inputs: DialpadRecordingSealInput[];
}

export function parseDialpadRecordingSealInputs(value: Json | null | undefined): DialpadRecordingSealInputsResult {
  const data = record(value, 'seal inputs');
  if (!Array.isArray(data.inputs)) throw new Error('Invalid seal inputs.');
  return {
    status: oneOf(data.status, ['ready'] as const, 'status'),
    captureId: str(data.captureId, 'captureId'),
    claimToken: str(data.claimToken, 'claimToken'),
    inputs: data.inputs.map((entry) => {
      const item = record(entry, 'seal input');
      const sha256 = str(item.sha256, 'sha256');
      if (!SHA256_HEX.test(sha256)) throw new Error('Invalid sha256.');
      if (typeof item.isEof !== 'boolean') throw new Error('Invalid isEof.');
      const eofSha256 = item.eofSha256 === null || item.eofSha256 === undefined ? null : str(item.eofSha256, 'eofSha256');
      if (eofSha256 !== null && !SHA256_HEX.test(eofSha256)) throw new Error('Invalid eofSha256.');
      return {
        captureId: str(item.captureId, 'captureId'),
        orgId: str(item.orgId, 'orgId'),
        track: oneOf(item.track, DIALPAD_RECORDING_TRACKS, 'track'),
        epoch: int(item.epoch, 'epoch'),
        seq: int(item.seq, 'seq'),
        sizeBytes: int(item.sizeBytes, 'sizeBytes'),
        sha256,
        storagePath: str(item.storagePath, 'storagePath'),
        isEof: item.isEof,
        eofSha256,
      };
    }),
  };
}

export interface DialpadRecordingVadRange {
  startSample: number;
  endSample: number;
  evidenceRef: string;
}

export interface DialpadRecordingVadThreshold {
  status: 'latched' | 'not_latched';
  thresholdSamples: number;
  crossingTotalSamples?: number;
  crossingEpoch?: number;
  crossingSample?: number;
  crossingStartSample?: number;
  crossingEndSample?: number;
  evidenceRef?: string;
  latchedAt?: string;
}

export interface DialpadRecordingVadResult {
  status: 'recorded' | 'replayed';
  captureId: string;
  track: 'tab';
  epoch: number;
  batchId: string;
  rangeCount: number;
  voicedSamples: number;
  measurementStatus: 'provisional' | 'partial' | 'finalized';
  highWaterEpoch: number | null;
  highWaterEndSample: number | null;
  threshold: DialpadRecordingVadThreshold;
}

export function parseDialpadRecordingVadResult(value: Json | null | undefined): DialpadRecordingVadResult {
  const data = record(value, 'VAD ranges');
  const thresholdData = record(data.threshold, 'VAD threshold');
  const thresholdStatus = oneOf(thresholdData.status, ['latched', 'not_latched'] as const, 'threshold status');
  return {
    status: oneOf(data.status, ['recorded', 'replayed'] as const, 'status'),
    captureId: str(data.captureId, 'captureId'),
    track: oneOf(data.track, ['tab'] as const, 'track'),
    epoch: int(data.epoch, 'epoch'),
    batchId: str(data.batchId, 'batchId'),
    rangeCount: int(data.rangeCount, 'rangeCount'),
    voicedSamples: bigish(data.voicedSamples, 'voicedSamples'),
    measurementStatus: oneOf(data.measurementStatus, ['provisional', 'partial', 'finalized'] as const, 'measurementStatus'),
    highWaterEpoch: nullableInt(data.highWaterEpoch, 'highWaterEpoch'),
    highWaterEndSample: data.highWaterEndSample === null || data.highWaterEndSample === undefined ? null : bigish(data.highWaterEndSample, 'highWaterEndSample'),
    threshold: {
      status: thresholdStatus,
      thresholdSamples: bigish(thresholdData.thresholdSamples, 'thresholdSamples'),
      ...(thresholdStatus === 'latched' ? {
        crossingTotalSamples: bigish(thresholdData.crossingTotalSamples, 'crossingTotalSamples'),
        crossingEpoch: int(thresholdData.crossingEpoch, 'crossingEpoch'),
        crossingSample: bigish(thresholdData.crossingSample, 'crossingSample'),
        crossingStartSample: bigish(thresholdData.crossingStartSample, 'crossingStartSample'),
        crossingEndSample: bigish(thresholdData.crossingEndSample, 'crossingEndSample'),
        evidenceRef: str(thresholdData.evidenceRef, 'evidenceRef'),
        latchedAt: str(thresholdData.latchedAt, 'latchedAt'),
      } : {}),
    },
  };
}

export interface DialpadRecordingPcmProgressResult {
  status: 'recorded' | 'replayed';
  captureId: string;
  track: DialpadRecordingTrack;
  epoch: number;
  batchId: string;
  processedThroughSample: number;
  pcmEofSample: number | null;
  sourceSampleRateHz: number | null;
  sourceChannels: number | null;
  sourceCodec: string | null;
  normalizedSampleRateHz: number;
  normalizedChannels: number;
  degradedReasons: string[];
}

export function parseDialpadRecordingPcmProgressResult(value: Json | null | undefined): DialpadRecordingPcmProgressResult {
  const data = record(value, 'PCM progress');
  return {
    status: oneOf(data.status, ['recorded', 'replayed'] as const, 'status'),
    captureId: str(data.captureId, 'captureId'),
    track: oneOf(data.track, DIALPAD_RECORDING_TRACKS, 'track'),
    epoch: int(data.epoch, 'epoch'),
    batchId: str(data.batchId, 'batchId'),
    processedThroughSample: bigish(data.processedThroughSample, 'processedThroughSample'),
    pcmEofSample: data.pcmEofSample === null || data.pcmEofSample === undefined ? null : bigish(data.pcmEofSample, 'pcmEofSample'),
    sourceSampleRateHz: data.sourceSampleRateHz === null || data.sourceSampleRateHz === undefined ? null : int(data.sourceSampleRateHz, 'sourceSampleRateHz'),
    sourceChannels: data.sourceChannels === null || data.sourceChannels === undefined ? null : int(data.sourceChannels, 'sourceChannels'),
    sourceCodec: nullableStr(data.sourceCodec, 'sourceCodec'),
    normalizedSampleRateHz: int(data.normalizedSampleRateHz, 'normalizedSampleRateHz'),
    normalizedChannels: int(data.normalizedChannels, 'normalizedChannels'),
    degradedReasons: strings(data.degradedReasons, 'degradedReasons'),
  };
}

export interface DialpadRecordingPcmSnapshot {
  track: DialpadRecordingTrack;
  epoch: number;
  processedThroughSample: number;
  pcmEofSample: number | null;
  sourceSampleRateHz: number | null;
  sourceChannels: number | null;
  sourceCodec: string | null;
  normalizedSampleRateHz: number;
  normalizedChannels: number;
  degradedReasons: string[];
}

export interface DialpadRecordingVadSnapshot {
  version: number;
  captureId: string;
  totalSamples: number;
  measurementStatus: 'provisional' | 'partial' | 'finalized';
  epoch: number | null;
  epochCreditedThrough: number | null;
  crossing: DialpadRecordingVadThreshold | null;
  processedPcm: DialpadRecordingPcmSnapshot[];
  degradedReasons: string[];
}

export function parseDialpadRecordingVadSnapshot(value: Json | null | undefined): DialpadRecordingVadSnapshot {
  const data = record(value, 'VAD snapshot');
  if (!Array.isArray(data.processedPcm)) throw new Error('Invalid processedPcm.');
  const crossingData = data.crossing;
  let crossing: DialpadRecordingVadThreshold | null = null;
  if (crossingData !== null && crossingData !== undefined) {
    const parsed = record(crossingData, 'VAD crossing');
    crossing = {
      status: oneOf(parsed.status, ['latched'] as const, 'crossing status'),
      thresholdSamples: bigish(parsed.thresholdSamples, 'thresholdSamples'),
      crossingTotalSamples: bigish(parsed.crossingTotalSamples, 'crossingTotalSamples'),
      crossingEpoch: int(parsed.crossingEpoch, 'crossingEpoch'),
      crossingSample: bigish(parsed.crossingSample, 'crossingSample'),
      crossingStartSample: bigish(parsed.crossingStartSample, 'crossingStartSample'),
      crossingEndSample: bigish(parsed.crossingEndSample, 'crossingEndSample'),
      evidenceRef: str(parsed.evidenceRef, 'evidenceRef'),
      latchedAt: str(parsed.latchedAt, 'latchedAt'),
    };
  }
  return {
    version: int(data.version, 'version'),
    captureId: str(data.captureId, 'captureId'),
    totalSamples: bigish(data.totalSamples, 'totalSamples'),
    measurementStatus: oneOf(data.measurementStatus, ['provisional', 'partial', 'finalized'] as const, 'measurementStatus'),
    epoch: nullableInt(data.epoch, 'epoch'),
    epochCreditedThrough: data.epochCreditedThrough === null || data.epochCreditedThrough === undefined ? null : bigish(data.epochCreditedThrough, 'epochCreditedThrough'),
    crossing,
    processedPcm: data.processedPcm.map((entry) => {
      const item = record(entry, 'PCM snapshot');
      const sourceCodec = nullableStr(item.sourceCodec, 'sourceCodec');
      return {
        track: oneOf(item.track, DIALPAD_RECORDING_TRACKS, 'track'),
        epoch: int(item.epoch, 'epoch'),
        processedThroughSample: bigish(item.processedThroughSample, 'processedThroughSample'),
        pcmEofSample: item.pcmEofSample === null || item.pcmEofSample === undefined ? null : bigish(item.pcmEofSample, 'pcmEofSample'),
        sourceSampleRateHz: item.sourceSampleRateHz === null || item.sourceSampleRateHz === undefined ? null : int(item.sourceSampleRateHz, 'sourceSampleRateHz'),
        sourceChannels: item.sourceChannels === null || item.sourceChannels === undefined ? null : int(item.sourceChannels, 'sourceChannels'),
        sourceCodec,
        normalizedSampleRateHz: int(item.normalizedSampleRateHz, 'normalizedSampleRateHz'),
        normalizedChannels: int(item.normalizedChannels, 'normalizedChannels'),
        degradedReasons: strings(item.degradedReasons, 'degradedReasons'),
      };
    }),
    degradedReasons: strings(data.degradedReasons, 'degradedReasons'),
  };
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
