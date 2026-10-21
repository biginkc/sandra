import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizePhone } from "@/lib/csv/normalize";
import { reportError } from "@/lib/errors/report";
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
  step_run_id: string;
  status: string;
  attempt_outcome: string;
  drop_id: string | null;
};

/** recovery_action on a step run whose unknown POST was proven queued by Drop Cowboy. */
export const RECOVERY_VOICEMAIL_DROP_RECONCILED = "voicemail_drop_reconciled";

/** Input to resolve_voicemail_drop_outcome (20261021140000). */
export type ResolveOutcomeInput = {
  dropRowId: string;
  status: "delivered" | "failed";
  /** null | voicemail_drop_consent_blocked | step_misconfigured (failureActionFor). */
  pauseReason: string | null;
  reasonCode: string | null;
  reason: string | null;
  dropId: string | null;
  cost: number | null;
  proofUrl: string | null;
  payload: Json | null;
};

/**
 * applied = queued → terminal; replay = already that terminal state;
 * conflict = already the other terminal state (facts only); not_found.
 */
export type ResolveOutcomeResult = {
  dropResult: "applied" | "replay" | "conflict" | "not_found";
  /** advanced | completed | advanced_paused | paused | none */
  enrollmentAction: string;
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
  /** With `dropId`, drops already holding a different drop_id are excluded. */
  findQueuedDropsByPhone(phone: string, sinceIso: string, dropId?: string | null): Promise<DropRow[]>;
  /**
   * Patch a drop. With `onlyIfStatusIn`, the write is a compare-and-set on the
   * drop's current status; returns false when nothing matched.
   */
  updateDrop(id: string, patch: DropPatch, onlyIfStatusIn?: string[]): Promise<boolean>;
  /**
   * Apply a terminal outcome in one DB transaction
   * (resolve_voicemail_drop_outcome): the owner of the run's unknown →
   * accepted flip advances the enrollment, a required pause lands in the same
   * write (never an intermediate active state), and a failure commits
   * nothing, so the webhook retry redoes all of it.
   */
  resolveOutcome(input: ResolveOutcomeInput): Promise<ResolveOutcomeResult>;
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
  // Frequency (4013 Too Many Attempts) is handled like delivery: no pause.
  if (reasonClass === "delivery" || reasonClass === "frequency") return "mark_failed";
  return "mark_failed_and_report";
}

type Outcome = {
  status: "success" | "failure";
  reason: string | null;
  reasonCode: number | null;
  reasonClass: VoicemailDropReasonClass;
};

function pauseReasonFor(o: Outcome): string | null {
  if (o.status !== "failure") return null;
  const action = failureActionFor(o.reasonCode, o.reasonClass);
  if (action === "pause_misconfigured") return PAUSE_STEP_MISCONFIGURED;
  if (action === "pause_consent") return PAUSE_VOICEMAIL_DROP_CONSENT;
  return null;
}

function reportUnclassified(drop: DropRow, o: Outcome, surface: string) {
  if (o.status !== "failure" || failureActionFor(o.reasonCode, o.reasonClass) !== "mark_failed_and_report") return;
  reportError(new Error(`voicemail drop failed with unclassified reason code ${o.reasonCode ?? "none"}`), {
    tags: { surface },
    extra: { dropRowId: drop.id, reasonCode: o.reasonCode, reason: o.reason },
  });
}

/**
 * Apply a terminal outcome through the store's single-transaction resolver.
 * A late or replayed event never flips delivered ↔ failed; a required pause
 * is never lost behind an already-terminal drop because the drop write and
 * the pause commit together.
 */
