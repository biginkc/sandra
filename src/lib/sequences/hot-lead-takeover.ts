import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/errors/report";

import { pausePropertyEnrollments, type SequenceEventActor } from "./enrollment";

/**
 * "Stops the moment a person takes over or the seller replies" (Jarrad,
 * 2026-10-07). The seller-reply half is the existing inbound pause. This is the
 * person half: when a person acts on a lead (confirms the proposed new_lead,
 * assigns it, sends a manual text) and that lead's live enrolment is the
 * org's auto-enrolled "Book appointment" drip, pause it (reason
 * `person_took_over`, resumable). Any other drip is left alone: a person
 * assigning a "Maybe later" lead must not silently stop its check-ins.
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
    const { data: live, error } = await admin
      .from("sequence_enrollments")
      .select("property_id, org_id, sequence_id")
      .in("property_id", a.propertyIds)
      .eq("status", "active");
    if (error) throw new Error(error.message);
    if (!live?.length) return { paused };
    const orgIds = [...new Set(live.map((r) => r.org_id))];
    const { data: cfgs, error: cfgError } = await admin
      .from("ai_responder_configs")
      .select("org_id, nurture_drip_hot_book_appointment_sequence_id")
      .in("org_id", orgIds);
    if (cfgError) throw new Error(cfgError.message);
    const hotByOrg = new Map((cfgs ?? []).map((c) => [c.org_id, c.nurture_drip_hot_book_appointment_sequence_id]));
    for (const row of live) {
      const hot = hotByOrg.get(row.org_id);
      if (!hot || hot !== row.sequence_id) continue;
      const result = await pausePropertyEnrollments(admin, {
        propertyId: row.property_id,
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
