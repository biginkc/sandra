import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database, Json } from '@/lib/supabase/types'
import { classifyDialpadRecordingRpcError, DialpadRecordingDbError } from './contracts'

export const DIALPAD_TIMING_MAX_EPOCH = 16
export const DIALPAD_TIMING_MAX_RECORDS_PER_BATCH = 16
export const DIALPAD_TIMING_MAX_BATCH_BYTES = 12 * 1024
export const DIALPAD_TIMING_MAX_RECORD_BYTES = 2 * 1024
export const DIALPAD_TIMING_MAX_RECORDS_PER_CAPTURE = 8_192
export const DIALPAD_TIMING_MAX_CAPTURE_BYTES = 16 * 1024 * 1024
export const DIALPAD_TIMING_MAX_REASONS = 8

export const DIALPAD_TIMING_REASONS = [
  'missing_anchor', 'clock_discontinuity', 'exchange_timeout', 'observation_overflow',
  'persistence_failed', 'capture_interrupted', 'missing_final', 'sequence_gap', 'legacy_unavailable',
] as const
export type DialpadTimingReason = (typeof DIALPAD_TIMING_REASONS)[number]
export type DialpadTimingTrack = 'tab' | 'mic'
export type DialpadTimingContinuity = 'continuous' | 'empty_input_gap' | 'context_frame_gap' | 'channel_change' | 'unknown'

export type DialpadTimingAnchor = {
  readonly kind: 'anchor'
  readonly track: DialpadTimingTrack
  readonly seq: number
  readonly contextId: string
  readonly anchor: 'start' | 'periodic' | 'discontinuity' | 'final'
  readonly contextFrame: number
  readonly sourceCursor: number
  readonly blockLength: number
  readonly sourceRateHz: number
  readonly outputCursor: number
  readonly outputFrameIndex: number
  readonly phaseNumerator: number
  readonly continuity: DialpadTimingContinuity
  readonly previousContextEndFrame: number | null
  readonly discardedTailSamples: number | null
}

export type DialpadTimingContextClock = {
  readonly kind: 'context_clock'
  readonly track: DialpadTimingTrack
  readonly seq: number
  readonly contextId: string
  readonly observation: 'start' | 'periodic' | 'state_change' | 'final'
  readonly browserBeforeMs: number
  readonly contextTimeMs: number
  readonly browserAfterMs: number
  readonly browserTimeOriginMs: number
  readonly state: 'running' | 'suspended' | 'closed'
}

export type DialpadTimingExchange = {
  readonly kind: 'exchange'
  readonly seq: number
  readonly serverClockId: string
  readonly browserSendMs: number
  readonly browserReceiveMs: number
  readonly serverReceiveMonoMs: number
  readonly serverSendMonoMs: number
  readonly serverReceiveWallMs: number
  readonly serverSendWallMs: number
}

export type DialpadTimingRecord = DialpadTimingAnchor | DialpadTimingContextClock | DialpadTimingExchange

export type DialpadTimingEndSequences = {
  readonly tabAnchor: number
  readonly micAnchor: number
  readonly tabContext: number
  readonly micContext: number
  readonly exchange: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const integer = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(v, key))
const oneOf = <T extends string>(v: unknown, values: readonly T[]): v is T => typeof v === 'string' && values.includes(v as T)

function invalid(message: string): Error { return new Error(`Invalid Dialpad timing ${message}`) }

