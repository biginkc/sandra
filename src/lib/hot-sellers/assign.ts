import type { SupabaseClient } from "@supabase/supabase-js";

import { hasActiveSandraAccess } from "@/lib/auth/access-state";
import { validateActiveAssigneeForProperties } from "@/app/(dashboard)/leads/assignment-safety";
import { LEAD_EVENT_TYPES, recordLeadEvent } from "@/lib/events";
import { isHotReason } from "@/lib/hot-sellers/hot";
import type { Database, Json } from "@/lib/supabase/types";

/**
 * Hand a hot seller to Jarrad on My Leads (Messages v2 redesign, PR 2).
 *
 * Same mechanism as a person assigning a lead (leads/actions.ts
 * updateLeadAssignee, which needs a user session and is CI-frozen, so its
 * steps are reproduced here, not refactored): validateActiveAssigneeForProperties,
 * the same guarded update of properties.assigned_user_id (the column My Leads
 * reads; trg_my_leads_property_assignment opens the My Leads episode), then
 * the 'assigned' event through the shared recordLeadEvent writer. No
 * hand-inserted episodes or events. A fresh assignment gets My Leads' normal
 * first-call deadline.
 *
 * Idempotent per inbound text: the event carries source identity
 * (`hot_seller_handoff`, inbound message id), which the ledger's unique index
 * allows once; it is written ONLY when this run's guarded update made the
 * assignment (the update returning the row is the proof). A lead already
 * owned by SOMEONE ELSE is never taken from them.
 */
export const HOT_HANDOFF_SOURCE_TYPE = "hot_seller_handoff";
/**
 * A hot text on a lead Jarrad already owns: no reassignment and no 'assigned'
 * event, but one alert per hot decision. Recorded as an `ai_escalated` lead
 * event with source identity (hot_seller_text, inbound message id), which the
 * ledger allows once per inbound.
 */
export const HOT_TEXT_SOURCE_TYPE = "hot_seller_text";


export type HotAssignResult =
  | { status: "assigned" | "already_assigned"; assigneeUserId: string }
  /** Jarrad already owned the lead (a person assigned it): no reassignment, one "hot text on your lead" alert. */
  | { status: "already_owned"; assigneeUserId: string }
  /** The lead IS on My Leads under Jarrad, but the 'assigned' event could not be saved. */
  | { status: "assigned_unrecorded"; assigneeUserId: string; detail: string }
  /** A rep already owns the lead: left with them, no hold, no alert to Jarrad. */
  | { status: "owned_by_someone_else"; ownerUserId: string }
  | { status: "failed"; reason: "no_hot_owner" | "not_found" | "dnc_locked" | "db_error"; detail?: string };

type MembershipRow = {
  user_id: string;
  role: string;
  access_status: string | null;
  access_expires_at: string | null;
  deletion_prepared_at: string | null;
};

/**
 * Jarrad = the org's ONE active owner. `HOT_LEAD_ASSIGNEE_USER_ID` may name him
 * explicitly, and must then be that active owner. Zero or several owners with
 * no explicit pick → null (fail closed; the hold stays).
 */
export async function resolveHotOwner(
  db: SupabaseClient<Database>,
  orgId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  const { data, error } = await db
    .from("memberships")
    .select("user_id, role, access_status, access_expires_at, deletion_prepared_at")
    .eq("org_id", orgId)
    .eq("role", "owner");
  if (error) throw new Error(`hot owner lookup failed: ${error.message}`);
  const owners = ((data ?? []) as MembershipRow[]).filter((m) => hasActiveSandraAccess(m)).map((m) => m.user_id);
  const pick = env.HOT_LEAD_ASSIGNEE_USER_ID?.trim();
  if (pick) return owners.includes(pick) ? pick : null;
  return owners.length === 1 ? owners[0] : null;
}

