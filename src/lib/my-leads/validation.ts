/** Shared client/server validation; database commands enforce the same invariants. */
import type {
  AcquisitionAttemptKind,
  AcquisitionAttemptOutcome,
  AcquisitionAttemptSource,
  AcquisitionMutationEnvelope,
} from './types';

export type MotivationResponse =
  | { kind: 'specified'; text: string }
  | { kind: 'no_motivation'; text: null };
export type Validation<T> = { ok: true; value: T } | { ok: false; message: string };

export function motivationResponse(kind: unknown, text: unknown): Validation<MotivationResponse> {
  if (kind === 'no_motivation') return { ok: true, value: { kind, text: null } };
  if (kind === 'specified' && typeof text === 'string' && text.trim()) {
    if (text.trim().length > 10_000) return { ok: false, message: 'Motivation must be 10,000 characters or fewer.' };
    return { ok: true, value: { kind, text: text.trim() } };
  }
  return { ok: false, message: 'Specify the motivation or choose No motivation provided.' };
}

/** Decimal string to integer cents without binary-float rounding or exponent parsing. */
export function offerAmountCents(value: unknown): Validation<number> {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value.trim())) {
    return { ok: false, message: 'Enter a positive offer amount with at most two decimal places.' };
  }
  const [whole, fraction = ''] = value.trim().split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0) return { ok: false, message: 'Enter a valid positive offer amount.' };
  return { ok: true, value: cents };
}

export function offerFollowUp(sentAt: string, followUpAt: string): Validation<{ sentAt: string; followUpAt: string }> {
  const offset = /(?:Z|[+-]\d{2}:\d{2})$/;
  const sent = Date.parse(sentAt);
  const follow = Date.parse(followUpAt);
  if (!offset.test(sentAt) || !offset.test(followUpAt) || !Number.isFinite(sent) || !Number.isFinite(follow) || follow <= sent) {
    return { ok: false, message: 'Choose a follow-up date and time after the offer was made.' };
  }
  // Historical follow-up can already be overdue; never invent a future appointment.
  return { ok: true, value: { sentAt: new Date(sent).toISOString(), followUpAt: new Date(follow).toISOString() } };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ATTEMPT_OUTCOMES = new Set<AcquisitionAttemptOutcome>(['no_answer', 'reached', 'wrong_number']);

/** Validate the source/kind/outcome matrix before a command reaches Postgres. */
export function acquisitionAttemptInput(
  attemptKind: unknown,
  source: unknown,
  outcome: unknown,
): Validation<{
  attemptKind: AcquisitionAttemptKind;
  source: AcquisitionAttemptSource;
  outcome: AcquisitionAttemptOutcome | null;
}> {
  const validPair =
    (source === 'sandra' || source === 'dialpad') && attemptKind === 'call' ||
    source === 'manual' && attemptKind === 'outreach';
  if (!validPair) return { ok: false, message: 'Choose a valid outreach source and kind.' };
  if (outcome !== null && !ATTEMPT_OUTCOMES.has(outcome as AcquisitionAttemptOutcome)) {
    return { ok: false, message: 'Choose No answer, Reached, or Wrong number.' };
  }
  if (source !== 'sandra' && outcome === null) {
    return { ok: false, message: 'External and manual outreach logs require an outcome.' };
  }
  return {
    ok: true,
    value: {
      attemptKind: attemptKind as AcquisitionAttemptKind,
      source: source as AcquisitionAttemptSource,
      outcome: outcome as AcquisitionAttemptOutcome | null,
    },
  };
}

/** Validate the compare-and-swap envelope shared by property mutations. */
export function acquisitionMutationEnvelope(input: unknown): Validation<AcquisitionMutationEnvelope> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: 'A mutation envelope is required.' };
  }
  const value = input as Record<string, unknown>;
  if (typeof value.propertyId !== 'string' || !UUID.test(value.propertyId)) {
    return { ok: false, message: 'A valid property is required.' };
  }
  if (value.expectedEpisodeId !== null &&
      (typeof value.expectedEpisodeId !== 'string' || !UUID.test(value.expectedEpisodeId))) {
    return { ok: false, message: 'Refresh the lead before trying again.' };
  }
  if (typeof value.expectedQueueVersion !== 'number' ||
      !Number.isSafeInteger(value.expectedQueueVersion) || value.expectedQueueVersion < 0) {
    return { ok: false, message: 'Refresh the lead before trying again.' };
  }
  if (typeof value.idempotencyKey !== 'string' || !UUID.test(value.idempotencyKey)) {
    return { ok: false, message: 'A valid request ID is required.' };
  }
  return {
    ok: true,
    value: {
      propertyId: value.propertyId,
      expectedEpisodeId: value.expectedEpisodeId as string | null,
      expectedQueueVersion: value.expectedQueueVersion,
      idempotencyKey: value.idempotencyKey,
    },
  };
}