async function applyTerminalOutcome(
  store: DropStatusStore,
  drop: DropRow,
  o: Outcome,
  facts: { dropId: string | null; cost: number | null; proofUrl: string | null; payload: Json | null },
  surface: string,
): Promise<ResolveOutcomeResult> {
  const result = await store.resolveOutcome({
    dropRowId: drop.id,
    status: o.status === "success" ? "delivered" : "failed",
    pauseReason: pauseReasonFor(o),
    reasonCode: o.reasonCode === null ? null : String(o.reasonCode),
    reason: o.reason,
    ...facts,
  });
  if (result.dropResult === "applied") reportUnclassified(drop, o, surface);
  return result;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CallbackResult = { status: 200 | 404; body: Record<string, unknown> };

/** Unsigned callback_url payload. Only accepted for a foreign_id we issued. */
export async function handleDropCallback(
  store: DropStatusStore,
  event: VoicemailDropCallbackEvent,
): Promise<CallbackResult> {
  if (!event.foreignId || !UUID.test(event.foreignId)) return { status: 404, body: { error: "unknown_foreign_id" } };
  const drop = await store.findDropById(event.foreignId);
  if (!drop) return { status: 404, body: { error: "unknown_foreign_id" } };

  await applyTerminalOutcome(
    store,
    drop,
    event,
    { dropId: event.dropId ?? null, cost: event.cost, proofUrl: event.proofUrl ?? null, payload: event.raw as Json },
    "dropcowboy_rvm_callback_unclassified",
  );
  return { status: 200, body: { ok: true } };
}

/** Drop Cowboy reports RVM, voice broadcast and AI broadcast outcomes on contact.rvm.status; campaign_type tells them apart. */
export const RVM_CAMPAIGN_TYPE = "rvm";

/**
 * RVM-5 correlation. Events for another channel (campaign_type voice / AI
 * broadcast) are never correlated, whatever their kind. Receipts match by
 * drop_id only, never by phone. Status events try drop_id first, then a
 * unique recent queued drop to that phone, only with campaign_type 'rvm', and
 * never a drop whose stored drop_id differs from the event's.
 */
export async function correlateStatusEvent(
  store: DropStatusStore,
  event: VoicemailDropStatusEvent,
  now: Date,
): Promise<DropRow | null> {
  if (event.campaignType !== null && event.campaignType !== RVM_CAMPAIGN_TYPE) return null;
  if (event.dropId) {
    const byDropId = await store.findDropsByDropId(event.dropId);
    if (byDropId.length === 1) return byDropId[0];
    if (byDropId.length > 1) return null;
  }
  if (event.kind !== "status" || event.campaignType !== RVM_CAMPAIGN_TYPE) return null;
  const phone = normalizePhone(event.to);
  if (!phone) return null;
  const since = new Date(now.getTime() - PHONE_CORRELATION_WINDOW_MS).toISOString();
  const byPhone = (await store.findQueuedDropsByPhone(phone, since, event.dropId)).filter(
    (d) => !d.drop_id || !event.dropId || d.drop_id === event.dropId,
  );
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
    if (event.kind === "receipt") {
      // A receipt only carries proof; it never changes the outcome.
      if (event.proofUrl) await store.updateDrop(drop.id, { proof_url: event.proofUrl });
    } else {
      await applyTerminalOutcome(
        store,
        drop,
        event,
        { dropId: event.dropId ?? null, cost: null, proofUrl: null, payload: null },
        "dropcowboy_rvm_webhook_unclassified",
      );
    }
    await store.finishEvent(eventType, event.eventId, "processed");
    return "applied";
  } catch (error) {
    await store.finishEvent(eventType, event.eventId, "error", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

const DROP_COLUMNS = "id, enrollment_id, step_run_id, status, attempt_outcome, drop_id";
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
    async findQueuedDropsByPhone(phone, sinceIso, dropId) {
      let query = client
        .from("voicemail_drops")
        .select(DROP_COLUMNS)
        .eq("to_phone", phone)
        .eq("status", "queued")
        // A drop held at attempt_outcome 'unknown' has no queued_at yet; its
        // window starts at created_at so a status event can still reconcile it.
        .or(`queued_at.gte.${sinceIso},and(queued_at.is.null,created_at.gte.${sinceIso})`);
      // Never a drop that already holds a different drop_id.
      if (dropId) query = query.or(`drop_id.is.null,drop_id.eq."${dropId.replace(/["\\,()]/g, "")}"`);
      const { data, error } = await query.limit(2);
      if (error) throw new Error(`findQueuedDropsByPhone: ${error.message}`);
      return data ?? [];
    },
    async updateDrop(id, patch, onlyIfStatusIn) {
      let query = client.from("voicemail_drops").update(patch).eq("id", id);
      if (onlyIfStatusIn) query = query.in("status", onlyIfStatusIn);
      const { data, error } = await query.select("id");
      if (error) throw new Error(`updateDrop: ${error.message}`);
      return (data ?? []).length > 0;
    },
    async resolveOutcome(input) {
      const { data, error } = await (
        client.rpc as unknown as (
          fn: string,
          args: Record<string, unknown>,
        ) => Promise<{ data: Array<{ drop_result: string; enrollment_action: string }> | null; error: { message: string } | null }>
      )("resolve_voicemail_drop_outcome", {
        p_drop_row_id: input.dropRowId,
        p_status: input.status,
        p_pause_reason: input.pauseReason,
        p_reason_code: input.reasonCode,
        p_reason: input.reason,
        p_drop_id: input.dropId,
        p_cost: input.cost,
        p_proof_url: input.proofUrl,
        p_payload: input.payload,
      });
      if (error) throw new Error(`resolveOutcome: ${error.message}`);
      const row = data?.[0];
      if (!row) throw new Error("resolveOutcome: no result row");
      return { dropResult: row.drop_result as ResolveOutcomeResult["dropResult"], enrollmentAction: row.enrollment_action };
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