export async function assignHotLeadToOwner(
  db: SupabaseClient<Database>,
  propertyId: string,
  opts: { inboundMessageId?: string | null; env?: Record<string, string | undefined> } = {},
): Promise<HotAssignResult> {
  const env = opts.env ?? process.env;
  const inbound = opts.inboundMessageId ?? null;
  try {
    if (!inbound) return { status: "failed", reason: "db_error", detail: "no inbound message id" };
    const { data: property, error: lookupError } = await db
      .from("properties")
      .select("id, org_id, assigned_user_id, is_dnc_locked, deleted_at, needs_human_attention, last_ai_escalation_reason")
      .eq("id", propertyId)
      .maybeSingle();
    if (lookupError) return { status: "failed", reason: "db_error", detail: lookupError.message };
    if (!property || property.deleted_at) return { status: "failed", reason: "not_found" };
    if (property.is_dnc_locked) return { status: "failed", reason: "dnc_locked" };

    const owner = await resolveHotOwner(db, property.org_id, env);
    if (!owner) return { status: "failed", reason: "no_hot_owner" };
    const validation = await validateActiveAssigneeForProperties(db, [propertyId], owner);
    if (!validation.ok) return { status: "failed", reason: "db_error", detail: validation.code };

    // An open HOT hold already pinged Jarrad about this lead: more hot texts
    // while it is open are recorded but do not ping again.
    const coveredByHold = !!property.needs_human_attention && isHotReason(property.last_ai_escalation_reason);

    // Replay of a text Sandra already handed off: nothing new.
    const handedOff = await findBySource(db, HOT_HANDOFF_SOURCE_TYPE, inbound);
    if (handedOff === "error") return { status: "failed", reason: "db_error", detail: "handoff event lookup" };
    if (handedOff && property.assigned_user_id === owner) return { status: "already_assigned", assigneeUserId: owner };

    const previous = property.assigned_user_id;
    if (previous === owner) return hotTextOn(db, propertyId, owner, inbound, coveredByHold);
    // A rep owns it: leave it with them. Not a failure, no hold, no alert to Jarrad.
    if (previous !== null) return { status: "owned_by_someone_else", ownerUserId: previous };

    // Guarded assignment; the `assigned` event ONLY when THIS update made it.
    const { data: saved, error } = await db
      .from("properties")
      .update({ assigned_user_id: owner, updated_at: new Date().toISOString() })
      .eq("id", propertyId)
      .is("assigned_user_id", null)
      .select("id, assigned_user_id")
      .maybeSingle();
    if (error) return { status: "failed", reason: "db_error", detail: error.message };
    if (!saved) {
      const { data: now, error: recheckError } = await db
        .from("properties")
        .select("assigned_user_id")
        .eq("id", propertyId)
        .maybeSingle();
      if (recheckError) return { status: "failed", reason: "db_error", detail: recheckError.message };
      if (now?.assigned_user_id === owner) {
        // A concurrent run of this same text won the update: its hand-off covers it.
        const sameText = await findBySource(db, HOT_HANDOFF_SOURCE_TYPE, inbound);
        if (sameText === true) return { status: "already_assigned", assigneeUserId: owner };
        return hotTextOn(db, propertyId, owner, inbound, coveredByHold);
      }
      return now?.assigned_user_id
        ? { status: "owned_by_someone_else", ownerUserId: now.assigned_user_id }
        : { status: "failed", reason: "db_error", detail: "assignment lost" };
    }
    const ok = await recordOnce(db, {
      propertyId,
      eventType: LEAD_EVENT_TYPES.ASSIGNED,
      payload: { from: null, to: owner, reason: "hot_seller", inbound, covered_by_hold: coveredByHold },
      sourceType: HOT_HANDOFF_SOURCE_TYPE,
      sourceId: inbound,
    });
    return ok
      ? { status: "assigned", assigneeUserId: owner }
      : { status: "assigned_unrecorded", assigneeUserId: owner, detail: "handoff event not recorded" };
  } catch (error) {
    return { status: "failed", reason: "db_error", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** A hot text on a lead Jarrad already has: no reassignment, one hot_text event (alerts unless covered by an open hot hold). */
async function hotTextOn(
  db: SupabaseClient<Database>,
  propertyId: string,
  owner: string,
  inbound: string,
  coveredByHold: boolean,
): Promise<HotAssignResult> {
  const ok = await recordOnce(db, {
    propertyId,
    eventType: LEAD_EVENT_TYPES.AI_ESCALATED,
    payload: { to: owner, reason: "hot_seller_text", covered_by_hold: coveredByHold },
    sourceType: HOT_TEXT_SOURCE_TYPE,
    sourceId: inbound,
  });
  return ok
    ? { status: "already_owned", assigneeUserId: owner }
    : { status: "assigned_unrecorded", assigneeUserId: owner, detail: "hot text event not recorded" };
}

async function findBySource(db: SupabaseClient<Database>, sourceType: string, sourceId: string): Promise<boolean | "error"> {
  const { data, error } = await db.from("lead_events").select("id").eq("source_type", sourceType).eq("source_id", sourceId).limit(1);
  if (error) return "error";
  return (data ?? []).length > 0;
}

/** recordLeadEvent (best-effort) + read back by source identity; true only when the row exists. */
async function recordOnce(
  db: SupabaseClient<Database>,
  e: { propertyId: string; eventType: (typeof LEAD_EVENT_TYPES)[keyof typeof LEAD_EVENT_TYPES]; payload: Json; sourceType: string; sourceId: string },
): Promise<boolean> {
  const before = await findBySource(db, e.sourceType, e.sourceId);
  if (before === "error") return false;
  if (before) return true;
  await recordLeadEvent({ propertyId: e.propertyId, actorType: "ai", eventType: e.eventType, payload: e.payload, sourceType: e.sourceType, sourceId: e.sourceId });
  return (await findBySource(db, e.sourceType, e.sourceId)) === true;
}
