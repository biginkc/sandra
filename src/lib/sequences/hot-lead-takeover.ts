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
 * Routing v2 (PR-F, `alert_on_time_only`): a v2 "yes" is not a hot seller, so it never gets a
 * `hot_book_appointment` enrolment and is never proposed as a new_lead (`isHotSellerUnderV2`);
 * its v2 Book appointment drip is not matched here. The takeover marker written below is what
 * fences v2: the `trg_routing_v2_takeover_fence` trigger (migration 20261030230000) cancels the
 * property's pending v2 auto replies under the routing v2 lock in the same transaction, the
 * delivery re-check refuses an already-claimed one, and the v2 send check pauses the drip.
 * With routing v2 off nothing here changes.
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
    // DB clock, under the routing v2 property lock (stress §14), ONE property per call so no
    // transaction holds two routing locks (review N-6). Astra review of 921b71c2a133 (P1): the
    // fallback never uses the app clock (a clock running behind would stamp the takeover before the
    // seller's text and the drip check would miss it). If the function is missing, or still fails
    // after one retry (reported), a plain update writes the DB's own time ('now' is evaluated by
    // Postgres). If that fails too, fail closed: every active v2 drip of the property is paused and
    // its pending v2 auto replies are cancelled, and it is reported.
    const rpc = (admin as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: { message?: string } | null }>;
    }).rpc.bind(admin);
    for (const propertyId of a.propertyIds) {
      let { error: rpcError } = await rpc("routing_v2_mark_person_takeover", { p_property_id: propertyId });
      if (rpcError && !/PGRST202|42883|does not exist|Could not find/i.test(rpcError.message ?? "")) {
        ({ error: rpcError } = await rpc("routing_v2_mark_person_takeover", { p_property_id: propertyId }));
        if (rpcError) {
          reportError(new Error(rpcError.message ?? "takeover stamp failed"), {
            tags: { surface: "hot_lead_takeover_stamp" },
            extra: { propertyId },
          });
        }
      }
      if (rpcError) {
        const { error: markError } = await admin
          .from("properties")
          .update({ last_person_takeover_at: "now" })
          .eq("id", propertyId);
        if (markError) {
          reportError(new Error(markError.message), {
            tags: { surface: "hot_lead_takeover_stamp_fallback" },
            extra: { propertyId },
          });
          await failClosedV2Takeover(admin, propertyId);
        }
      }
    }
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

/**
 * The takeover could not be stamped at all: no v2 automation may continue on this property.
 * Every active v2 drip is paused for the person and every pending v2 auto reply is cancelled.
 * Best effort; each failure is reported (the person's own action never fails because of this).
 */
async function failClosedV2Takeover(admin: ReturnType<typeof createAdminClient>, propertyId: string) {
  const now = new Date().toISOString();
  const { error: pauseError } = await admin
    .from("sequence_enrollments")
    .update({ status: "paused", pause_reason: "person_took_over", next_run_at: null, updated_at: now })
    .eq("property_id", propertyId)
    .eq("routing_v2_engine", "v2")
    .eq("status", "active");
  if (pauseError) {
    reportError(new Error(pauseError.message), { tags: { surface: "hot_lead_takeover_fail_closed_pause" }, extra: { propertyId } });
  }
  const { error: cancelError } = await (admin as unknown as {
    from: (t: string) => {
      update: (v: Record<string, unknown>) => {
        eq: (c: string, v: unknown) => { eq: (c: string, v: unknown) => { eq: (c: string, v: unknown) => PromiseLike<{ error: { message: string } | null }> } };
      };
    };
  }).from("routing_v2_outbox")
    .update({ status: "cancelled", cancel_reason: "human_takeover" })
    .eq("property_id", propertyId)
    .eq("kind", "reply")
    .eq("status", "pending");
  if (cancelError) {
    reportError(new Error(cancelError.message), { tags: { surface: "hot_lead_takeover_fail_closed_cancel" }, extra: { propertyId } });
  }
}
