import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import type { DirectCallStatus } from "./contract";
import { cleanupSpecToJson } from "./serialize";
import type { CleanupSpec, RowPatch, SellerDialState } from "./transitions";

type RawRow = Database["public"]["Tables"]["direct_calls"]["Row"];
export type DirectWatchdogRow = {
  browser_watchdog_session_id: string | null;
  browser_watchdog_seen_at: string | null;
  browser_watchdog_expires_at: string | null;
  browser_watchdog_claimed_at: string | null;
};
export type DirectCallFullRow = Omit<RawRow, "status" | "seller_dial_state"> & DirectWatchdogRow & { status: DirectCallStatus; seller_dial_state: SellerDialState | null };
const typed = (row: RawRow | null): DirectCallFullRow | null => row as DirectCallFullRow | null;
type RawCleanup = Database["public"]["Tables"]["direct_call_cleanups"]["Row"];
export type DirectCallCleanupRow = Omit<RawCleanup, "kind"> & { kind: "leg" | "unresolved_dial" };
export type CleanupUpdate = Partial<Pick<DirectCallCleanupRow, "attempts" | "acked_at" | "next_attempt_at" | "confirmed_at" | "empty_matches" | "last_error">>;
export type DirectCallOperatorRow = Database["public"]["Tables"]["direct_call_operators"]["Row"];

export type NewDirectCall = {
  org_id: string;
  operator_user_id: string;
  property_id: string | null;
  preparation_property_id: string | null;
  contact_id: string | null;
  destination_e164: string;
  caller_id_e164: string;
  time_limit_secs: number;
  client_request_id: string;
  browser_watchdog_session_id?: string;
};

export type BeginOutcome =
  | { outcome: "created"; row: DirectCallFullRow }
  | { outcome: "duplicate_request"; row: DirectCallFullRow }
  | { outcome: "invalid_target" }
  | { outcome: "watchdog_unavailable" }
  | { outcome: "busy_call" | "busy_cleanup" };

export type EventInsertResult = "inserted" | "duplicate_processed" | "duplicate_unprocessed";