function parseAnchor(v: Record<string, unknown>): DialpadTimingAnchor {
  const keys = ['kind', 'track', 'seq', 'contextId', 'anchor', 'contextFrame', 'sourceCursor', 'blockLength', 'sourceRateHz', 'outputCursor', 'outputFrameIndex', 'phaseNumerator', 'continuity', 'previousContextEndFrame', 'discardedTailSamples']
  if (!exact(v, keys) || v.kind !== 'anchor' || !oneOf(v.track, ['tab', 'mic']) || !integer(v.seq) || !UUID.test(String(v.contextId)) || !oneOf(v.anchor, ['start', 'periodic', 'discontinuity', 'final']) || !integer(v.contextFrame) || !integer(v.sourceCursor) || !integer(v.blockLength) || !integer(v.sourceRateHz, 8_000) || v.sourceRateHz > 192_000 || !integer(v.outputCursor) || !integer(v.outputFrameIndex) || !integer(v.phaseNumerator) || v.phaseNumerator >= 16_000 || !oneOf(v.continuity, ['continuous', 'empty_input_gap', 'context_frame_gap', 'channel_change', 'unknown']) || !(v.previousContextEndFrame === null || integer(v.previousContextEndFrame)) || !(v.discardedTailSamples === null || integer(v.discardedTailSamples))) throw invalid('anchor')
  if (v.anchor === 'final' && v.blockLength !== 0) throw invalid('final anchor')
  return v as DialpadTimingAnchor
}

function parseContext(v: Record<string, unknown>): DialpadTimingContextClock {
  const keys = ['kind', 'track', 'seq', 'contextId', 'observation', 'browserBeforeMs', 'contextTimeMs', 'browserAfterMs', 'browserTimeOriginMs', 'state']
  if (!exact(v, keys) || v.kind !== 'context_clock' || !oneOf(v.track, ['tab', 'mic']) || !integer(v.seq) || !UUID.test(String(v.contextId)) || !oneOf(v.observation, ['start', 'periodic', 'state_change', 'final']) || !finite(v.browserBeforeMs) || !finite(v.contextTimeMs) || !finite(v.browserAfterMs) || !finite(v.browserTimeOriginMs) || v.browserBeforeMs > v.browserAfterMs || !oneOf(v.state, ['running', 'suspended', 'closed'])) throw invalid('context clock')
  return v as DialpadTimingContextClock
}

function parseExchange(v: Record<string, unknown>): DialpadTimingExchange {
  const keys = ['kind', 'seq', 'serverClockId', 'browserSendMs', 'browserReceiveMs', 'serverReceiveMonoMs', 'serverSendMonoMs', 'serverReceiveWallMs', 'serverSendWallMs']
  if (!exact(v, keys) || v.kind !== 'exchange' || !integer(v.seq) || !UUID.test(String(v.serverClockId)) || !finite(v.browserSendMs) || !finite(v.browserReceiveMs) || !finite(v.serverReceiveMonoMs) || !finite(v.serverSendMonoMs) || !finite(v.serverReceiveWallMs) || !finite(v.serverSendWallMs) || v.browserReceiveMs < v.browserSendMs || v.serverSendMonoMs < v.serverReceiveMonoMs) throw invalid('exchange')
  return v as DialpadTimingExchange
}

export function parseDialpadTimingRecord(value: unknown): DialpadTimingRecord {
  if (!object(value) || typeof value.kind !== 'string') throw invalid('record')
  if (value.kind === 'anchor') return parseAnchor(value)
  if (value.kind === 'context_clock') return parseContext(value)
  if (value.kind === 'exchange') return parseExchange(value)
  throw invalid('record kind')
}

export function parseDialpadTimingReasons(value: unknown): DialpadTimingReason[] {
  if (!Array.isArray(value) || value.length > DIALPAD_TIMING_MAX_REASONS || new Set(value).size !== value.length || value.some((reason) => !oneOf(reason, DIALPAD_TIMING_REASONS))) throw invalid('reasons')
  const sorted = [...value].sort()
  if (value.some((reason, index) => reason !== sorted[index])) throw invalid('reasons')
  return [...value] as DialpadTimingReason[]
}

