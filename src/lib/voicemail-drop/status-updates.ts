import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizePhone } from "@/lib/csv/normalize";
import { reportError } from "@/lib/errors/report";
import { pauseEnrollment } from "@/lib/sequences/tick";
import type { Database, Json } from "@/lib/supabase/types";

import type {
  VoicemailDropCallbackEvent,
  VoicemailDropReasonClass,
  VoicemailDropStatusEvent,
} from "./types";

/**
 * Status updates for voicemail drops after the 202 (plan "Status updates",
 * RULING RVM-5). Both Drop Cowboy routes call into this module; the store
 * interface keeps the DB side swappable so every rule is unit-testable.
 */

export const DROPCOWBOY_PROVIDER_ID = "dropcowboy";
/** RVM-5: phone fallback only considers drops queued in the last 72h. */
export const PHONE_CORRELATION_WINDOW_MS = 72 * 60 * 60 * 1000;
/** Bad credentials; arrives after the 202 and is a config problem. */
export const BAD_CREDENTIALS_REASON_CODE = 3007;

export const PAUSE_STEP_MISCONFIGURED = "step_misconfigured";
/** Visible consent-class pause (free-text pause_reason, migration 20261008143600). */
export const PAUSE_VOICEMAIL_DROP_CONSENT = "voicemail_drop_consent_blocked";

export type DropRow = {
  id: string;
  enrollment_id: string | null;
  status: string;
  drop_id: string | null;
};

export type DropPatch = Partial<{
  drop_id: string;
  status: "delivered" | "failed";
  reason_code: string | null;
  reason: string | null;
  proof_url: string;
  cost: number;
  provider_payload: Json;
  completed_at: string;
}>;

export interface DropStatusStore {
  findDropById(id: string): Promise<DropRow | null>;
  findDropsByDropId(dropId: string): Promise<DropRow[]>;
  findQueuedDropsByPhone(phone: string, sinceIso: string): Promise<DropRow[]>;
  updateDrop(id: string, patch: DropPatch): Promise<void>;
  pauseEnrollment(enrollmentId: string, reason: string): Promise<void>;
  /** Insert-or-claim the webhook_events row. "skip" = already handled / in flight. */
  reserveEvent(eventType: string, eventId: string, payload: Json): Promise<"reserved" | "skip">;
  finishEvent(eventType: string, eventId: string, outcome: "processed" | "error", message?: string): Promise<void>;
}

export type FailureAction = "pause_misconfigured" | "pause_consent" | "mark_failed" | "mark_failed_and_report";

export function failureActionFor(
  reasonCode: number | null,
  reasonClass: VoicemailDropReasonClass,
): FailureAction {
  if (reasonCode === BAD_CREDENTIALS_REASON_CODE || reasonClass === "config") return "pause_misconfigured";
  if (reasonClass === "consent") return "pause_consent";
  if (reasonClass === "delivery") return "mark_failed";
  return "mark_failed_and_report";
}

type Outcome = {
  status: "success" | "failure";
  reason: string | null;
  reasonCode: number | null;
  reasonClass: VoicemailDropReasonClass;
};

function outcomePatch(o: Outcome, nowIso: string): DropPatch {
  return {
    status: o.status === "success" ? "delivered" : "failed",
    reason_code: o.reasonCode === null ? null : String(o.reasonCode),
    reason: o.reason,
    completed_at: nowIso,
  };
}

