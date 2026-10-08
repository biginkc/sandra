import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/errors/report";

import { pausePropertyEnrollments, type SequenceEventActor } from "./enrollment";

/**
 * "Stops the moment a person takes over or the seller replies" (Jarrad,
 * 2026-10-07). The seller-reply half is the existing inbound pause. This is the
 * person half: when a person acts on a lead (confirms the proposed new_lead,
 * sends a manual text; assignment is handled by a database trigger) and the
 * lead has an enrolment created by the hot "Book appointment" route, pause it
 * (reason `person_took_over`, resumable).
 *
 * The enrolment is identified by the route it was CREATED with
 * (`sequence_enrollments.auto_enrolled_route`), not by the org's current
 * mapping, so remapping the owner's drip later never strips protection from
 * enrolments already running. Every other drip is left alone.
 *
 * Order matters for the race with a concurrent hot-lead enrolment: the durable
 * marker `properties.last_person_takeover_at` is written FIRST, then the
 * pause; the enrolment side inserts first and then checks the marker
 * (`pauseHotEnrollmentIfTakenOverSince`). Either order ends paused.
 *
 * Best-effort and never throws: the person's own action must not fail because
 * of this. A failure is reported.
 */
export async function pauseHotBookAppointmentOnTakeover(a: {
  propertyIds: string[];
  actor: SequenceEventActor;
}): Promise<{ paused: number }> {
  let paused = 0;
  try {
    if (a.propertyIds.length === 0) return { paused };
    const admin = createAdminClient();
    const { error: markError } = await admin
      .from("properties")
      .update({ last_person_takeover_at: new Date().toISOString() })
      .in("id", a.propertyIds);
    if (markError) throw new Error(markError.message);
    const { data: live, error } = await admin
      .from("sequence_enrollments")
      .select("property_id")
      .in("property_id", a.propertyIds)
      .eq("status", "active")
      .eq("auto_enrolled_route", "hot_book_appointment");
    if (error) throw new Error(error.message);
    for (const propertyId of new Set((live ?? []).map((r) => r.property_id))) {
      const result = await pausePropertyEnrollments(admin, {
        propertyId,
        reason: "person_took_over",
        actor: a.actor,
      });
      paused += result.paused;
    }
  } catch (e) {
    reportError(e, { tags: { surface: "hot_lead_takeover_pause" }, extra: { count: a.propertyIds.length } });
  }
  return { paused };
}

/**
 * Called by the hot-lead dispatch right after it inserted the enrolment: if a
 * person took over, or the seller sent a newer inbound, at or after `since`
 * (their pause ran before the enrolment existed and so found nothing), pause it
 * now. `since` is taken before classification starts.
 */
export async function pauseHotEnrollmentIfTakenOverSince(a: {
  propertyId: string;
  since: string;
}): Promise<{ paused: number }> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("properties")
      .select("last_person_takeover_at")
      .eq("id", a.propertyId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const at = data?.last_person_takeover_at;
    if (at && new Date(at).getTime() >= new Date(a.since).getTime()) {
      return await pausePropertyEnrollments(admin, { propertyId: a.propertyId, reason: "person_took_over" });
    }
    // The seller replied again while this dispatch ran: the inbound pause found
    // no enrolment yet. The triggering inbound predates `since`, so any inbound
    // after it is a newer reply.
    const { data: newer, error: newerError } = await admin
      .from("messages")
      .select("id")
      .eq("property_id", a.propertyId)
      .eq("direction", "inbound")
      .gt("created_at", a.since)
      .limit(1);
    if (newerError) throw new Error(newerError.message);
    if (newer && newer.length > 0) {
      return await pausePropertyEnrollments(admin, { propertyId: a.propertyId, reason: "inbound_reply" });
    }
    return { paused: 0 };
  } catch (e) {
    reportError(e, { tags: { surface: "hot_lead_takeover_reconcile" }, extra: { propertyId: a.propertyId } });
    return { paused: 0 };
  }
}
