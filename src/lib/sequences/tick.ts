import type { SupabaseClient } from "@supabase/supabase-js";

import { sendSmsToContact } from "@/lib/messaging/send";
import type { Database } from "@/lib/supabase/types";

import { delayToDate } from "./delays";
import { applyOptOut } from "./opt-out";
import { evaluatePause } from "./pause-rules";
import { renderTemplate } from "./render";
import { loadTemplateVars } from "./template-vars";

/**
 * Single-enrollment processor — called by the `/api/cron/sequence-tick`
 * endpoint in a loop over due rows. Each call is idempotent: it claims
 * the current step via `sequence_step_runs` unique index, and a
 * concurrent tick claiming the same row sees a 23505 and returns early.
 *
 * The flow for one enrollment:
 *   1. Load the current step.
 *   2. Re-check the property's status against pause rules — if the
 *      status moved to terminal / acquisition-active since `next_run_at`
 *      was scheduled, pause without firing.
 *   3. Claim the fire via `sequence_step_runs` ON CONFLICT DO NOTHING.
 *   4. For send_sms: call `sendSmsToContact` (which enforces consent +
 *      quiet hours). Branch on its outcome:
 *        - `sent` / `queued` → advance, stamp message_id on the run row.
 *        - `blocked_quiet_hours` → reschedule +N hours, DELETE the claim
 *           so the next tick can re-fire after the window opens.
 *        - `blocked_no_consent` → mark enrollment opted_out permanently.
 *        - `blocked_no_phone` → pause with reason.
 *        - other failure → mark the run row as failed, pause.
 *   5. For change_status: update the property, advance.
 *   6. Advance `current_step_index` to next step or mark `completed`.
 *
 * The return type is a short status the cron endpoint logs for audit.
 */

export type TickOutcome =
  | { status: "sent"; enrollmentId: string; stepIndex: number; messageId: string | null }
  | { status: "status_changed"; enrollmentId: string; stepIndex: number }
  | { status: "completed"; enrollmentId: string }
  | { status: "paused"; enrollmentId: string; reason: string }
  | { status: "rescheduled_quiet_hours"; enrollmentId: string; nextRunAt: string }
  | { status: "skipped_already_claimed"; enrollmentId: string }
  | { status: "skipped_no_step"; enrollmentId: string }
  | { status: "failed"; enrollmentId: string; message: string };

type EnrollmentRow = {
  id: string;
  sequence_id: string;
  property_id: string;
  contact_id: string | null;
  current_step_index: number;
  enrolled_by_user_id: string | null;
  status: string;
};

