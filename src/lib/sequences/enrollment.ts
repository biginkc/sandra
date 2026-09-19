import { assertNotTrainingTarget } from "@/lib/leads/training";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getConsentState } from "@/lib/messaging/consent";
import { selectBestSmsPhone } from "@/lib/messaging/sms-phone";
import type { Database } from "@/lib/supabase/types";
import {
  LEAD_EVENT_TYPES,
  recordLeadEvent,
  recordLeadEvents,
} from "@/lib/events";

import { delayToDate } from "./delays";
import type { PauseReason } from "./pause-rules";

export type SequenceEventActor =
  | { actorType: "user"; actorId: string }
  | { actorType: "ai" | "system"; actorId?: never };

const SYSTEM_ACTOR = { actorType: "system" } as const;

/**
 * Discriminated outcome of `enrollLead`. Callers render a UI toast /
 * alert based on the status; nothing ever throws across the boundary.
 */
export type EnrollmentOutcome =
  | { status: "enrolled"; enrollmentId: string; sequenceLabel: string }
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
    deferEvent?: boolean;
  },
): Promise<EnrollmentOutcome> {
  await assertNotTrainingTarget(client, { propertyId: params.propertyId });
  // Load sequence + first step (one round-trip via nested select).
  const { data: seq, error: seqErr } = await client
    .from("sequences")
    .select("id, org_id, name, active, archived_at")
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
    HomeownerJoin | HomeownerJoin[] | null;
  const homeowner = Array.isArray(rawHomeowner)
    ? (rawHomeowner[0] ?? null)
    : rawHomeowner;
  const destination = selectBestSmsPhone(homeowner);
  if (!homeowner || !destination) {
    return {
      status: "no_phone",
      message:
        "Lead has no phone number. Add one (or skip-trace) before enrolling.",
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
      message:
        "Contact has opted out of SMS. Can't enroll in a send_sms sequence.",
    };
  }

  // Calculate first fire time — delay of step 0 from enrollment moment.
  const nextRunAt = delayToDate(step0.delay_after_previous_minutes, new Date());

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

  if (!params.deferEvent) {
    const actor: SequenceEventActor = params.enrolledByUserId
      ? { actorType: "user", actorId: params.enrolledByUserId }
      : SYSTEM_ACTOR;
    await recordLeadEvent({
      propertyId: params.propertyId,
      ...actor,
      eventType: LEAD_EVENT_TYPES.SEQUENCE_ENROLLED,
      payload: {
        enrollment_id: inserted.id,
        sequence_id: params.sequenceId,
        label: seq.name,
      },
      sourceType: "sequence_enrollments.created",
      sourceId: inserted.id,
    });
  }

  return {
    status: "enrolled",
    enrollmentId: inserted.id,
    sequenceLabel: seq.name,
  };
}

/**
 * Pause every active enrollment for a property with the given reason.
 * Called from:
 *   - the inbound webhook on a regular reply (reason='inbound_reply')
 *   - the inbound webhook on a reply to an audited rep SMS
 *     (reason='rep_sms_human_takeover')
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
    actor?: SequenceEventActor;
  },
): Promise<{ paused: number }> {
  const newStatus = params.permanent ? "opted_out" : "paused";
  let pauseQuery = client
    .from("sequence_enrollments")
    .update({
      status: newStatus,
      pause_reason: params.reason,
      ...(params.permanent ? { next_run_at: null } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("property_id", params.propertyId);
  pauseQuery = params.permanent
    ? pauseQuery.in("status", ["active", "paused"])
    : pauseQuery.eq("status", "active");
  const { data: pausedRows, error } = await pauseQuery.select("id, sequence_id");
  if (error) {
    throw new Error(`pausePropertyEnrollments: ${error.message}`);
  }
  const paused = pausedRows?.length ?? 0;
  if (paused > 0) {
    await recordLeadEvent({
      propertyId: params.propertyId,
      ...(params.actor ?? SYSTEM_ACTOR),
      eventType: LEAD_EVENT_TYPES.SEQUENCE_PAUSED,
      payload: {
        count: paused,
        sequence_ids: [
          ...new Set((pausedRows ?? []).map((row) => row.sequence_id)),
        ],
        reason: params.reason,
        permanent: params.permanent === true,
      },
    });
  }
  return { paused };
}

/**
 * Promote an already-paused inbound reply to the more specific reason that
 * was discovered after the webhook's fail-safe pause. This is intentionally
 * narrow: a retry or a concurrent webhook may have paused the row with the
 * generic inbound reason, and a confirmed rep-SMS takeover must be able to
 * correct that durable read model without reopening the enrollment.
 */
