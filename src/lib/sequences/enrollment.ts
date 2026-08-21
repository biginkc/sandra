import type { SupabaseClient } from "@supabase/supabase-js";

import { getConsentState } from "@/lib/messaging/consent";
import { selectBestSmsPhone } from "@/lib/messaging/sms-phone";
import type { Database } from "@/lib/supabase/types";

import { delayToDate } from "./delays";
import type { PauseReason } from "./pause-rules";

/**
 * Discriminated outcome of `enrollLead`. Callers render a UI toast /
 * alert based on the status; nothing ever throws across the boundary.
 */
export type EnrollmentOutcome =
  | { status: "enrolled"; enrollmentId: string }
  | { status: "duplicate_active" }
  | { status: "no_phone"; message: string }
  | { status: "landline_phone"; message: string }
  | { status: "no_consent"; message: string }
  | { status: "sequence_not_found" }
  | { status: "sequence_inactive" }
  | { status: "property_not_found" }
  | { status: "no_steps" }
  | { status: "failed"; message: string };

export async function enrollLead(
  client: SupabaseClient<Database>,
  params: {
    sequenceId: string;
    propertyId: string;
    enrolledByUserId?: string | null;
  },
): Promise<EnrollmentOutcome> {
  // Load sequence + first step (one round-trip via nested select).
  const { data: seq, error: seqErr } = await client
    .from("sequences")
    .select("id, org_id, active, archived_at")
    .eq("id", params.sequenceId)
    .maybeSingle();
  if (seqErr) return { status: "failed", message: seqErr.message };
  if (!seq) return { status: "sequence_not_found" };
  if (!seq.active || seq.archived_at) return { status: "sequence_inactive" };

  const { data: step0, error: stepErr } = await client
    .from("sequence_steps")
    .select("id, delay_after_previous_minutes")
    .eq("sequence_id", params.sequenceId)
    .eq("step_index", 0)
    .maybeSingle();
  if (stepErr) return { status: "failed", message: stepErr.message };
  if (!step0) return { status: "no_steps" };

  // Load property + its homeowner contact + phone in one round-trip.
  const { data: prop, error: propErr } = await client
    .from("properties")
    .select(
      `id, org_id, homeowner_contact_id,
       homeowner:contacts!properties_homeowner_contact_id_fkey(
         id, phone_1, phone_1_type, phone_2, phone_2_type, phone_3, phone_3_type
       )`,
    )
    .eq("id", params.propertyId)
    .maybeSingle();
  if (propErr) return { status: "failed", message: propErr.message };
  if (!prop) return { status: "property_not_found" };
  if (prop.org_id !== seq.org_id) {
    return {
      status: "failed",
      message: "Sequence and property must belong to the same organization.",
    };
  }

  // PostgREST may return the joined contact as an object or a
  // one-element array — normalize before reading.
  type HomeownerJoin = {
    id: string;
    phone_1: string | null;
    phone_1_type: string | null;
    phone_2: string | null;
    phone_2_type: string | null;
    phone_3: string | null;
    phone_3_type: string | null;
  };
  const rawHomeowner = prop.homeowner as unknown as
    | HomeownerJoin
    | HomeownerJoin[]
    | null;
  const homeowner = Array.isArray(rawHomeowner)
    ? (rawHomeowner[0] ?? null)
    : rawHomeowner;
  const destination = selectBestSmsPhone(homeowner);
  if (!homeowner || !destination) {
    return {
      status: "no_phone",
      message: "Lead has no phone number. Add one (or skip-trace) before enrolling.",
    };
  }
  if (destination.lineType === "landline") {
    return {
      status: "landline_phone",
      message:
        "Lead only has landline numbers — SMS can't be delivered. Call or mail instead.",
    };
  }

  // Consent: don't enroll a lead that's already opted out.
  const consentState = await getConsentState(client, homeowner.id, "sms");
  if (consentState === "opted_out") {
    return {
      status: "no_consent",
      message: "Contact has opted out of SMS. Can't enroll in a send_sms sequence.",
    };
  }

  // Calculate first fire time — delay of step 0 from enrollment moment.
  const nextRunAt = delayToDate(
    step0.delay_after_previous_minutes,
    new Date(),
  );

  // INSERT — unique partial index prevents a second active/paused enrollment
  // on the same (sequence, property) pair; catch 23505 and return a friendly
  // outcome instead of surfacing the raw constraint error.
  const { data: inserted, error: insertErr } = await client
    .from("sequence_enrollments")
    .insert({
      org_id: prop.org_id,
      sequence_id: params.sequenceId,
      property_id: params.propertyId,
      contact_id: homeowner.id,
      status: "active",
      current_step_index: 0,
      next_run_at: nextRunAt.toISOString(),
      enrolled_by_user_id: params.enrolledByUserId ?? null,
    })
    .select("id")
    .single();

  if (insertErr) {
    if (insertErr.code === "23505") {
      return { status: "duplicate_active" };
    }
    return { status: "failed", message: insertErr.message };
  }

  return { status: "enrolled", enrollmentId: inserted.id };
}

