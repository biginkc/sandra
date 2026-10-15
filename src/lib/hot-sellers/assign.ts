import type { SupabaseClient } from "@supabase/supabase-js";

import { hasActiveSandraAccess } from "@/lib/auth/access-state";
import { validateActiveAssigneeForProperties } from "@/app/(dashboard)/leads/assignment-safety";
import { LEAD_EVENT_TYPES, recordLeadEvent } from "@/lib/events";
import { HOT_ALERTS_START_ISO, hotFlagKey, isHotReason } from "@/lib/hot-sellers/hot";
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
/** The frozen hold loader's look-back (7 days). */
const HOLD_ALERT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const HOT_HANDOFF_SOURCE_TYPE = "hot_seller_handoff";
/**
 * A hot text on a lead Jarrad already owns: no reassignment and no 'assigned'
 * event, but one alert per hot decision. Recorded as an `ai_escalated` lead
 * event with source identity (hot_seller_text, inbound message id), which the
 * ledger allows once per inbound.
 */
export const HOT_TEXT_SOURCE_TYPE = "hot_seller_text";
/**
 * A hot text whose hand-off failed. Its own event keyed by the inbound, so the
 * alert never depends on the property's attention flag (which a pre-existing
 * non-hot flag would leave unchanged).
 */
export const HOT_FAILED_SOURCE_TYPE = "hot_seller_failed";


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
      .select("id, org_id, assigned_user_id, is_dnc_locked, deleted_at, needs_human_attention, last_ai_escalation_reason, last_ai_escalation_at")
      .eq("id", propertyId)
      .maybeSingle();
    if (lookupError) return { status: "failed", reason: "db_error", detail: lookupError.message };
    if (!property || property.deleted_at) return { status: "failed", reason: "not_found" };
    if (property.is_dnc_locked) return { status: "failed", reason: "dnc_locked" };

    // Replay of a text Sandra already handed off: nothing new, nothing re-taken,
    // never a failure alert. Report who has the lead NOW.
    const handedOff = await findBySource(db, HOT_HANDOFF_SOURCE_TYPE, inbound);
    if (handedOff === "error") return { status: "failed", reason: "db_error", detail: "handoff event lookup" };
    if (handedOff) {
      const current = property.assigned_user_id;
      const hotOwnerNow = await resolveHotOwner(db, property.org_id, env).catch(() => null);
      if (current && current !== hotOwnerNow) return { status: "owned_by_someone_else", ownerUserId: current };
      return { status: "already_assigned", assigneeUserId: current ?? "" };
    }

    const owner = await resolveHotOwner(db, property.org_id, env);
    if (!owner) return { status: "failed", reason: "no_hot_owner" };
    const validation = await validateActiveAssigneeForProperties(db, [propertyId], owner);
    if (!validation.ok) return { status: "failed", reason: "db_error", detail: validation.code };

    // An open HOT hold already pinged Jarrad about this lead: more hot texts
    // while it is open are recorded but do not ping again.
    // This same text's failed hand-off already pinged him: never twice for one text.
    const failedBefore = await findBySource(db, HOT_FAILED_SOURCE_TYPE, inbound);
    const coveredByHold = failedBefore === true || (await isCoveredByHotHold(db, property, owner));


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
      // Concurrent runs of the SAME inbound cannot both get here: dispatch
      // claims each inbound once (claimAiResponse). Guarded anyway below.
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

/**
 * Record a failed hot hand-off as its own event (one per inbound), after the
 * hold's flag write. The alert goes to the resolved hot owner.
 * Best-effort read back; false = not recorded (the hold still stands).
 */
export async function recordHotFailure(
  db: SupabaseClient<Database>,
  propertyId: string,
  inboundMessageId: string | null | undefined,
  reason: string,
  /** The flag time THIS hand-off failure set (null = the flag was already set by something else). */
  ourFlagAt: string | null = null,
): Promise<boolean> {
  if (!inboundMessageId) return false;
  const { data: property } = await db
    .from("properties")
    .select("id, org_id, needs_human_attention, last_ai_escalation_reason, last_ai_escalation_at")
    .eq("id", propertyId)
    .maybeSingle();
  // Called AFTER the flag write. If the open flag is this failure, the event
  // carries its flag time so the hold and the event share hot_flag:<property>:<flagAt>
  // (stable; later texts never re-key it). An earlier hot hold that already
  // alerted covers it.
  // Share the hold's hot_flag key ONLY when this failure set the flag itself
  // (its stored time, as PostgREST returns it); a flag set by another inbound
  // (even with the same reason) never lends its key: this failure gets its own
  // hot_failed:<inbound> key unless that hold's alert covers it.
  const flagIsOurs =
    ourFlagAt !== null &&
    property?.needs_human_attention === true &&
    property.last_ai_escalation_reason === reason &&
    !!property.last_ai_escalation_at &&
    Date.parse(property.last_ai_escalation_at) === Date.parse(ourFlagAt);
  const flagAt = flagIsOurs ? property?.last_ai_escalation_at ?? null : null;
  const owner = property && !flagIsOurs ? await resolveHotOwner(db, property.org_id).catch(() => null) : null;
  const coveredByHold = property && !flagIsOurs ? await isCoveredByHotHold(db, property, owner) : false;
  return recordOnce(db, {
    propertyId,
    eventType: LEAD_EVENT_TYPES.AI_ESCALATED,
    payload: { reason, covered_by_hold: coveredByHold, flag_at: flagAt },
    sourceType: HOT_FAILED_SOURCE_TYPE,
    sourceId: inboundMessageId,
  });
}