/** Persistence boundary for direct calls. All writes use the service-role client. */
export interface DirectCallStore {
  insertEvent(event: {
    provider_event_id: string;
    direct_call_id: string | null;
    event_type: string;
    occurred_at: string | null;
    payload: unknown;
  }): Promise<EventInsertResult>;
  markEventProcessed(providerEventId: string, directCallId: string | null): Promise<void>;
  findByLeg(legId: string): Promise<DirectCallFullRow | null>;
  findById(id: string): Promise<DirectCallFullRow | null>;
  findOwned(id: string, userId: string): Promise<DirectCallFullRow | null>;
  findByRequest(userId: string, clientRequestId: string): Promise<DirectCallFullRow | null>;
  /** The operator's non-terminal call, if any. */
  findActiveForUser(userId: string): Promise<DirectCallFullRow | null>;
  /** Operator busy = a non-terminal call OR any unconfirmed cleanup row (one SQL predicate). */
  operatorBusy(userId: string): Promise<"call" | "cleanup" | null>;
  /** Atomic start (advisory-locked, SQL direct_call_begin): replays a request id, refuses while busy, else inserts. */
  beginCall(call: NewDirectCall): Promise<BeginOutcome>;
  /** Cancel by request id: an existing call is returned, otherwise a terminal tombstone is recorded. */
  cancelRequest(userId: string, orgId: string, clientRequestId: string): Promise<{ outcome: "existing" | "tombstoned"; row: DirectCallFullRow }>;
  /**
   * Compare-and-set on status, plus the cleanup rows the update obliges, in one SQL write.
   * Returns the updated row, or null if the status no longer matched.
   */
  updateIfStatus(id: string, statuses: DirectCallStatus[], patch: RowPatch, cleanups?: CleanupSpec[]): Promise<DirectCallFullRow | null>;
  /** Fills in the prepared target, including a still-owned terminal reservation after delayed preparation. */
  setTarget(id: string, target: { property_id: string | null; contact_id: string | null; destination_e164: string }): Promise<boolean>;
  /** Drops a reservation whose prepare was refused (nothing was dialed). */
  discardReservation(id: string): Promise<void>;
  /** A Dial returned a leg: stores it when free, resolves that Dial's unresolved-dial row, queues a leg row when it must not live. */
  dialSucceeded(id: string, legId: string, role: "browser" | "seller"): Promise<boolean>;
  /** Durably marks the provider-dispatch boundary and anchors cleanup timing to it. */
  markDialStarted(id: string, role: "browser" | "seller", startedAt: string, timeoutSecs: number, timeLimitSecs: number): Promise<boolean>;
  /** Arms the browser-loss lease after preparation, immediately before dispatch. */
  armWatchdog(id: string, operatorUserId: string, sessionId: string): Promise<boolean>;
  /** Provider definitively refused, or dispatch was proven never sent: resolve the obligation. */
  dialRejected(id: string, role: "browser" | "seller"): Promise<void>;
  /** Another non-terminal direct call (any operator) exists for this property. */
  hasActiveCallForProperty(propertyId: string, excludeId: string | null): Promise<boolean>;
  /** Queue a leg for hangup (idempotent per leg id). */
  addLegCleanup(callId: string, legId: string): Promise<void>;
  /** A provider hangup webhook (or equivalent) confirmed this leg ended. */
  confirmLegCleanup(legId: string, at: string): Promise<void>;
  /** Claims up to `limit` due, actionable cleanup rows for the operator (lease pushes next_attempt_at out). unresolved_dial rows come first. */
  claimDueCleanups(userId: string, now: string, leaseSecs: number, limit: number): Promise<DirectCallCleanupRow[]>;
  updateCleanup(id: string, patch: CleanupUpdate): Promise<void>;
  /** Unconfirmed cleanup rows of one call. */
  openCleanupsForCall(callId: string): Promise<DirectCallCleanupRow[]>;
  /**
   * Claims the operator's calls with a pending lead resume (resume_pending set by direct_call_apply),
   * with a short lease so concurrent sessions do not both resume.
   */
  claimPendingResumes(userId: string, now: string, leaseSecs: number): Promise<DirectCallFullRow[]>;
  /** Clears a call's resume obligation. Called only after the resume function returned without throwing. */
  clearResumePending(callId: string): Promise<void>;
  getOperator(userId: string): Promise<DirectCallOperatorRow | null>;
  insertOperator(row: { user_id: string; org_id: string; telnyx_credential_id: string; sip_username: string }): Promise<DirectCallOperatorRow>;
}

const UNIQUE_VIOLATION = "23505";
const DEFINITE_BEGIN_REFUSALS = new Set(["22P02", "23503"]);

function fail(error: { message: string } | null): never {
  throw new Error(error?.message ?? "Direct call database error.");
}

