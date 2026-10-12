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
 * marker `properties.last_person_takeover_at` is written FIRST (it needs the
 * property row exclusively, so it waits for an in-flight enrolment insert to
 * commit), then the pause. The enrolment itself is fenced atomically by the
 * `trg_hot_enrollment_takeover_fence` trigger (born paused when a takeover or a
 * newer seller reply happened since the triggering inbound).
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
    // 1) Re-label a TEMPORARY pause (a call in progress, a Norma call) FIRST, with the
    //    status/reason predicates evaluated by the database at update time (no snapshot):
    //    call cleanup resumes only a row still carrying its own reason, so a cleanup that
    //    runs after this can no longer undo the takeover.
    const { error: upgradeError } = await admin
      .from("sequence_enrollments")
      .update({ pause_reason: "person_took_over", updated_at: new Date().toISOString() })
      .in("property_id", a.propertyIds)
      .eq("auto_enrolled_route", "hot_book_appointment")
      .eq("status", "paused")
      .in("pause_reason", ["call_in_progress", "norma_call"]);
    if (upgradeError) throw new Error(upgradeError.message);
    // 2) Then pause whatever is (or just became, via a cleanup between the two steps) active.
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
