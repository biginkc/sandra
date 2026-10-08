import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { LEAD_EVENT_TYPES, recordLeadEvent } from "@/lib/events";
import { enrollLead, type EnrollmentOutcome } from "@/lib/sequences/enrollment";
import type { NurtureDripKey } from "./nurture-routes";
import type { Database } from "@/lib/supabase/types";

/**
 * Auto-drip for Jev's auto-applied `nurture` outcome (per-org switch
 * `ai_responder_configs.nurture_auto_drip`, default OFF).
 *
 * This is the machine version of the "start drip" button
 * (`setInboxDispoAndStartDrip` -> `saveOutreachDispo`): release `nurture` to
 * `needs_sequence`, then enrol through the SAME `enrollLead` the button uses,
 * so eligibility (phone, landline, consent, suppression, DNC lock, Norma hold,
 * inactive drip) and idempotency (one live drip per property, unique indexes)
 * are the existing ones. Nothing here picks a drip by itself: the owner mapped
 * each route to a drip when turning the switch on, and the route comes from
 * Jev's approved timeframe / listing answers (`routeNurture`).
 *
 * Callers must only run this AFTER the nurture reply was accepted by the
 * provider (see `dispatch.ts`); this module does not look at the reply.
 */
export {
  NURTURE_DRIP_DEFAULT_NAMES,
  NURTURE_FIRST_SEND_DELAY_DAYS,
  routeNurture,
  type NurtureDripKey,
  type NurtureRoute,
} from "./nurture-routes";

export type NurtureAutoDripConfig =
  | { enabled: false }
  | { enabled: true; sequences: Record<NurtureDripKey, string | null> };

export type NurtureAutoDripResult =
  | { status: "enrolled"; sequenceId: string; enrollmentId: string; firstSendNotBefore: string }
  | { status: "already_enrolled"; sequenceId: string }
  | { status: "refused"; reason: string };

/**
 * A config that cannot be read is treated as OFF: the switch state is unknown,
 * and an unreadable config must not turn into holds for every nurture.
 * The failure is reported.
 */
export async function loadNurtureAutoDripConfig(
  supabase: SupabaseClient<Database>,
  orgId: string,
): Promise<NurtureAutoDripConfig> {
  const { data, error } = await supabase
    .from("ai_responder_configs")
    .select(
      "nurture_auto_drip, nurture_drip_maybe_later_sequence_id, nurture_drip_check_in_60_sequence_id, nurture_drip_listed_not_selling_sequence_id, nurture_drip_hot_book_appointment_sequence_id",
    )
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    reportError(new Error(error.message), { tags: { surface: "nurture_auto_drip_config" }, extra: { orgId } });
    return { enabled: false };
  }
  if (!data || !data.nurture_auto_drip) return { enabled: false };
  return {
    enabled: true,
    sequences: {
      maybe_later: data.nurture_drip_maybe_later_sequence_id ?? null,
      check_in_60: data.nurture_drip_check_in_60_sequence_id ?? null,
      listed_not_selling: data.nurture_drip_listed_not_selling_sequence_id ?? null,
      hot_book_appointment: data.nurture_drip_hot_book_appointment_sequence_id ?? null,
    },
  };
}

function refusalReason(outcome: Exclude<EnrollmentOutcome, { status: "enrolled" | "duplicate_active" }>): string {
  return outcome.status === "failed" ? "enroll_failed" : outcome.status;
}

export async function enrollNurtureInDrip(
  supabase: SupabaseClient<Database>,
  a: { propertyId: string; sequenceId: string | null; delayDays?: number },
): Promise<NurtureAutoDripResult> {
  if (!a.sequenceId) return { status: "refused", reason: "no_drip_configured" };
  const { propertyId, sequenceId } = a;
  const firstSendNotBefore = new Date(Date.now() + (a.delayDays ?? 0) * 24 * 3600_000);

  // Release nurture (human-owned, blocks automated sends) to needs_sequence,
  // the same transition the button makes. Guarded so a person's more specific
  // outcome set in the meantime is never overwritten, and a DNC-locked row is
  // never touched.
  const now = new Date().toISOString();
  const { data: promoted, error: promoteError } = await supabase
    .from("properties")
    .update({ outreach_dispo: "needs_sequence", follow_up_at: null, updated_at: now })
    .eq("id", propertyId)
    .eq("outreach_dispo", "nurture")
    .eq("is_dnc_locked", false)
    .select("id")
    .maybeSingle();
  if (promoteError) {
    reportError(new Error(promoteError.message), { tags: { surface: "nurture_auto_drip_promote" }, extra: { propertyId } });
    return { status: "refused", reason: "promote_failed" };
  }
  const promotedHere = Boolean(promoted);
  if (!promoted) {
    // Retry of a dispatch that already promoted: proceed (enrolment is
    // idempotent). Anything else means the outcome changed under us.
    const { data: current, error: readError } = await supabase
      .from("properties")
      .select("outreach_dispo")
      .eq("id", propertyId)
      .maybeSingle();
    if (readError || !current) return { status: "refused", reason: "outcome_unreadable" };
    if (current.outreach_dispo !== "needs_sequence") return { status: "refused", reason: "outcome_changed" };
  }

  const revert = async (force = false) => {
    if (!promotedHere && !force) return;
    const { error } = await supabase
      .from("properties")
      .update({ outreach_dispo: "nurture", updated_at: new Date().toISOString() })
      .eq("id", propertyId)
      .eq("outreach_dispo", "needs_sequence");
    if (error) reportError(new Error(error.message), { tags: { surface: "nurture_auto_drip_revert" }, extra: { propertyId } });
  };

  let outcome: EnrollmentOutcome;
  try {
    outcome = await enrollLead(supabase, { propertyId, sequenceId, enrolledByUserId: null, firstSendNotBefore });
  } catch (error) {
    reportError(error, { tags: { surface: "nurture_auto_drip_enroll" }, extra: { propertyId, sequenceId } });
    await revert();
    return { status: "refused", reason: "enroll_failed" };
  }

  if (outcome.status !== "enrolled" && outcome.status !== "duplicate_active") {
    await revert();
    return { status: "refused", reason: refusalReason(outcome) };
  }

  if (outcome.status === "duplicate_active") {
    // The same drip already holds this lead. A PAUSED enrolment sends nothing
    // (a reply or call paused it), so the lead would go silent: hand it back.
    const { data: live, error: liveError } = await supabase
      .from("sequence_enrollments")
      .select("status")
      .eq("property_id", propertyId)
      .eq("sequence_id", sequenceId)
      .in("status", ["active", "paused"])
      .limit(1)
      .maybeSingle();
    if (liveError || !live) {
      await revert(true);
      return { status: "refused", reason: "drip_status_unreadable" };
    }
    if (live.status === "paused") {
      await revert(true);
      return { status: "refused", reason: "drip_paused" };
    }
  }

  if (promotedHere) {
    try {
      await recordLeadEvent({
        propertyId,
        actorType: "ai",
        eventType: LEAD_EVENT_TYPES.DISPO_SET,
        payload: { from: "nurture", to: "needs_sequence", reason: "nurture_auto_drip" },
      });
    } catch (error) {
      reportError(error, { tags: { surface: "nurture_auto_drip_event" }, extra: { propertyId } });
    }
  }
  return outcome.status === "enrolled"
    ? { status: "enrolled", sequenceId, enrollmentId: outcome.enrollmentId, firstSendNotBefore: firstSendNotBefore.toISOString() }
    : { status: "already_enrolled", sequenceId };
}