/**
 * An open hot hold covers later hot texts ONLY if it actually pinged Jarrad:
 * hot flag reason, flag time at/after the cutoff, and a SENT delivery (at
 * least one channel) for its key. A pre-cutoff or never-alerted hot hold covers nothing.
 */
async function isCoveredByHotHold(
  db: SupabaseClient<Database>,
  p: { id: string; org_id: string; needs_human_attention: boolean | null; last_ai_escalation_reason: string | null; last_ai_escalation_at: string | null },
  /** The CURRENT hot owner; null (unresolved) never counts as covered. */
  owner: string | null,
): Promise<boolean> {
  if (!owner) return false;
  if (!p.needs_human_attention || !isHotReason(p.last_ai_escalation_reason) || !p.last_ai_escalation_at) return false;
  if (Date.parse(p.last_ai_escalation_at) < Date.parse(HOT_ALERTS_START_ISO)) return false;
  // Every hot flag hold (failed hand-offs included) alerts under
  // hot_flag:<property>:<flagAt>.
  const key = hotFlagKey(p.id, p.last_ai_escalation_at);
  const { data, error } = await (db as unknown as { from: (t: string) => ReturnType<SupabaseClient<Database>["from"]> })
    .from("hold_alert_deliveries")
    .select("id, status, recipient_user_id")
    .eq("hold_key" as never, key as never);
  if (error) return false;
  // For the CURRENT owner, covered only if:
  //  (a) a delivery for this hold's key was CONFIRMED sent to them, or
  //  (b) there is no delivery for them yet AND the hold is guaranteed to alert
  //      them on the next pass (hot flag, flagAt at/after the cutoff, at/after
  //      the org's alerts_since watermark, and inside the 7-day loader window),
  //      so an owner change never pings the new owner twice.
  // Any pending, sending, failed or skipped row to them, a failed lookup, or a
  // hold failing (b) → NOT covered: a possible double ping beats a silence.
  const mine = ((data ?? []) as unknown as Array<{ status: string; recipient_user_id: string }>).filter(
    (d) => d.recipient_user_id === owner,
  );
  if (mine.some((d) => d.status === "sent")) return true;
  if (mine.length > 0) return false;
  const flagMs = Date.parse(p.last_ai_escalation_at);
  if (!Number.isFinite(flagMs) || Date.now() - flagMs > HOLD_ALERT_WINDOW_MS) return false;
  const { data: settings, error: settingsError } = await (db as unknown as { from: (t: string) => ReturnType<SupabaseClient<Database>["from"]> })
    .from("hold_alert_settings")
    .select("alerts_since")
    .eq("org_id" as never, p.org_id as never)
    .maybeSingle();
  if (settingsError || !settings) return false;
  const since = Date.parse((settings as unknown as { alerts_since: string }).alerts_since);
  return Number.isFinite(since) && flagMs >= since;
}

/**
 * A hot text on a lead that already needs a person (dispatch's classify-only
 * step). One `hot_seller_text` event per inbound, flagged `held_lead`, to the
 * resolved hot owner; nothing is assigned. A rep's or DNC-locked lead, or an
 * unresolved owner, records nothing ("skipped"); a failed ledger write is
 * "write_failed" so the caller keeps the inbound retryable.
 */
export async function recordHotTextOnHeldLead(
  db: SupabaseClient<Database>,
  propertyId: string,
  inboundMessageId: string | null,
  reason: string,
  env: Record<string, string | undefined> = process.env,
): Promise<"recorded" | "skipped" | "write_failed"> {
  if (!inboundMessageId) return "skipped";
  const { data: property } = await db
    .from("properties")
    .select("id, org_id, assigned_user_id, is_dnc_locked, deleted_at, needs_human_attention, last_ai_escalation_reason, last_ai_escalation_at")
    .eq("id", propertyId)
    .maybeSingle();
  if (!property || property.deleted_at || property.is_dnc_locked) return "skipped";
  const owner = await resolveHotOwner(db, property.org_id, env).catch(() => null);
  if (!owner) return "skipped";
  if (property.assigned_user_id && property.assigned_user_id !== owner) return "skipped";
  const coveredByHold = await isCoveredByHotHold(db, property, owner);
  const ok = await recordOnce(db, {
    propertyId,
    eventType: LEAD_EVENT_TYPES.AI_ESCALATED,
    payload: { to: owner, reason: "hot_seller_text", held_lead: true, escalation: reason, covered_by_hold: coveredByHold },
    sourceType: HOT_TEXT_SOURCE_TYPE,
    sourceId: inboundMessageId,
  });
  return ok ? "recorded" : "write_failed";
}
