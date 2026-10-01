import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import type { DirectCallStatus } from "./contract";
import type { RowPatch, SellerDialState } from "./transitions";

type RawRow = Database["public"]["Tables"]["direct_calls"]["Row"];
export type DirectCallFullRow = Omit<RawRow, "status" | "seller_dial_state"> & { status: DirectCallStatus; seller_dial_state: SellerDialState | null };
const typed = (row: RawRow | null): DirectCallFullRow | null => row as DirectCallFullRow | null;
export type DirectCallOperatorRow = Database["public"]["Tables"]["direct_call_operators"]["Row"];

export type NewDirectCall = {
  org_id: string;
  operator_user_id: string;
  property_id: string | null;
  contact_id: string | null;
  destination_e164: string;
  caller_id_e164: string;
  client_request_id: string;
};

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
  findActiveForUser(userId: string): Promise<DirectCallFullRow | null>;
  /** Returns "conflict" when the one-active-call index or request-id uniqueness rejects it. */
  insertCall(call: NewDirectCall): Promise<{ row: DirectCallFullRow } | "conflict">;
  /** Compare-and-set on status. Returns the updated row, or null if the status no longer matched. */
  updateIfStatus(id: string, statuses: DirectCallStatus[], patch: RowPatch): Promise<DirectCallFullRow | null>;
  setBrowserLeg(id: string, legId: string): Promise<void>;
  /** Stores the seller leg id and marks the Dial as sent. False when a seller leg id is already stored. */
  setSellerLegIfNull(id: string, legId: string): Promise<boolean>;
  /** pending -> sent only; never overwrites unknown. */
  markSellerDialSent(id: string): Promise<void>;
  /**
   * Unconditional (any status): set/clear the pending-teardown flag for one leg. Clears the ack.
   * Throws DirectCallLockConflictError when setting it would collide with the operator's other live call.
   */
  setLegCleanup(id: string, role: "browser" | "seller", pending: boolean): Promise<void>;
  /** Provider accepted (2xx) the hangup for this leg at `at`; the leg is still pending until confirmed. */
  markLegHangupAcked(id: string, role: "browser" | "seller", at: string): Promise<void>;
  /** Atomically add/remove an orphan leg id (a dialed leg that must be hung up until confirmed). */
  addOrphanLeg(id: string, legId: string): Promise<void>;
  removeOrphanLeg(id: string, legId: string): Promise<void>;
  getOperator(userId: string): Promise<DirectCallOperatorRow | null>;
  insertOperator(row: { user_id: string; org_id: string; telnyx_credential_id: string; sip_username: string }): Promise<DirectCallOperatorRow>;
}

const UNIQUE_VIOLATION = "23505";

/**
 * The one-live-call-per-operator lock now also covers pending leg/orphan teardown, so flagging a
 * lingering leg on an already-terminal row can collide with the operator's newer call. The caller
 * must then hang that leg up directly instead of losing the flag.
 */
export class DirectCallLockConflictError extends Error {
  constructor() {
    super("Operator already holds a live direct call; the cleanup flag could not be persisted.");
    this.name = "DirectCallLockConflictError";
  }
}

function fail(error: { message: string } | null): never {
  throw new Error(error?.message ?? "Direct call database error.");
}

export function createSupabaseDirectCallStore(admin = createAdminClient()): DirectCallStore {
  const calls = () => admin.from("direct_calls");
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
    async insertCall(call) {
      const { data, error } = await calls().insert({ ...call, status: "browser_connecting" }).select("*").single();
      if (error) {
        if (error.code === UNIQUE_VIOLATION) return "conflict";
        fail(error);
      }
      return { row: typed(data)! };
    },
    async updateIfStatus(id, statuses, patch) {
      const { data, error } = await calls()
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", id)
        .in("status", statuses)
        .select("*")
        .maybeSingle();
      if (error) {
        if (error.code === UNIQUE_VIOLATION) {
          // Setting a cleanup flag on a terminal row can collide with the operator's newer call.
          if (patch.browser_hangup_pending || patch.seller_hangup_pending) throw new DirectCallLockConflictError();
          return null;
        }
        fail(error);
      }
      return typed(data);
    },
    async setBrowserLeg(id, legId) {
      const { error } = await calls().update({ browser_leg_id: legId, updated_at: new Date().toISOString() }).eq("id", id).is("browser_leg_id", null);
      if (error && error.code !== UNIQUE_VIOLATION) fail(error);
    },
    async setSellerLegIfNull(id, legId) {
      const { data, error } = await calls()
        .update({ seller_leg_id: legId, seller_dial_state: "sent", updated_at: new Date().toISOString() })
        .eq("id", id)
        .is("seller_leg_id", null)
        .select("id");
      if (error) {
        if (error.code === UNIQUE_VIOLATION) return false;
        fail(error);
      }
      return (data?.length ?? 0) > 0;
    },
    async markSellerDialSent(id) {
      const { error } = await calls()
        .update({ seller_dial_state: "sent", updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("seller_dial_state", "pending");
      if (error) fail(error);
    },
    async setLegCleanup(id, role, pending) {
      const { error } = await calls()
        .update({
          ...(role === "browser"
            ? { browser_hangup_pending: pending, ...(pending ? {} : { browser_hangup_acked_at: null }) }
            : { seller_hangup_pending: pending, ...(pending ? {} : { seller_hangup_acked_at: null }) }),
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error) {
        if (error.code === UNIQUE_VIOLATION) throw new DirectCallLockConflictError();
        fail(error);
      }
    },
    async markLegHangupAcked(id, role, at) {
      // updated_at is deliberately untouched: the stale-ending timer must not be reset by re-checks.
      const { error } = await calls()
        .update(role === "browser" ? { browser_hangup_acked_at: at } : { seller_hangup_acked_at: at })
        .eq("id", id);
      if (error) fail(error);
    },
    async addOrphanLeg(id, legId) {
      const { error } = await admin.rpc("direct_call_orphan_add", { p_id: id, p_leg: legId });
      if (error) {
        if (error.code === UNIQUE_VIOLATION) throw new DirectCallLockConflictError();
        fail(error);
      }
    },
    async removeOrphanLeg(id, legId) {
      const { error } = await admin.rpc("direct_call_orphan_remove", { p_id: id, p_leg: legId });
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