async function applyFailure(store: DropStatusStore, drop: DropRow, o: Outcome, surface: string) {
  if (o.status !== "failure") return;
  const action = failureActionFor(o.reasonCode, o.reasonClass);
  if (action === "pause_misconfigured" || action === "pause_consent") {
    if (drop.enrollment_id) {
      await store.pauseEnrollment(
        drop.enrollment_id,
        action === "pause_misconfigured" ? PAUSE_STEP_MISCONFIGURED : PAUSE_VOICEMAIL_DROP_CONSENT,
      );
    }
    return;
  }
  if (action === "mark_failed_and_report") {
    reportError(new Error(`voicemail drop failed with unclassified reason code ${o.reasonCode ?? "none"}`), {
      tags: { surface },
      extra: { dropRowId: drop.id, reasonCode: o.reasonCode, reason: o.reason },
    });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CallbackResult = { status: 200 | 404; body: Record<string, unknown> };

/** Unsigned callback_url payload. Only accepted for a foreign_id we issued. */
export async function handleDropCallback(
  store: DropStatusStore,
  event: VoicemailDropCallbackEvent,
  now: Date = new Date(),
): Promise<CallbackResult> {
  if (!event.foreignId || !UUID.test(event.foreignId)) return { status: 404, body: { error: "unknown_foreign_id" } };
  const drop = await store.findDropById(event.foreignId);
  if (!drop) return { status: 404, body: { error: "unknown_foreign_id" } };

  const patch: DropPatch = { ...outcomePatch(event, now.toISOString()), provider_payload: event.raw as Json };
  if (event.dropId) patch.drop_id = event.dropId;
  if (event.cost !== null) patch.cost = event.cost;
  if (event.proofUrl) patch.proof_url = event.proofUrl;
  await store.updateDrop(drop.id, patch);
  await applyFailure(store, drop, event, "dropcowboy_rvm_callback_unclassified");
  return { status: 200, body: { ok: true } };
}

/** RVM-5 correlation: drop_id first, then a unique recent queued drop to that phone, else none. */
export async function correlateStatusEvent(
  store: DropStatusStore,
  event: VoicemailDropStatusEvent,
  now: Date,
): Promise<DropRow | null> {
  if (event.dropId) {
    const byDropId = await store.findDropsByDropId(event.dropId);
    if (byDropId.length === 1) return byDropId[0];
    if (byDropId.length > 1) return null;
  }
  const phone = normalizePhone(event.to);
  if (!phone) return null;
  const since = new Date(now.getTime() - PHONE_CORRELATION_WINDOW_MS).toISOString();
  const byPhone = await store.findQueuedDropsByPhone(phone, since);
  return byPhone.length === 1 ? byPhone[0] : null;
}

export type StatusWebhookResult = "duplicate" | "unmatched" | "applied";

/** Signed contact.rvm.status / contact.rvm.receipt. Signature is checked by the caller. */
export async function handleDropStatusEvent(
  store: DropStatusStore,
  event: VoicemailDropStatusEvent,
  now: Date = new Date(),
): Promise<StatusWebhookResult> {
  const eventType = event.kind === "receipt" ? "contact.rvm.receipt" : "contact.rvm.status";
  const reservation = await store.reserveEvent(eventType, event.eventId, event.raw as Json);
  if (reservation === "skip") return "duplicate";
  try {
    const drop = await correlateStatusEvent(store, event, now);
    if (!drop) {
      // Stored in webhook_events for a human to look at; never guess a drop.
      await store.finishEvent(eventType, event.eventId, "error", "unmatched voicemail drop");
      return "unmatched";
    }
    const patch: DropPatch = {};
    if (event.dropId && !drop.drop_id) patch.drop_id = event.dropId;
    if (event.kind === "receipt") {
      if (event.proofUrl) patch.proof_url = event.proofUrl;
      if (Object.keys(patch).length > 0) await store.updateDrop(drop.id, patch);
    } else {
      await store.updateDrop(drop.id, { ...patch, ...outcomePatch(event, now.toISOString()) });
      await applyFailure(store, drop, event, "dropcowboy_rvm_webhook_unclassified");
    }
    await store.finishEvent(eventType, event.eventId, "processed");
    return "applied";
  } catch (error) {
    await store.finishEvent(eventType, event.eventId, "error", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

const DROP_COLUMNS = "id, enrollment_id, status, drop_id";
const WEBHOOK_PROCESSING_LEASE_MS = 5 * 60_000;

export function supabaseDropStatusStore(client: SupabaseClient<Database>): DropStatusStore {
  return {
    async findDropById(id) {
      const { data, error } = await client.from("voicemail_drops").select(DROP_COLUMNS).eq("id", id).maybeSingle();
      if (error) throw new Error(`findDropById: ${error.message}`);
      return data;
    },
    async findDropsByDropId(dropId) {
      const { data, error } = await client.from("voicemail_drops").select(DROP_COLUMNS).eq("drop_id", dropId).limit(2);
      if (error) throw new Error(`findDropsByDropId: ${error.message}`);
      return data ?? [];
    },
    async findQueuedDropsByPhone(phone, sinceIso) {
      const { data, error } = await client
        .from("voicemail_drops")
        .select(DROP_COLUMNS)
        .eq("to_phone", phone)
        .eq("status", "queued")
        .gte("queued_at", sinceIso)
        .limit(2);
      if (error) throw new Error(`findQueuedDropsByPhone: ${error.message}`);
      return data ?? [];
    },
    async updateDrop(id, patch) {
      const { error } = await client.from("voicemail_drops").update(patch).eq("id", id);
      if (error) throw new Error(`updateDrop: ${error.message}`);
    },
    async pauseEnrollment(enrollmentId, reason) {
      const error = await pauseEnrollment(client, enrollmentId, reason, false);
      if (error) throw new Error(`pauseEnrollment: ${error}`);
    },
    async reserveEvent(eventType, eventId, payload) {
      const now = new Date().toISOString();
      const key = { provider: DROPCOWBOY_PROVIDER_ID, event_type: eventType, external_id: eventId };
      const { error } = await client.from("webhook_events").insert({
        ...key,
        signature_verified: true,
        processing_status: "processing",
        processing_started_at: now,
        payload,
      });
      if (!error) return "reserved";
      if (error.code !== "23505") throw new Error(`reserveEvent: ${error.message}`);
      const { data: existing, error: readError } = await client
        .from("webhook_events")
        .select("processing_status, processing_started_at")
        .match(key)
        .maybeSingle();
      if (readError) throw new Error(`reserveEvent: ${readError.message}`);
      if (!existing || existing.processing_status === "processed") return "skip";
      const started = existing.processing_started_at ? new Date(existing.processing_started_at).getTime() : 0;
      if (existing.processing_status === "processing" && Date.now() - started <= WEBHOOK_PROCESSING_LEASE_MS) {
        return "skip";
      }
      // Errored or lease-expired: claim it with a compare-and-set on the old state.
      let claim = client
        .from("webhook_events")
        .update({ processing_status: "processing", processing_started_at: now, processed_at: null, error_message: null })
        .match(key)
        .eq("processing_status", existing.processing_status);
      claim = existing.processing_started_at
        ? claim.eq("processing_started_at", existing.processing_started_at)
        : claim.is("processing_started_at", null);
      const { data: claimed, error: claimError } = await claim.select("id").maybeSingle();
      if (claimError) throw new Error(`reserveEvent: ${claimError.message}`);
      return claimed ? "reserved" : "skip";
    },
    async finishEvent(eventType, eventId, outcome, message) {
      const { error } = await client
        .from("webhook_events")
        .update({
          processing_status: outcome,
          processed_at: new Date().toISOString(),
          error_message: outcome === "error" ? (message ?? null) : null,
        })
        .match({ provider: DROPCOWBOY_PROVIDER_ID, event_type: eventType, external_id: eventId });
      if (error) throw new Error(`finishEvent: ${error.message}`);
    },
  };
}
