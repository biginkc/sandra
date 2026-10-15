import type { SupabaseClient } from "@supabase/supabase-js";

import { hasActiveSandraAccess } from "@/lib/auth/access-state";
import { validateActiveAssigneeForProperties } from "@/app/(dashboard)/leads/assignment-safety";
import { LEAD_EVENT_TYPES, recordLeadEvent } from "@/lib/events";
import type { Database } from "@/lib/supabase/types";

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
 * Idempotent per property: the event carries source identity
 * (`hot_seller_handoff`, property id), which the ledger's unique index allows
 * once ever, and a property already assigned to the hot owner is not written.
 * A lead already owned by SOMEONE ELSE is never taken from them.
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
  | { status: "failed"; reason: "no_hot_owner" | "owned_by_someone_else" | "not_found" | "dnc_locked" | "db_error"; detail?: string };

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
  try {
    const { data: property, error: lookupError } = await db
      .from("properties")
      .select("id, org_id, assigned_user_id, is_dnc_locked, deleted_at")
      .eq("id", propertyId)
      .maybeSingle();
    if (lookupError) return { status: "failed", reason: "db_error", detail: lookupError.message };
    if (!property || property.deleted_at) return { status: "failed", reason: "not_found" };
    if (property.is_dnc_locked) return { status: "failed", reason: "dnc_locked" };

    const owner = await resolveHotOwner(db, property.org_id, env);
    if (!owner) return { status: "failed", reason: "no_hot_owner" };

    const validation = await validateActiveAssigneeForProperties(db, [propertyId], owner);
    if (!validation.ok) return { status: "failed", reason: "db_error", detail: validation.code };

    let status: "assigned" | "already_assigned" = "already_assigned";
    const previous = property.assigned_user_id;
    if (previous === owner) {
      const prior = await findHandoffEvent(db, propertyId);
      if (prior === "error") return { status: "failed", reason: "db_error", detail: "handoff event lookup" };
      // A replay of Sandra's own hand-off.
      if (prior) return { status: "already_assigned", assigneeUserId: owner };
      // His already, with no hand-off event. If no 'assigned' event names him
      // either, Sandra's own hand-off was interrupted between the update and
      // the event: finish it (back-fill + alert) below.
      const byPerson = await findAssignedEventTo(db, propertyId, owner);
      if (byPerson === "error") return { status: "failed", reason: "db_error", detail: "assignment history lookup" };
      if (byPerson) {
        // A person gave him this lead: no reassignment, one alert for this hot text.
        const recorded = await recordHotText(db, propertyId, owner, opts.inboundMessageId ?? null);
        return recorded
          ? { status: "already_owned", assigneeUserId: owner }
          : { status: "assigned_unrecorded", assigneeUserId: owner, detail: "hot text event not recorded" };
      }
      status = "assigned";
    } else {
      if (previous !== null) return { status: "failed", reason: "owned_by_someone_else" };
      const { data: saved, error } = await db
        .from("properties")
        .update({ assigned_user_id: owner, updated_at: new Date().toISOString() })
        .eq("id", propertyId)
        .is("assigned_user_id", null)
        .select("id, assigned_user_id")
        .maybeSingle();
      if (error) return { status: "failed", reason: "db_error", detail: error.message };
      if (!saved) {
        // Lost a race: fine only if the winner made the same assignment.
        const { data: now, error: recheckError } = await db
          .from("properties")
          .select("assigned_user_id")
          .eq("id", propertyId)
          .maybeSingle();
        if (recheckError) return { status: "failed", reason: "db_error", detail: recheckError.message };
        if (now?.assigned_user_id !== owner) return { status: "failed", reason: "owned_by_someone_else" };
      } else {
        status = "assigned";
      }
    }

    // The 'assigned' event is part of the hand-off (the alert cron reads it).
    // recordLeadEvent is best-effort, so the row is read back; its source
    // identity (unique in the ledger) makes a retry a no-op.
    const existing = await findHandoffEvent(db, propertyId);
    if (existing === "error") return { status: "assigned_unrecorded", assigneeUserId: owner, detail: "handoff event lookup" };
    if (!existing) {
      await recordLeadEvent({
        propertyId,
        actorType: "ai",
        eventType: LEAD_EVENT_TYPES.ASSIGNED,
        payload: { from: previous, to: owner, reason: "hot_seller" },
        sourceType: HOT_HANDOFF_SOURCE_TYPE,
        sourceId: propertyId,
      });
      const written = await findHandoffEvent(db, propertyId);
      if (written !== true) return { status: "assigned_unrecorded", assigneeUserId: owner, detail: "handoff event not recorded" };
    }
    return { status, assigneeUserId: owner };
  } catch (error) {
    return { status: "failed", reason: "db_error", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function findHandoffEvent(db: SupabaseClient<Database>, propertyId: string): Promise<boolean | "error"> {
  const { data, error } = await db
    .from("lead_events")
    .select("id")
    .eq("source_type", HOT_HANDOFF_SOURCE_TYPE)
    .eq("source_id", propertyId)
    .limit(1);
  if (error) return "error";
  return (data ?? []).length > 0;
}

async function findAssignedEventTo(
  db: SupabaseClient<Database>,
  propertyId: string,
  userId: string,
): Promise<boolean | "error"> {
  const { data, error } = await db
    .from("lead_events")
    .select("id")
    .eq("property_id", propertyId)
    .eq("event_type", LEAD_EVENT_TYPES.ASSIGNED)
    .eq("payload->>to", userId)
    .limit(1);
  if (error) return "error";
  return (data ?? []).length > 0;
}

/** One `ai_escalated` hot-text event per inbound message, read back. False = not recorded. */
async function recordHotText(
  db: SupabaseClient<Database>,
  propertyId: string,
  owner: string,
  inboundMessageId: string | null,
): Promise<boolean> {
  if (!inboundMessageId) return false;
  const find = async () => {
    const { data, error } = await db
      .from("lead_events")
      .select("id")
      .eq("source_type", HOT_TEXT_SOURCE_TYPE)
      .eq("source_id", inboundMessageId)
      .limit(1);
    return error ? null : (data ?? []).length > 0;
  };
  const before = await find();
  if (before === null) return false;
  if (before) return true;
  await recordLeadEvent({
    propertyId,
    actorType: "ai",
    eventType: LEAD_EVENT_TYPES.AI_ESCALATED,
    payload: { to: owner, reason: "hot_seller_text" },
    sourceType: HOT_TEXT_SOURCE_TYPE,
    sourceId: inboundMessageId,
  });
  return (await find()) === true;
}