export function parseDialpadTimingEndSequences(value: unknown): DialpadTimingEndSequences {
  if (!object(value) || !exact(value, ['tabAnchor', 'micAnchor', 'tabContext', 'micContext', 'exchange']) || !integer(value.tabAnchor, -1) || value.tabAnchor > 2_147_483_647 || !integer(value.micAnchor, -1) || value.micAnchor > 2_147_483_647 || !integer(value.tabContext, -1) || value.tabContext > 2_147_483_647 || !integer(value.micContext, -1) || value.micContext > 2_147_483_647 || !integer(value.exchange, -1) || value.exchange > 2_147_483_647) throw invalid('last sequences')
  return value as DialpadTimingEndSequences
}

export function timingRecordStream(record: DialpadTimingRecord): string {
  if (record.kind === 'anchor') return `${record.track}:anchor`
  if (record.kind === 'context_clock') return `${record.track}:context`
  return 'exchange'
}

export function encodeDialpadTimingBatch(epoch: number, batchId: string, records: readonly DialpadTimingRecord[]): string {
  if (!integer(epoch, 1) || epoch > DIALPAD_TIMING_MAX_EPOCH || !UUID.test(batchId) || records.length < 1 || records.length > DIALPAD_TIMING_MAX_RECORDS_PER_BATCH) throw invalid('batch')
  records.forEach(parseDialpadTimingRecord)
  const encoded = JSON.stringify({ type: 'timing_batch', epoch, batchId, records })
  if (new TextEncoder().encode(encoded).byteLength > DIALPAD_TIMING_MAX_BATCH_BYTES) throw invalid('batch size')
  return encoded
}

export type DialpadTimingDb = {
  append(orgId: string, captureId: string, epoch: number, batchId: string, records: readonly DialpadTimingRecord[]): Promise<{ status: 'recorded' | 'replayed'; recordCount: number; captureRecordCount: number }>
  finish(orgId: string, captureId: string, epoch: number, lastSequences: DialpadTimingEndSequences, outcome: 'collected' | 'incomplete', reasons: readonly DialpadTimingReason[]): Promise<{ status: 'collected' | 'incomplete'; reasons: DialpadTimingReason[] }>
}

type DbError = { code?: string | null; details?: string | null; detail?: string | null } | null
function unwrap<T>(result: { data: T; error: DbError }): T {
  if (result.error) throw new DialpadRecordingDbError(classifyDialpadRecordingRpcError(result.error), result.error.code ?? null)
  return result.data
}

function parseAppend(value: unknown) {
  if (!object(value) || !oneOf(value.status, ['recorded', 'replayed']) || !integer(value.recordCount, 1) || value.recordCount > DIALPAD_TIMING_MAX_RECORDS_PER_BATCH || !integer(value.captureRecordCount) || value.captureRecordCount > DIALPAD_TIMING_MAX_RECORDS_PER_CAPTURE) throw invalid('append response')
  return { status: value.status, recordCount: value.recordCount, captureRecordCount: value.captureRecordCount } as { status: 'recorded' | 'replayed'; recordCount: number; captureRecordCount: number }
}
function parseFinish(value: unknown) {
  if (!object(value) || !oneOf(value.status, ['collected', 'incomplete'])) throw invalid('finish response')
  return { status: value.status, reasons: parseDialpadTimingReasons(value.reasons) }
}

export function createSupabaseDialpadTimingDb(client: SupabaseClient<Database>): DialpadTimingDb {
  return {
    async append(orgId, captureId, epoch, batchId, records) {
      const result = unwrap(await client.rpc('fn_append_dialpad_recording_timing', { p_org_id: orgId, p_capture_id: captureId, p_epoch: epoch, p_batch_id: batchId, p_records: records as unknown as Json }))
      return parseAppend(result)
    },
    async finish(orgId, captureId, epoch, lastSequences, outcome, reasons) {
      const result = unwrap(await client.rpc('fn_finish_dialpad_recording_timing', { p_org_id: orgId, p_capture_id: captureId, p_epoch: epoch, p_last_sequences: lastSequences as unknown as Json, p_outcome: outcome, p_reasons: reasons as unknown as Json }))
      return parseFinish(result)
    },
  }
}
