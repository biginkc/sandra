import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database, Json } from '@/lib/supabase/types';

import {
  classifyDialpadRecordingRpcError,
  DialpadRecordingDbError,
} from './contracts';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ALGORITHM_VERSION = 'provider-window-shadow-v1';

export type DialpadRecordingShadowEvidenceStatus = 'insufficient' | 'conflicting';

export interface DialpadRecordingShadowInput {
  algorithmVersion: typeof ALGORITHM_VERSION;
  inputDigest: string;
  manifest: Json;
  observedSamples: number;
  observedSamplesByEpoch: Json;
  eligibleSamples: null;
  timingStatus: 'unmapped';
  evidenceStatus: DialpadRecordingShadowEvidenceStatus;
  reasons: string[];
  snapshotOnly: true;
}

export interface DialpadRecordingShadowFinalization {
  version: 1;
  algorithmVersion: typeof ALGORITHM_VERSION;
  inputDigest: string;
  evidenceStatus: DialpadRecordingShadowEvidenceStatus;
  reasons: string[];
  observedSamples: number;
  eligibleSamples: null;
  timingStatus: 'unmapped';
  replayed: boolean;
  snapshotOnly: true;
}

export interface DialpadRecordingShadowMeasurement {
  captureId: string;
  orgId: string;
  callActivityId: string;
  intentId: string;
  algorithmVersion: typeof ALGORITHM_VERSION;
  inputDigest: string;
  evidenceManifest: Json;
  observedSamples: number;
  observedSamplesByEpoch: Json;
  eligibleSamples: null;
  timingStatus: 'unmapped';
  evidenceStatus: DialpadRecordingShadowEvidenceStatus;
  reasons: Json;
  evaluatedAt: string;
}

export interface DialpadRecordingShadowMeasurementRead {
  currentAtRead: boolean;
  currentInputDigest: string;
  staleReason: 'provider_evidence_changed' | null;
  measurement: DialpadRecordingShadowMeasurement | null;
  snapshotOnly: true;
}

export interface DialpadRecordingShadowDb {
  getInput(orgId: string, captureId: string): Promise<DialpadRecordingShadowInput>;
  finalize(orgId: string, captureId: string, expectedInputDigest: string): Promise<DialpadRecordingShadowFinalization>;
  getMeasurement(orgId: string, captureId: string): Promise<DialpadRecordingShadowMeasurementRead>;
}

type DbError = { code?: string | null; details?: string | null; message?: string } | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseDigest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) throw new Error(`Invalid Dialpad shadow ${field}`);
  return value;
}

function parseNonnegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid Dialpad shadow ${field}`);
  return value;
}

function parseReasons(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16 || value.some((reason) => typeof reason !== 'string')) {
    throw new Error('Invalid Dialpad shadow reasons');
  }
  return value as string[];
}

function parseEvidenceStatus(value: unknown): DialpadRecordingShadowEvidenceStatus {
  if (value !== 'insufficient' && value !== 'conflicting') throw new Error('Invalid Dialpad shadow evidence status');
  return value;
}

function parseInput(value: unknown): DialpadRecordingShadowInput {
  if (!isRecord(value) || value.algorithmVersion !== ALGORITHM_VERSION || value.eligibleSamples !== null || value.timingStatus !== 'unmapped' || value.snapshotOnly !== true) {
    throw new Error('Invalid Dialpad shadow input');
  }
  if (!isRecord(value.manifest) || !isRecord(value.observedSamplesByEpoch)) throw new Error('Invalid Dialpad shadow manifest');
  return {
    algorithmVersion: ALGORITHM_VERSION,
    inputDigest: parseDigest(value.inputDigest, 'input digest'),
    manifest: value.manifest as Json,
    observedSamples: parseNonnegativeInteger(value.observedSamples, 'observed samples'),
    observedSamplesByEpoch: value.observedSamplesByEpoch as Json,
    eligibleSamples: null,
    timingStatus: 'unmapped',
    evidenceStatus: parseEvidenceStatus(value.evidenceStatus),
    reasons: parseReasons(value.reasons),
    snapshotOnly: true,
  };
}

function parseFinalization(value: unknown): DialpadRecordingShadowFinalization {
  if (!isRecord(value) || value.version !== 1 || value.algorithmVersion !== ALGORITHM_VERSION || value.eligibleSamples !== null || value.timingStatus !== 'unmapped' || typeof value.replayed !== 'boolean' || value.snapshotOnly !== true) {
    throw new Error('Invalid Dialpad shadow finalization');
  }
  return {
    version: 1,
    algorithmVersion: ALGORITHM_VERSION,
    inputDigest: parseDigest(value.inputDigest, 'finalization digest'),
    evidenceStatus: parseEvidenceStatus(value.evidenceStatus),
    reasons: parseReasons(value.reasons),
    observedSamples: parseNonnegativeInteger(value.observedSamples, 'finalization samples'),
    eligibleSamples: null,
    timingStatus: 'unmapped',
    replayed: value.replayed,
    snapshotOnly: true,
  };
}

function parseMeasurement(value: unknown): DialpadRecordingShadowMeasurement {
  if (!isRecord(value) || typeof value.captureId !== 'string' || typeof value.orgId !== 'string' || typeof value.callActivityId !== 'string' || typeof value.intentId !== 'string' || value.algorithmVersion !== ALGORITHM_VERSION || value.eligibleSamples !== null || value.timingStatus !== 'unmapped' || typeof value.evaluatedAt !== 'string') {
    throw new Error('Invalid Dialpad shadow measurement');
  }
  if (!isRecord(value.evidenceManifest) || !isRecord(value.observedSamplesByEpoch)) throw new Error('Invalid Dialpad shadow measurement manifest');
  return {
    captureId: value.captureId,
    orgId: value.orgId,
    callActivityId: value.callActivityId,
    intentId: value.intentId,
    algorithmVersion: ALGORITHM_VERSION,
    inputDigest: parseDigest(value.inputDigest, 'measurement digest'),
    evidenceManifest: value.evidenceManifest as Json,
    observedSamples: parseNonnegativeInteger(value.observedSamples, 'measurement samples'),
    observedSamplesByEpoch: value.observedSamplesByEpoch as Json,
    eligibleSamples: null,
    timingStatus: 'unmapped',
    evidenceStatus: parseEvidenceStatus(value.evidenceStatus),
    reasons: value.reasons as Json,
    evaluatedAt: value.evaluatedAt,
  };
}

function parseMeasurementRead(value: unknown): DialpadRecordingShadowMeasurementRead {
  if (!isRecord(value) || typeof value.currentAtRead !== 'boolean' || value.staleReason !== null && value.staleReason !== 'provider_evidence_changed' || value.snapshotOnly !== true || !parseDigest(value.currentInputDigest, 'current input digest')) {
    throw new Error('Invalid Dialpad shadow measurement read');
  }
  const currentInputDigest = parseDigest(value.currentInputDigest, 'current input digest');
  return {
    currentAtRead: value.currentAtRead,
    currentInputDigest,
    staleReason: value.staleReason as DialpadRecordingShadowMeasurementRead['staleReason'],
    measurement: value.measurement === null ? null : parseMeasurement(value.measurement),
    snapshotOnly: true,
  };
}

function unwrap<T>(result: { data: T; error: DbError }): T {
  if (result.error) throw new DialpadRecordingDbError(classifyDialpadRecordingRpcError(result.error), result.error.code ?? null);
  return result.data;
}

export function createSupabaseDialpadRecordingShadowDb(client: SupabaseClient<Database>): DialpadRecordingShadowDb {
  return {
    async getInput(orgId, captureId) {
      return parseInput(unwrap(await client.rpc('fn_get_dialpad_recording_shadow_input', { p_org_id: orgId, p_capture_id: captureId })));
    },
    async finalize(orgId, captureId, expectedInputDigest) {
      return parseFinalization(unwrap(await client.rpc('fn_finalize_dialpad_recording_shadow', {
        p_org_id: orgId,
        p_capture_id: captureId,
        p_expected_input_digest: expectedInputDigest,
      })));
    },
    async getMeasurement(orgId, captureId) {
      return parseMeasurementRead(unwrap(await client.rpc('fn_get_dialpad_recording_shadow_measurement', { p_org_id: orgId, p_capture_id: captureId })));
    },
  };
}
