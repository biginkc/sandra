import type { SupabaseClient } from '@supabase/supabase-js';

import { reportError } from '@/lib/errors/report';
import type { Database, Json } from '@/lib/supabase/types';

import {
  classifyDialpadRpcError,
  parseDialpadEventIngestResult,
  parseDialpadEventProcessResult,
  type DialpadEventProcessResult,
  type DialpadRpcFailure,
} from './contracts';
import { DIALPAD_WEBHOOK_MAX_BYTES, verifyDialpadWebhookJwt } from './webhook-jwt';
import { resolveDialpadWebhookSecrets, type DialpadWebhookSecretEnv } from './webhook-secret';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DialpadConnectionRecord {
  id: string;
  orgId: string;
  status: string;
  webhookSecretRef: string;
  webhookSecretVersion: number;
}

export class DialpadDbError extends Error {
  constructor(readonly failure: DialpadRpcFailure, readonly sqlstate: string | null) {
    super(`dialpad cti database call failed (${sqlstate ?? 'no sqlstate'})`);
    this.name = 'DialpadDbError';
  }
}

/** The database surface the receiver needs; production wraps the service-role client. */
export interface DialpadCtiDb {
  loadConnection(connectionId: string): Promise<DialpadConnectionRecord | null>;
  ingest(orgId: string, connectionId: string, secretVersion: number, payloadText: string): Promise<Json>;
  process(eventId: string): Promise<Json>;
  recordProcessFailure(eventId: string, sqlstate: string): Promise<void>;
  listPending(limit: number): Promise<string[]>;
}

type DbError = { code?: string | null; details?: string | null; message?: string } | null;

function unwrap<T>(result: { data: T; error: DbError }): T {
  if (result.error) throw new DialpadDbError(classifyDialpadRpcError(result.error), result.error.code ?? null);
  return result.data;
}

export function createSupabaseDialpadCtiDb(client: SupabaseClient<Database>): DialpadCtiDb {
  return {
    async loadConnection(connectionId) {
      const { data, error } = await client
        .from('dialpad_org_connections')
        .select('id, org_id, status, webhook_secret_ref, webhook_secret_version')
        .eq('id', connectionId)
        .maybeSingle();
      if (error) throw new DialpadDbError(classifyDialpadRpcError(error), error.code ?? null);
      if (!data) return null;
      return {
        id: data.id,
        orgId: data.org_id,
        status: data.status,
        webhookSecretRef: data.webhook_secret_ref,
        webhookSecretVersion: data.webhook_secret_version,
      };
    },
    async ingest(orgId, connectionId, secretVersion, payloadText) {
      return unwrap(await client.rpc('fn_ingest_dialpad_call_event', {
        p_org_id: orgId,
        p_connection_id: connectionId,
        p_secret_version: secretVersion,
        p_payload: payloadText,
      }));
    },
    async process(eventId) {
      return unwrap(await client.rpc('fn_process_dialpad_call_event', { p_event_id: eventId }));
    },
    async recordProcessFailure(eventId, sqlstate) {
      unwrap(await client.rpc('fn_record_dialpad_event_process_failure', { p_event_id: eventId, p_sqlstate: sqlstate }));
    },
    async listPending(limit) {
      return unwrap(await client.rpc('fn_list_dialpad_call_events_for_processing', { p_limit: limit })) ?? [];
    },
  };
}

/**
 * Runs the projection for one persisted event. A failure is recorded on the
 * event (SQLSTATE only, never the payload) so the sweep can retry it up to the
 * database-enforced attempt cap; the error is rethrown to the caller.
 */
export async function processDialpadCallEvent(db: DialpadCtiDb, eventId: string): Promise<DialpadEventProcessResult> {
  try {
    return parseDialpadEventProcessResult(await db.process(eventId));
  } catch (error) {
    const sqlstate = error instanceof DialpadDbError ? (error.sqlstate ?? 'unknown') : 'unknown';
    try {
      await db.recordProcessFailure(eventId, sqlstate);
    } catch (recordError) {
      reportError(recordError, { tags: { surface: 'dialpad_cti_event_process_failure_record' } });
    }
    throw error;
  }
}

export interface DialpadEventSweepSummary {
  candidates: number;
  processed: number;
  failed: number;
}