export async function promotePropertyEnrollmentPauseReason(
  client: SupabaseClient<Database>,
  params: {
    propertyId: string;
    fromReason: PauseReason;
    reason: PauseReason;
  },
): Promise<{ promoted: number }> {
  const { data: promotedRows, error } = await client
    .from("sequence_enrollments")
    .update({
      pause_reason: params.reason,
      updated_at: new Date().toISOString(),
    })
    .eq("property_id", params.propertyId)
    .eq("status", "paused")
    .eq("pause_reason", params.fromReason)
    .select("id");
  if (error) {
    throw new Error(`promotePropertyEnrollmentPauseReason: ${error.message}`);
  }
  return { promoted: promotedRows?.length ?? 0 };
}

/** Resume only the enrollments paused by the softphone's active call. */
export async function resumeByProperty(
  client: SupabaseClient<Database>,
  params: { propertyId: string; actor?: SequenceEventActor },
): Promise<{ resumed: number }> {
  await assertNotTrainingTarget(client, { propertyId: params.propertyId });
  const { data: pausedRows, error } = await client
    .from("sequence_enrollments")
    .select("id, sequence_id")
    .eq("property_id", params.propertyId)
    .eq("status", "paused")
    .eq("pause_reason", "call_in_progress");
  if (error) throw new Error(`resumeByProperty: ${error.message}`);
  const actor = params.actor ?? SYSTEM_ACTOR;
  const resumedRows: Array<{ id: string; sequence_id: string }> = [];
  for (const row of pausedRows ?? []) {
    const { data, error: resumeError } = await client.rpc(
      "resume_sequence_enrollment",
      {
        p_enrollment_id: row.id,
        p_actor_user_id: actor.actorType === "user" ? actor.actorId : null,
      },
    );
    if (resumeError) throw new Error(`resumeByProperty: ${resumeError.message}`);
    if (data?.[0]?.outcome === "resumed") resumedRows.push(row);
  }
  const resumed = resumedRows.length;
  if (resumed > 0) {
    await recordLeadEvent({
      propertyId: params.propertyId,
      ...actor,
      eventType: LEAD_EVENT_TYPES.SEQUENCE_RESUMED,
      payload: {
        count: resumed,
        sequence_ids: [
          ...new Set((resumedRows ?? []).map((row) => row.sequence_id)),
        ],
        reason: "call_in_progress_cleared",
      },
    });
  }
  return { resumed };
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
    actor?: SequenceEventActor;
  },
): Promise<{ paused: number }> {
  const { data: properties, error: propertyError } = await client
    .from("properties")
    .select("id")
    .eq("homeowner_contact_id", params.contactId);
  if (propertyError) {
    throw new Error(
      `pauseContactEnrollments properties: ${propertyError.message}`,
    );
  }
  const propertyIds = (properties ?? []).map((p) => p.id);
  if (propertyIds.length === 0) return { paused: 0 };

  const newStatus = params.permanent ? "opted_out" : "paused";
  let pauseQuery = client
    .from("sequence_enrollments")
    .update({
      status: newStatus,
      pause_reason: params.reason,
      ...(params.permanent ? { next_run_at: null } : {}),
      updated_at: new Date().toISOString(),
    })
    .in("property_id", propertyIds);
  pauseQuery = params.permanent
    ? pauseQuery.in("status", ["active", "paused"])
    : pauseQuery.eq("status", "active");
  const { data: pausedRows, error } = await pauseQuery.select("id, property_id, sequence_id");
  if (error) {
    throw new Error(`pauseContactEnrollments: ${error.message}`);
  }
  const paused = pausedRows?.length ?? 0;
  const grouped = new Map<string, Array<{ id: string; sequence_id: string }>>();
  for (const row of pausedRows ?? []) {
    const rows = grouped.get(row.property_id) ?? [];
    rows.push(row);
    grouped.set(row.property_id, rows);
  }
  if (grouped.size > 0) {
    const batchId = grouped.size > 1 ? crypto.randomUUID() : null;
    await recordLeadEvents(
      [...grouped.entries()].map(([propertyId, rows]) => ({
        propertyId,
        ...(params.actor ?? SYSTEM_ACTOR),
        eventType: LEAD_EVENT_TYPES.SEQUENCE_PAUSED,
        payload: {
          count: rows.length,
          sequence_ids: [...new Set(rows.map((row) => row.sequence_id))],
          reason: params.reason,
          permanent: params.permanent === true,
          ...(batchId ? { batch_id: batchId, batch_count: grouped.size } : {}),
        },
      })),
    );
  }
  return { paused };
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
  actor: SequenceEventActor = SYSTEM_ACTOR,
): Promise<
  | { status: "resumed" }
  | { status: "not_paused" }
  | { status: "reconciliation_required" }
  | { status: "failed"; message: string }