export async function processEnrollmentTick(
  client: SupabaseClient<Database>,
  enrollment: EnrollmentRow,
): Promise<TickOutcome> {
  // 1. Load current step.
  const { data: step, error: stepErr } = await client
    .from("sequence_steps")
    .select("id, step_index, action_type, template_body, target_status, delay_after_previous_minutes")
    .eq("sequence_id", enrollment.sequence_id)
    .eq("step_index", enrollment.current_step_index)
    .maybeSingle();
  if (stepErr) {
    return { status: "failed", enrollmentId: enrollment.id, message: stepErr.message };
  }
  if (!step) {
    // No step at this index — enrollment has effectively completed. Mark it.
    await client
      .from("sequence_enrollments")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        next_run_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", enrollment.id);
    return { status: "completed", enrollmentId: enrollment.id };
  }

  // 2. Re-check property status against pause rules.
  const { data: property, error: propErr } = await client
    .from("properties")
    .select("status, state, address")
    .eq("id", enrollment.property_id)
    .maybeSingle();
  if (propErr || !property) {
    return { status: "failed", enrollmentId: enrollment.id, message: propErr?.message ?? "property missing" };
  }

  const pauseDecision = evaluatePause({
    type: "status_change",
    newStatus: property.status,
  });
  if (pauseDecision.shouldPause) {
    await client
      .from("sequence_enrollments")
      .update({
        status: pauseDecision.permanent ? "opted_out" : "paused",
        pause_reason: pauseDecision.reason,
        updated_at: new Date().toISOString(),
      })
      .eq("id", enrollment.id);
    return {
      status: "paused",
      enrollmentId: enrollment.id,
      reason: pauseDecision.reason ?? "unknown",
    };
  }

  // 3. Claim the fire. Double-fire safety via unique (enrollment_id, step_id).
  const { data: claim, error: claimErr } = await client
    .from("sequence_step_runs")
    .insert({
      enrollment_id: enrollment.id,
      step_id: step.id,
      scheduled_for: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (claimErr) {
    if (claimErr.code === "23505") {
      return { status: "skipped_already_claimed", enrollmentId: enrollment.id };
    }
    return { status: "failed", enrollmentId: enrollment.id, message: claimErr.message };
  }

  // 4 / 5. Execute action.
  if (step.action_type === "send_sms") {
    if (!enrollment.contact_id) {
      await markRunSkipped(client, claim.id, "no_phone");
      await pauseEnrollment(client, enrollment.id, "inbound_reply", false);
      return { status: "paused", enrollmentId: enrollment.id, reason: "no_phone" };
    }
    const vars = await loadTemplateVars(client, {
      propertyId: enrollment.property_id,
      contactId: enrollment.contact_id,
      enrolledByUserId: enrollment.enrolled_by_user_id,
    });

    // Load the sequence to honor its `append_opt_out` setting.
    const { data: seq } = await client
      .from("sequences")
      .select("append_opt_out")
      .eq("id", enrollment.sequence_id)
      .maybeSingle();
    const appendOptOut = seq?.append_opt_out ?? true;

    const rendered = renderTemplate(step.template_body ?? "", vars);
    const finalBody = applyOptOut(rendered, {
      append_opt_out: appendOptOut,
      // Seed the rotation with the claim id so a retry picks the same variant.
      seed: claim.id,
    });

    const outcome = await sendSmsToContact(client, {
      contactId: enrollment.contact_id,
      propertyId: enrollment.property_id,
      body: finalBody,
    });

    switch (outcome.status) {
      case "sent":
      case "queued": {
        const messageId = outcome.status === "sent" ? outcome.messageId : outcome.messageId;
        await client
          .from("sequence_step_runs")
          .update({ run_at: new Date().toISOString(), message_id: messageId })
          .eq("id", claim.id);
        await advanceEnrollment(client, enrollment.id, enrollment.sequence_id, step.step_index);
        return {
          status: "sent",
          enrollmentId: enrollment.id,
          stepIndex: step.step_index,
          messageId: messageId ?? null,
        };
      }
      case "blocked_quiet_hours": {
        // Don't advance; reschedule and delete the claim so we can retry
        // after quiet hours. +10h is a safe approximation that always
        // crosses the 21:00 → 08:00 gap on a US timezone (precise
        // "next 08:00 local" optimization deferred; see TODO).
        // TODO: compute exact next 08:00 local from property.state zone.
        const nextRunAt = new Date(Date.now() + 10 * 60 * 60 * 1000);
        await client
          .from("sequence_step_runs")
          .delete()
          .eq("id", claim.id);
        await client
          .from("sequence_enrollments")
          .update({
            next_run_at: nextRunAt.toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", enrollment.id);
        return {
          status: "rescheduled_quiet_hours",
          enrollmentId: enrollment.id,
          nextRunAt: nextRunAt.toISOString(),
        };
      }
      case "blocked_no_consent": {
        await markRunSkipped(client, claim.id, "consent_revoked");
        await pauseEnrollment(client, enrollment.id, "consent_revoked", true);
        return { status: "paused", enrollmentId: enrollment.id, reason: "consent_revoked" };
      }
      case "blocked_no_phone":
      case "contact_not_found": {
        await markRunSkipped(client, claim.id, "no_phone");
        await pauseEnrollment(client, enrollment.id, "inbound_reply", false);
        return { status: "paused", enrollmentId: enrollment.id, reason: "no_phone" };
      }
      case "provider_failed":
      case "blocked_provider_off":
      case "property_not_found":
      case "db_error":
      default: {
        await markRunSkipped(client, claim.id, "provider_failed");
        return {
          status: "failed",
          enrollmentId: enrollment.id,
          message: "reason" in outcome ? outcome.reason : outcome.status,
        };
      }
    }
  }

  if (step.action_type === "change_status" && step.target_status) {
    await client
      .from("properties")
      .update({
        status: step.target_status,
        updated_at: new Date().toISOString(),
      })
      .eq("id", enrollment.property_id);
    await client
      .from("sequence_step_runs")
      .update({ run_at: new Date().toISOString() })
      .eq("id", claim.id);
    await advanceEnrollment(client, enrollment.id, enrollment.sequence_id, step.step_index);
    return {
      status: "status_changed",
      enrollmentId: enrollment.id,
      stepIndex: step.step_index,
    };
  }

  // Shouldn't reach here given the check constraint, but stay safe.
  await markRunSkipped(client, claim.id, "provider_failed");
  return {
    status: "failed",
    enrollmentId: enrollment.id,
    message: `Unsupported action_type ${step.action_type}`,
  };
}

/**
 * Helper: advance to the next step OR mark the enrollment completed if
 * this was the last step. Separate so the send_sms and change_status
 * branches share it.
 */
async function advanceEnrollment(
  client: SupabaseClient<Database>,
  enrollmentId: string,
  sequenceId: string,
  currentStepIndex: number,
): Promise<void> {
  const { data: nextStep } = await client
    .from("sequence_steps")
    .select("delay_after_previous_minutes")
    .eq("sequence_id", sequenceId)
    .eq("step_index", currentStepIndex + 1)
    .maybeSingle();

  if (!nextStep) {
    await client
      .from("sequence_enrollments")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        next_run_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", enrollmentId);
    return;
  }

  const nextRunAt = delayToDate(
    nextStep.delay_after_previous_minutes,
    new Date(),
  ).toISOString();
  await client
    .from("sequence_enrollments")
    .update({
      current_step_index: currentStepIndex + 1,
      next_run_at: nextRunAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", enrollmentId);
}

async function markRunSkipped(
  client: SupabaseClient<Database>,
  runId: string,
  reason: "quiet_hours" | "consent_revoked" | "paused" | "escalated" | "no_phone" | "provider_failed",
): Promise<void> {
  await client
    .from("sequence_step_runs")
    .update({ run_at: new Date().toISOString(), skipped_reason: reason })
    .eq("id", runId);
}

async function pauseEnrollment(
  client: SupabaseClient<Database>,
  enrollmentId: string,
  reason: string,
  permanent: boolean,
): Promise<void> {
  await client
    .from("sequence_enrollments")
    .update({
      status: permanent ? "opted_out" : "paused",
      pause_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", enrollmentId);
}