/**
 * Pause every active enrollment for a property with the given reason.
 * Called from:
 *   - the Dialpad inbound webhook on a regular reply (reason='inbound_reply')
 *   - the STOP-keyword path (reason='consent_revoked', then caller flips
 *     those rows to 'opted_out' via `status` update — handled here via
 *     the `permanent` flag)
 *
 * Returns the number of enrollments whose state changed.
 */
export async function pausePropertyEnrollments(
  client: SupabaseClient<Database>,
  params: {
    propertyId: string;
    reason: PauseReason;
    permanent?: boolean;
  },
): Promise<{ paused: number }> {
  const newStatus = params.permanent ? "opted_out" : "paused";
  const { error, count } = await client
    .from("sequence_enrollments")
    .update(
      {
        status: newStatus,
        pause_reason: params.reason,
        ...(params.permanent ? { next_run_at: null } : {}),
        updated_at: new Date().toISOString(),
      },
      { count: "exact" },
    )
    .eq("property_id", params.propertyId)
    .eq("status", "active");
  if (error) {
    throw new Error(`pausePropertyEnrollments: ${error.message}`);
  }
  return { paused: count ?? 0 };
}

/** Resume only the enrollments paused by the softphone's active call. */
export async function resumeByProperty(
  client: SupabaseClient<Database>,
  params: { propertyId: string },
): Promise<{ resumed: number }> {
  const { error, count } = await client
    .from("sequence_enrollments")
    .update({
      status: "active",
      pause_reason: null,
      next_run_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { count: "exact" })
    .eq("property_id", params.propertyId)
    .eq("status", "paused")
    .eq("pause_reason", "call_in_progress");
  if (error) throw new Error(`resumeByProperty: ${error.message}`);
  return { resumed: count ?? 0 };
}

/**
 * Pause every active enrollment across ALL properties linked to a
 * contact. Used by the STOP-keyword path in the Dialpad webhook —
 * one STOP text from a seller means "never message me again", and
 * they may have been enrolled via multiple properties.
 */
export async function pauseContactEnrollments(
  client: SupabaseClient<Database>,
  params: {
    contactId: string;
    reason: PauseReason;
    permanent?: boolean;
  },
): Promise<{ paused: number }> {
  const { data: properties, error: propertyError } = await client
    .from("properties")
    .select("id")
    .eq("homeowner_contact_id", params.contactId);
  if (propertyError) {
    throw new Error(`pauseContactEnrollments properties: ${propertyError.message}`);
  }
  const propertyIds = (properties ?? []).map((p) => p.id);
  if (propertyIds.length === 0) return { paused: 0 };

  const newStatus = params.permanent ? "opted_out" : "paused";
  const { error, count } = await client
    .from("sequence_enrollments")
    .update(
      {
        status: newStatus,
        pause_reason: params.reason,
        ...(params.permanent ? { next_run_at: null } : {}),
        updated_at: new Date().toISOString(),
      },
      { count: "exact" },
    )
    .in("property_id", propertyIds)
    .eq("status", "active");
  if (error) {
    throw new Error(`pauseContactEnrollments: ${error.message}`);
  }
  return { paused: count ?? 0 };
}

/**
 * Flip a paused enrollment back to active and reschedule `next_run_at`
 * from now + current step's delay. Does nothing if the enrollment isn't
 * currently `paused` (opted_out is permanent; completed has no more
 * work to do).
 */
export async function resumeEnrollment(
  client: SupabaseClient<Database>,
  enrollmentId: string,
): Promise<
  { status: "resumed" } | { status: "not_paused" } | { status: "failed"; message: string }
> {
  const { data: enrollment, error: loadErr } = await client
    .from("sequence_enrollments")
    .select("id, status, sequence_id, current_step_index")
    .eq("id", enrollmentId)
    .maybeSingle();
  if (loadErr) return { status: "failed", message: loadErr.message };
  if (!enrollment) return { status: "failed", message: "Enrollment not found" };
  if (enrollment.status !== "paused") return { status: "not_paused" };

  const { data: currentStep, error: stepErr } = await client
    .from("sequence_steps")
    .select("delay_after_previous_minutes")
    .eq("sequence_id", enrollment.sequence_id)
    .eq("step_index", enrollment.current_step_index)
    .maybeSingle();
  if (stepErr) return { status: "failed", message: stepErr.message };

  // Step may have been deleted during edit — treat that as "no work left".
  const delay = currentStep?.delay_after_previous_minutes ?? 0;
  const nextRunAt = delayToDate(delay, new Date()).toISOString();

  const { error: updateErr } = await client
    .from("sequence_enrollments")
    .update({
      status: "active",
      pause_reason: null,
      next_run_at: nextRunAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", enrollmentId);
  if (updateErr) return { status: "failed", message: updateErr.message };

  return { status: "resumed" };
}