> {
  const { data: enrollment, error: loadErr } = await client
    .from("sequence_enrollments")
    .select("id, status, sequence_id, property_id, current_step_index, pause_reason")
    .eq("id", enrollmentId)
    .maybeSingle();
  if (loadErr) return { status: "failed", message: loadErr.message };
  if (!enrollment) return { status: "failed", message: "Enrollment not found" };
  await assertNotTrainingTarget(client, { propertyId: enrollment.property_id });
  if (enrollment.status !== "paused") return { status: "not_paused" };
  // A provider attempt that may have reached the provider is never made
  // retryable by a normal resume. The explicit retry RPC below is restricted
  // to claims proven not_attempted/definitively_rejected.
  if (
    enrollment.pause_reason === "reconciliation_required" ||
    enrollment.pause_reason === "provider_failed"
  ) {
    return { status: "reconciliation_required" };
  }
  const { data: resumed, error: resumeError } = await client.rpc(
    "resume_sequence_enrollment",
    {
      p_enrollment_id: enrollmentId,
      p_actor_user_id: actor.actorType === "user" ? actor.actorId : null,
    },
  );
  if (resumeError) return { status: "failed", message: resumeError.message };
  const resumeResult = resumed?.[0];
  if (!resumeResult || resumeResult.outcome === "not_found") {
    return { status: "failed", message: "Enrollment not found" };
  }
  if (resumeResult.outcome === "not_paused") return { status: "not_paused" };
  if (
    resumeResult.outcome === "reconciliation_required" ||
    resumeResult.outcome === "retry_required"
  ) {
    return { status: "reconciliation_required" };
  }
  if (resumeResult.outcome !== "resumed") {
    return { status: "failed", message: "Enrollment resume was not authorized" };
  }
  const nextRunAt = resumeResult.next_run_at;
  if (!nextRunAt) return { status: "failed", message: "Enrollment resume did not schedule a next run" };

  await recordLeadEvent({
    propertyId: enrollment.property_id,
    ...actor,
    eventType: LEAD_EVENT_TYPES.SEQUENCE_RESUMED,
    payload: {
      enrollment_id: enrollmentId,
      sequence_id: enrollment.sequence_id,
      next_run_at: nextRunAt,
    },
  });

  return { status: "resumed" };
}

/**
 * Explicitly retry a sequence step only after its active claim is proven
 * `not_attempted` or `definitively_rejected`. The RPC retires that claim and
 * creates a new audited claim atomically; accepted/unknown claims remain
 * reconciliation-only.
 */
export async function retrySequenceStep(
  client: SupabaseClient<Database>,
  enrollmentId: string,
  actor: SequenceEventActor = SYSTEM_ACTOR,
): Promise<
  | { status: "retried" }
  | { status: "reconciliation_required" }
  | { status: "not_found" }
  | { status: "failed"; message: string }
> {
  const { data, error } = await client.rpc("retry_sequence_step", {
    p_enrollment_id: enrollmentId,
    p_actor_user_id: actor.actorType === "user" ? actor.actorId : null,
  });
  if (error) return { status: "failed", message: error.message };
  const result = data?.[0];
  if (!result || result.outcome === "not_found") return { status: "not_found" };
  if (result.outcome === "not_authorized") {
    return { status: "failed", message: "Enrollment retry was not authorized." };
  }
  if (result.outcome !== "retried") return { status: "reconciliation_required" };

  const { data: enrollment, error: loadError } = await client
    .from("sequence_enrollments")
    .select("property_id, sequence_id")
    .eq("id", enrollmentId)
    .maybeSingle();
  if (loadError || !enrollment) {
    return {
      status: "failed",
      message: loadError?.message ?? "Enrollment disappeared after retry.",
    };
  }
  await recordLeadEvent({
    propertyId: enrollment.property_id,
    ...actor,
    eventType: LEAD_EVENT_TYPES.SEQUENCE_RESUMED,
    payload: {
      enrollment_id: enrollmentId,
      sequence_id: enrollment.sequence_id,
      reason: "explicit_sequence_step_retry",
      step_index: result.step_index,
    },
  });
  return { status: "retried" };
}
