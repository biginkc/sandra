import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database, Json } from '@/lib/supabase/types';
import { classifyDialpadRecordingRpcError, DialpadRecordingDbError } from './contracts';

const SHA256 = /^[0-9a-f]{64}$/;
const ALGORITHM = 'provider-window-finalizer-v1';

type RpcError = { code?: string | null; details?: string | null; detail?: string | null } | null;
export type ProviderWindowStatus = 'eligible' | 'ineligible' | 'unknown';

export interface DialpadRecordingFinalInput {
  algorithmVersion: typeof ALGORITHM;
  policyVersion: string;
  policyHash: string;
  epoch: number | null;
  inputDigest: string;
  observedSamples: number;
  eligibleSamples: number | null;
  status: ProviderWindowStatus;
  reasons: string[];
  sampleWindow: { lowerSample: number | null; upperSample: number | null };
  selectedSummary: Json;
}

export interface DialpadRecordingFinalization extends DialpadRecordingFinalInput {
  replayed: boolean;
}

export interface DialpadRecordingFinalResult {
  captureId: string;
  observedSamples: number;
  eligibleSamples: number | null;
  status: ProviderWindowStatus;
  reasons: string[];
  evaluatedAt: string;
}

export interface DialpadRecordingFinalResultRead {
  status: 'pending' | 'stale' | ProviderWindowStatus;
  currentAtRead: boolean;
  currentInputDigest: string | null;
  result: DialpadRecordingFinalResult | null;
}

export interface DialpadRecordingFinalizerDb {
  getInput(orgId: string, captureId: string, policyVersion: string): Promise<DialpadRecordingFinalInput>;
  finalize(orgId: string, captureId: string, policyVersion: string, expectedInputDigest: string): Promise<DialpadRecordingFinalization>;
  getResult(orgId: string, repUserId: string, captureId: string): Promise<DialpadRecordingFinalResultRead>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid finalizer ${label}`);
  return value;
}

function digest(value: unknown, label: string): string {
  const result = text(value, label);
  if (!SHA256.test(result)) throw new Error(`Invalid finalizer ${label}`);
  return result;
}

function integer(value: unknown, label: string): number {
  const result = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0) throw new Error(`Invalid finalizer ${label}`);
  return result;
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null || value === undefined ? null : integer(value, label);
}

function parseReasons(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32 || value.some((reason) => typeof reason !== 'string' || reason.length === 0)) throw new Error('Invalid finalizer reasons');
  return value as string[];
}

function parseInput(value: unknown): DialpadRecordingFinalInput {
  if (!isRecord(value) || value.algorithmVersion !== ALGORITHM || !isRecord(value.sampleWindow) || !isRecord(value.selectedSummary)) throw new Error('Invalid Dialpad finalizer input');
  const status = value.status;
  if (status !== 'eligible' && status !== 'ineligible' && status !== 'unknown') throw new Error('Invalid finalizer status');
  const eligibleSamples = nullableInteger(value.eligibleSamples, 'eligible samples');
  if (status === 'unknown' && eligibleSamples !== null) throw new Error('Unknown finalizer input cannot contain eligible samples');
  const observedSamples = integer(value.observedSamples, 'observed samples');
  if (eligibleSamples !== null && eligibleSamples > observedSamples) throw new Error('Finalizer eligible samples exceed observed samples');
  const lowerSample = nullableInteger(value.sampleWindow.lowerSample, 'lower sample');
  const upperSample = nullableInteger(value.sampleWindow.upperSample, 'upper sample');
  if (lowerSample !== null && upperSample !== null && upperSample < lowerSample) throw new Error('Invalid finalizer sample window');
  return {
    algorithmVersion: ALGORITHM,
    policyVersion: text(value.policyVersion, 'policy version'),
    policyHash: digest(value.policyHash, 'policy hash'),
    epoch: value.epoch === null || value.epoch === undefined ? null : integer(value.epoch, 'epoch'),
    inputDigest: digest(value.inputDigest, 'input digest'),
    observedSamples,
    eligibleSamples,
    status,
    reasons: parseReasons(value.reasons),
    sampleWindow: { lowerSample, upperSample },
    selectedSummary: value.selectedSummary as Json,
  };
}

function parseFinalization(value: unknown): DialpadRecordingFinalization {
  if (!isRecord(value) || typeof value.replayed !== 'boolean') throw new Error('Invalid Dialpad finalizer result');
  return { ...parseInput(value), replayed: value.replayed };
}

function parseResult(value: unknown): DialpadRecordingFinalResultRead {
  if (!isRecord(value) || typeof value.currentAtRead !== 'boolean' || (value.status !== 'pending' && value.status !== 'stale' && value.status !== 'eligible' && value.status !== 'ineligible' && value.status !== 'unknown')) throw new Error('Invalid Dialpad finalizer result read');
  const digestValue = value.currentInputDigest === null || value.currentInputDigest === undefined ? null : digest(value.currentInputDigest, 'current input digest');
  if (value.result === null || value.result === undefined) return { status: value.status, currentAtRead: value.currentAtRead, currentInputDigest: digestValue, result: null };
  if (!isRecord(value.result)) throw new Error('Invalid Dialpad finalizer result body');
  const status = value.result.status;
  if (status !== 'eligible' && status !== 'ineligible' && status !== 'unknown') throw new Error('Invalid Dialpad finalizer result status');
  return {
    status: value.status,
    currentAtRead: value.currentAtRead,
    currentInputDigest: digestValue,
    result: {
      captureId: text(value.result.captureId, 'result capture id'),
      observedSamples: integer(value.result.observedSamples, 'result observed samples'),
      eligibleSamples: nullableInteger(value.result.eligibleSamples, 'result eligible samples'),
      status,
      reasons: parseReasons(value.result.reasons),
      evaluatedAt: text(value.result.evaluatedAt, 'evaluated at'),
    },
  };
}

function unwrap<T>(result: { data: T; error: RpcError }): T {
  if (result.error) throw new DialpadRecordingDbError(classifyDialpadRecordingRpcError(result.error), result.error.code ?? null);
  return result.data;
}

export function createSupabaseDialpadRecordingFinalizerDb(client: SupabaseClient<Database>): DialpadRecordingFinalizerDb {
  return {
    async getInput(orgId, captureId, policyVersion) {
      return parseInput(unwrap(await client.rpc('fn_get_dialpad_recording_final_input', { p_org_id: orgId, p_capture_id: captureId, p_policy_version: policyVersion })));
    },
    async finalize(orgId, captureId, policyVersion, expectedInputDigest) {
      return parseFinalization(unwrap(await client.rpc('fn_finalize_dialpad_recording_provider_window', { p_org_id: orgId, p_capture_id: captureId, p_policy_version: policyVersion, p_expected_input_digest: expectedInputDigest })));
    },
    async getResult(orgId, repUserId, captureId) {
      return parseResult(unwrap(await client.rpc('fn_get_dialpad_recording_provider_window_result', { p_org_id: orgId, p_rep_user_id: repUserId, p_capture_id: captureId })));
    },
  };
}