export function createSupabaseDirectCallStore(admin = createAdminClient()): DirectCallStore {
  const calls = () => admin.from("direct_calls");
  // Generated Supabase types intentionally lag unapplied additive migrations. Keep the new
  // watchdog RPC names behind this narrow typed boundary until the schema types are regenerated.
  const watchdogRpc = admin.rpc.bind(admin) as unknown as (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
  return {
    async insertEvent(event) {
      const { error } = await admin.from("direct_call_events").insert({
        provider_event_id: event.provider_event_id,
        direct_call_id: event.direct_call_id,
        event_type: event.event_type,
        occurred_at: event.occurred_at,
        payload: event.payload as never,
      });
      if (!error) return "inserted";
      if (error.code !== UNIQUE_VIOLATION) fail(error);
      const { data, error: readError } = await admin
        .from("direct_call_events")
        .select("processed_at")
        .eq("provider_event_id", event.provider_event_id)
        .maybeSingle();
      if (readError) fail(readError);
      return data?.processed_at ? "duplicate_processed" : "duplicate_unprocessed";
    },
    async markEventProcessed(providerEventId, directCallId) {
      const { error } = await admin
        .from("direct_call_events")
        .update({ processed_at: new Date().toISOString(), ...(directCallId ? { direct_call_id: directCallId } : {}) })
        .eq("provider_event_id", providerEventId);
      if (error) fail(error);
    },
    async findByLeg(legId) {
      for (const column of ["browser_leg_id", "seller_leg_id"] as const) {
        const { data, error } = await calls().select("*").eq(column, legId).maybeSingle();
        if (error) fail(error);
        if (data) return typed(data);
      }
      return null;
    },
    async findById(id) {
      const { data, error } = await calls().select("*").eq("id", id).maybeSingle();
      if (error) fail(error);
      return typed(data);
    },
    async findOwned(id, userId) {
      const { data, error } = await calls().select("*").eq("id", id).eq("operator_user_id", userId).maybeSingle();
      if (error) fail(error);
      return typed(data);
    },
    async findByRequest(userId, clientRequestId) {
      const { data, error } = await calls()
        .select("*")
        .eq("operator_user_id", userId)
        .eq("client_request_id", clientRequestId)
        .maybeSingle();
      if (error) fail(error);
      return typed(data);
    },
    async findActiveForUser(userId) {
      const { data, error } = await admin.rpc("direct_call_active_for_operator", { p_user: userId });
      if (error) fail(error);
      return typed((data as RawRow[] | null)?.[0] ?? null);
    },
    async operatorBusy(userId) {
      const { data, error } = await admin.rpc("direct_call_operator_busy", { p_user: userId });
      if (error) fail(error);
      return data === "call" || data === "cleanup" ? data : null;
    },
    async beginCall(call) {
      // The service always supplies a session nonce and therefore always uses the watchdog-era
      // signature. The old call is retained only for historical loopback migration tests that
      // intentionally exercise the pre-watchdog schema; no production caller omits the nonce.
      const args = {
        p_org: call.org_id,
        p_operator: call.operator_user_id,
        p_property: call.property_id,
        p_contact: call.contact_id,
        p_destination: call.destination_e164,
        p_caller: call.caller_id_e164,
        p_request: call.client_request_id,
        p_time_limit_secs: call.time_limit_secs,
        p_preparation_property: call.preparation_property_id,
      };
      const response = call.browser_watchdog_session_id
        ? await watchdogRpc("direct_call_begin", { ...args, p_watchdog_session: call.browser_watchdog_session_id })
        : await admin.rpc("direct_call_begin", args);
      const { data, error } = response as { data: unknown; error: { message: string; code?: string } | null };
      if (error) {
        // A uniqueness violation here means a concurrent writer beat the advisory lock's snapshot.
        if (error.code === UNIQUE_VIOLATION) return { outcome: "busy_call" };
        // The preparation owner is a UUID with a property FK. These errors prove that the request
        // was rejected before the reservation insert; ambiguous/database transport failures remain
        // thrown so callers keep reserved:true and reconcile by request id.
        if (call.preparation_property_id !== null && DEFINITE_BEGIN_REFUSALS.has(error.code ?? "")) return { outcome: "invalid_target" };
        fail(error);
      }
      const result = (data as Array<{ outcome: string; call_id: string | null }> | null)?.[0];
      if (!result) fail(null);
      if (result.outcome === "busy_call" || result.outcome === "busy_cleanup" || result.outcome === "watchdog_unavailable") return { outcome: result.outcome };
      const { data: row, error: readError } = await calls().select("*").eq("id", result.call_id!).single();
      if (readError) fail(readError);
      return { outcome: result.outcome === "created" ? "created" : "duplicate_request", row: typed(row)! };
    },
    async cancelRequest(userId, orgId, clientRequestId) {
      const { data, error } = await admin.rpc("direct_call_cancel_request", { p_org: orgId, p_operator: userId, p_request: clientRequestId });
      if (error) fail(error);
      const result = (data as Array<{ outcome: string; call_id: string }> | null)?.[0];
      if (!result) fail(null);
      const { data: row, error: readError } = await calls().select("*").eq("id", result.call_id).single();
      if (readError) fail(readError);
      return { outcome: result.outcome === "existing" ? "existing" : "tombstoned", row: typed(row)! };
    },
    async updateIfStatus(id, statuses, patch, cleanups = []) {
      const { data, error } = await admin.rpc("direct_call_apply", {
        p_id: id,
        p_statuses: statuses,
        p_patch: patch as never,
        p_cleanups: cleanups.map(cleanupSpecToJson) as never,
      });
      if (error) {
        if (error.code === UNIQUE_VIOLATION) return null; // a leg id already belongs to another call
        fail(error);
      }
      return typed((data as RawRow[] | null)?.[0] ?? null);
    },
    async setTarget(id, target) {
      const { data, error } = await admin.rpc("direct_call_set_target", {
        p_id: id,
        p_property: target.property_id,
        p_contact: target.contact_id,
        p_destination: target.destination_e164,
      });
      if (error) fail(error);
      return data === true;
    },
    async discardReservation(id) {
      const { error } = await admin.rpc("direct_call_discard_reservation", { p_id: id });
      if (error) fail(error);
    },
    async dialSucceeded(id, legId, role) {
      const { data, error } = await admin.rpc("direct_call_dial_succeeded", { p_id: id, p_leg: legId, p_role: role });
      if (error) fail(error);
      return data === true;
    },
    async markDialStarted(id, role, startedAt, timeoutSecs, timeLimitSecs) {
      const { data, error } = await admin.rpc("direct_call_dial_started", {
        p_id: id,
        p_role: role,
        p_started_at: startedAt,
        p_timeout_secs: timeoutSecs,
        p_time_limit_secs: timeLimitSecs,
      });
      if (error) fail(error);
      return data === true;
    },
    async armWatchdog(id, operatorUserId, sessionId) {
      const { data, error } = await watchdogRpc("direct_call_watchdog_arm", { p_id: id, p_operator: operatorUserId, p_session: sessionId });
      if (error) fail(error);
      return data === true;
    },
    async dialRejected(id, role) {
      const { error } = await admin.rpc("direct_call_dial_rejected", { p_id: id, p_role: role });
      if (error) fail(error);
    },
    async hasActiveCallForProperty(propertyId, excludeId) {
      let query = calls()
        .select("id, property_id, preparation_property_id")
        .not("status", "in", "(ended,failed)")
        .or(`property_id.eq.${propertyId},preparation_property_id.eq.${propertyId}`)
        .limit(1);
      if (excludeId) query = query.neq("id", excludeId);
      const { data, error } = await query;
      if (error) fail(error);
      return (data?.length ?? 0) > 0;
    },
    async addLegCleanup(callId, legId) {
      const { error } = await admin.rpc("direct_call_cleanup_add_leg", { p_id: callId, p_leg: legId });
      if (error) fail(error);
    },
    async confirmLegCleanup(legId, at) {
      const { error } = await admin.from("direct_call_cleanups").update({ confirmed_at: at }).eq("leg_id", legId).is("confirmed_at", null);
      if (error) fail(error);
    },
    async claimDueCleanups(userId, now, leaseSecs, limit) {
      const { data, error } = await admin.rpc("direct_call_cleanup_claim", { p_user: userId, p_now: now, p_lease_secs: leaseSecs, p_limit: limit });
      if (error) fail(error);
      return (data ?? []) as DirectCallCleanupRow[];
    },
    async updateCleanup(id, patch) {
      const { error } = await admin.from("direct_call_cleanups").update(patch).eq("id", id);
      if (error) fail(error);
    },
    async openCleanupsForCall(callId) {
      const { data, error } = await admin.from("direct_call_cleanups").select("*").eq("direct_call_id", callId).is("confirmed_at", null);
      if (error) fail(error);
      return (data ?? []) as DirectCallCleanupRow[];
    },
    async claimPendingResumes(userId, now, leaseSecs) {
      const { data, error } = await admin.rpc("direct_call_resume_claim", { p_user: userId, p_now: now, p_lease_secs: leaseSecs });
      if (error) fail(error);
      return ((data ?? []) as RawRow[]).map((row) => typed(row)!);
    },
    async clearResumePending(callId) {
      const { error } = await admin.rpc("direct_call_resume_done", { p_id: callId });
      if (error) fail(error);
    },
    async getOperator(userId) {
      const { data, error } = await admin.from("direct_call_operators").select("*").eq("user_id", userId).maybeSingle();
      if (error) fail(error);
      return data;
    },
    async insertOperator(row) {
      const { data, error } = await admin
        .from("direct_call_operators")
        .upsert(row, { onConflict: "user_id", ignoreDuplicates: true })
        .select("*");
      if (error) fail(error);
      if (data && data.length) return data[0];
      const existing = await this.getOperator(row.user_id);
      if (!existing) fail(null);
      return existing;
    },
  };
}