/** Retries events that were persisted but not yet projected (the established cron mechanism drives this). */
export async function sweepDialpadCallEvents(db: DialpadCtiDb, limit = 50): Promise<DialpadEventSweepSummary> {
  const pending = await db.listPending(limit);
  let processed = 0;
  let failed = 0;
  for (const eventId of pending) {
    try {
      await processDialpadCallEvent(db, eventId);
      processed += 1;
    } catch (error) {
      failed += 1;
      reportError(error, { tags: { surface: 'dialpad_cti_event_sweep' } });
    }
  }
  return { candidates: pending.length, processed, failed };
}

export interface DialpadWebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

const UNAUTHORIZED: DialpadWebhookResponse = { status: 401, body: { error: 'unauthorized' } };

/**
 * Verified lifecycle receiver. Order matters:
 *  1. Reject oversize bodies, unknown/inactive connections and every unsigned or
 *     badly signed body with the same 401, so nothing reveals which part failed.
 *  2. Persist the verified event. Only a persisted event is acknowledged with 2xx;
 *     a storage failure is a 503 so Dialpad retries.
 *  3. Project inline as best effort. A projection failure never turns a persisted
 *     event into a non-2xx (the sweep replays it), which avoids duplicate
 *     deliveries for an event we already hold.
 */
export async function handleDialpadVoiceWebhook(input: {
  connectionId: string;
  rawBody: string;
  db: DialpadCtiDb;
  env: DialpadWebhookSecretEnv;
}): Promise<DialpadWebhookResponse> {
  const { connectionId, rawBody, db, env } = input;
  if (rawBody.length > DIALPAD_WEBHOOK_MAX_BYTES) return { status: 413, body: { error: 'payload_too_large' } };
  if (!UUID.test(connectionId)) return UNAUTHORIZED;

  let connection: DialpadConnectionRecord | null;
  try {
    connection = await db.loadConnection(connectionId.toLowerCase());
  } catch (error) {
    reportError(error, { tags: { surface: 'dialpad_cti_webhook_connection_lookup' } });
    return { status: 503, body: { error: 'unavailable' } };
  }
  if (!connection || connection.status !== 'active') return UNAUTHORIZED;

  const candidates = resolveDialpadWebhookSecrets(connection.webhookSecretRef, connection.webhookSecretVersion, env);
  if (candidates.length === 0) {
    reportError(new Error('Dialpad CTI webhook secret is not configured for an active connection.'), {
      tags: { surface: 'dialpad_cti_webhook_secret_unresolved' },
    });
    return { status: 503, body: { error: 'unavailable' } };
  }

  const verified = verifyDialpadWebhookJwt(rawBody, candidates.map((candidate) => candidate.secret));
  if (!verified.ok) return verified.reason === 'too_large' ? { status: 413, body: { error: 'payload_too_large' } } : UNAUTHORIZED;
  const secretVersion = candidates[verified.secretIndex]!.version;

  let eventId: string;
  let disposition: string;
  try {
    const ingested = parseDialpadEventIngestResult(
      await db.ingest(connection.orgId, connection.id, secretVersion, verified.payloadText),
    );
    eventId = ingested.eventId;
    disposition = ingested.disposition;
  } catch (error) {
    if (error instanceof DialpadDbError) {
      const { failure } = error;
      if (failure.kind === 'forbidden') return UNAUTHORIZED;
      if (failure.kind === 'invalid_input') {
        // Signed but not a call event (no call_id/state/timestamp): nothing to retry.
        if (failure.detail === 'missing_event_identity') return { status: 200, body: { ok: true, ignored: true } };
        return { status: 422, body: { error: 'invalid_event' } };
      }
    }
    reportError(error, { tags: { surface: 'dialpad_cti_webhook_persist' } });
    return { status: 503, body: { error: 'unavailable' } };
  }

  if (disposition === 'conflict') return { status: 200, body: { ok: true, eventId, disposition } };
  try {
    const result = await processDialpadCallEvent(db, eventId);
    return { status: 200, body: { ok: true, eventId, disposition: result.disposition } };
  } catch (error) {
    reportError(error, { tags: { surface: 'dialpad_cti_webhook_project' } });
    return { status: 200, body: { ok: true, eventId, disposition, pendingProjection: true } };
  }
}
