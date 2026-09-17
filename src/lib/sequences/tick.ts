import type { SupabaseClient } from "@supabase/supabase-js";

import {
  sendSmsToContact,
  type SequenceAttemptOutcome,
} from "@/lib/messaging/send";
import { shouldSuppressAutomatedSend } from "@/lib/messaging/suppression";
import type { Database } from "@/lib/supabase/types";
import { pickFromPool } from "@/lib/templates/pool";

import { delayToDate } from "./delays";
import { applyOptOut } from "./opt-out";
import { evaluatePause } from "./pause-rules";
import { renderTemplate } from "./render";
import { loadTemplateVars } from "./template-vars";

const FIRST_TOUCH_SENDER_PAUSE_REASON =
  "no approved sender for first-touch sequence send";

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
 *        - `blocked_quiet_hours` → reschedule +N hours, retire the claim only through a proof-gated update
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

/** A live provider attempt gets this long before requiring reconciliation. */
export const SEQUENCE_CLAIM_STALE_MS = 15 * 60_000;

type EnrollmentRow = {
  id: string;
  org_id: string;
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
    .select("id, step_index, action_type, template_body, template_id, template_category, target_status, delay_after_previous_minutes")
    .eq("sequence_id", enrollment.sequence_id)
    .eq("step_index", enrollment.current_step_index)
    .maybeSingle();
  if (stepErr) {
    return { status: "failed", enrollmentId: enrollment.id, message: stepErr.message };
  }
  if (!step) {
    // No step at this index — enrollment has effectively completed. Mark it.
    const { data: completed, error: completionError } = await client
      .from("sequence_enrollments")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        next_run_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", enrollment.id)
      .eq("status", "active")
      .eq("current_step_index", enrollment.current_step_index)
      .select("id")
      .maybeSingle();
    if (completionError || !completed) {
      return {
        status: "failed",
        enrollmentId: enrollment.id,
        message: completionError?.message ?? "enrollment changed before completion",
      };
    }
    return { status: "completed", enrollmentId: enrollment.id };
  }

  // 2. Re-check property status against pause rules.
  const { data: property, error: propErr } = await client
    .from("properties")
    .select("status, state, address, outreach_dispo, is_dnc_locked")
    .eq("id", enrollment.property_id)
    .maybeSingle();
  if (propErr || !property) {
    return { status: "failed", enrollmentId: enrollment.id, message: propErr?.message ?? "property missing" };
  }

  if (property.is_dnc_locked) {
    const pauseError = await pauseEnrollment(client, enrollment.id, "dnc", true);
    if (pauseError) {
      return {
        status: "failed",
        enrollmentId: enrollment.id,
        message: pauseError,
      };
    }
    return {
      status: "paused",
      enrollmentId: enrollment.id,
      reason: "dnc",
    };
  }

  // Disqualifying outreach dispos pause sequences — either permanently
  // (opted out, DNC, bad number: SUPPRESSED_DISPOS) or resumably (a
  // human-owned outcome — nurture/callback_requested/booked_appointment —
  // via HUMAN_OWNED_DISPOS, folded in by shouldSuppressAutomatedSend). A
  // booked appointment reaching this far means the tick fired between
  // booking and the enrollment's own pause landing (best-effort, fired
  // from bookAppointment's post-RPC path) — this is the safety net that
  // still catches it.
  if (
    property.outreach_dispo &&
    shouldSuppressAutomatedSend({ outreachDispo: property.outreach_dispo })
  ) {
    const permanent = property.outreach_dispo === "dnc" || property.outreach_dispo === "opted_out";
    const pauseError = await pauseEnrollment(
      client,
      enrollment.id,
      property.outreach_dispo,
      permanent,
    );
    if (pauseError) {
      return {
        status: "failed",
        enrollmentId: enrollment.id,
        message: pauseError,
      };
    }
    return {
      status: "paused",
      enrollmentId: enrollment.id,
      reason: property.outreach_dispo,
    };
  }

  const pauseDecision = evaluatePause({
    type: "status_change",
    newStatus: property.status,
  });
  if (pauseDecision.shouldPause) {
    const pauseError = await pauseEnrollment(
      client,
      enrollment.id,
      pauseDecision.reason ?? "status_change",
      pauseDecision.permanent,
    );
    if (pauseError) {
      return {
        status: "failed",
        enrollmentId: enrollment.id,
        message: pauseError,
      };
    }
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
      attempt_outcome: "not_attempted",
    })
    .select("id")
    .single();
  if (claimErr) {
    if (claimErr.code === "23505") {
      const { data: existingClaim, error: existingClaimError } = await client
        .from("sequence_step_runs")
        .select("id")
        .eq("enrollment_id", enrollment.id)
        .eq("step_id", step.id)
        .eq("claim_active", true)
        .maybeSingle();
      if (existingClaimError || !existingClaim) {
        return {
          status: "failed",
          enrollmentId: enrollment.id,
          message: existingClaimError?.message ?? "active sequence claim disappeared",
        };
      }
      const { data: staleResult, error: staleError } = await client.rpc(
        "retire_stale_sequence_claim",
        {
          p_enrollment_id: enrollment.id,
          p_step_id: step.id,
          p_claim_id: existingClaim.id,
          p_stale_before: new Date(Date.now() - SEQUENCE_CLAIM_STALE_MS).toISOString(),
        },
      );
      if (staleError) {
        return { status: "failed", enrollmentId: enrollment.id, message: staleError.message };
      }
      const staleOutcome = staleResult?.[0]?.outcome;
      if (staleOutcome === "retired") {
        return { status: "paused", enrollmentId: enrollment.id, reason: "provider_failed" };
      }
      if (staleOutcome === "reconciliation_required") {
        return {
          status: "paused",
          enrollmentId: enrollment.id,
          reason: "reconciliation_required",
        };
      }
      return { status: "skipped_already_claimed", enrollmentId: enrollment.id };
    }
    return { status: "failed", enrollmentId: enrollment.id, message: claimErr.message };
  }

  // 4 / 5. Execute action.
  if (step.action_type === "send_sms") {
    if (!enrollment.contact_id) {
      const runError = await markRunSkipped(client, claim.id, "no_phone");
      if (runError) {
        return failAfterRunWrite(
          client,
          enrollment.id,
          runError,
          "No-phone sequence bookkeeping failed",
        );
      }
      const pauseError = await pauseEnrollment(
        client,
        enrollment.id,
        "inbound_reply",
        false,
      );
      if (pauseError) {
        return { status: "failed", enrollmentId: enrollment.id, message: pauseError };
      }
      return { status: "paused", enrollmentId: enrollment.id, reason: "no_phone" };
    }
    const vars = await loadTemplateVars(client, {
      propertyId: enrollment.property_id,
      contactId: enrollment.contact_id,
    });

    // Load the sequence to honor its `append_opt_out` setting.
    const { data: seq } = await client
      .from("sequences")
      .select("append_opt_out")
      .eq("id", enrollment.sequence_id)
      .maybeSingle();
    const appendOptOut = seq?.append_opt_out ?? true;

    // Resolve the body source. A template reference takes precedence over
    // inline copy — they're mutually exclusive at write time. If the
    // referenced template was soft-deleted while the enrollment was in
    // flight, pause the enrollment with reason "template_missing" so the
    // author can fix it instead of silently looping on failure.
    let bodySource: string;
    if (step.template_id) {
        const { data: tmpl, error: tmplErr } = await client
          .from("sms_templates")
          .select("content")
          .eq("id", step.template_id)
          .eq("org_id", enrollment.org_id)
          .is("deleted_at", null)
          .maybeSingle();
      if (tmplErr) {
        const runError = await markRunSkipped(client, claim.id, "provider_failed");
        if (runError) {
          return failAfterRunWrite(client, enrollment.id, runError, "Template fetch bookkeeping failed");
        }
        return {
          status: "failed",
          enrollmentId: enrollment.id,
          message: `template_fetch: ${tmplErr.message}`,
        };
      }
      if (!tmpl) {
        const runError = await markRunSkipped(client, claim.id, "provider_failed");
        if (runError) {
          return failAfterRunWrite(client, enrollment.id, runError, "Missing-template bookkeeping failed");
        }
        const pauseError = await pauseEnrollment(
          client,
          enrollment.id,
          "template_missing",
          false,
        );
        if (pauseError) {
          return { status: "failed", enrollmentId: enrollment.id, message: pauseError };
        }
        return {
          status: "paused",
          enrollmentId: enrollment.id,
          reason: "template_missing",
        };
      }
      bodySource = tmpl.content;
    } else if (step.template_category) {
      const poolTemplate = await pickFromPool(
        client,
        enrollment.org_id,
        step.template_category,
        enrollment.id,
      );
      if (!poolTemplate) {
        const runError = await markRunSkipped(client, claim.id, "provider_failed");
        if (runError) {
          return failAfterRunWrite(client, enrollment.id, runError, "Template-pool bookkeeping failed");
        }
        const pauseError = await pauseEnrollment(
          client,
          enrollment.id,
          "step_misconfigured",
          false,
        );
        if (pauseError) {
          return { status: "failed", enrollmentId: enrollment.id, message: pauseError };
        }
        return {
          status: "paused",
          enrollmentId: enrollment.id,
          reason: "step_misconfigured",
        };
      }
      bodySource = poolTemplate.content;
    } else {
      bodySource = step.template_body ?? "";
    }

    // Defense-in-depth: schema check constraint
    // `sequence_steps_send_sms_body_xor` (migration 035) rejects rows that
    // would land here with an empty bodySource, but we re-check at runtime
    // in case the constraint was somehow bypassed (e.g. constraint dropped
    // via a hot-fix, or template content was hand-edited to whitespace).
    // Pause the enrollment with `step_misconfigured` so the author can fix
    // it instead of sending an empty SMS the provider would silently bill.
    if (!bodySource.trim()) {
      const runError = await markRunSkipped(client, claim.id, "provider_failed");
      if (runError) {
        return failAfterRunWrite(client, enrollment.id, runError, "Misconfigured-step bookkeeping failed");
      }
      const pauseError = await pauseEnrollment(
        client,
        enrollment.id,
        "step_misconfigured",
        false,
      );
      if (pauseError) {
        return { status: "failed", enrollmentId: enrollment.id, message: pauseError };
      }
      return {
        status: "paused",
        enrollmentId: enrollment.id,
        reason: "step_misconfigured",
      };
    }

    const rendered = renderTemplate(bodySource, vars);
    const finalBody = applyOptOut(rendered, {
      append_opt_out: appendOptOut,
      // Seed the rotation with the claim id so a retry picks the same variant.
      seed: claim.id,
    });

    const outcome = await sendSmsToContact(client, {
      origin: "automated",
      contactId: enrollment.contact_id,
      propertyId: enrollment.property_id,
      body: finalBody,
      requireStickyFrom: true,
      allowDefaultFromWhenNoSticky: true,
      requiresOpeningIdentity:
        step.step_index === 0 && step.template_category === "Opener - Homeowner",
      sequenceContext: {
        enrollmentId: enrollment.id,
        stepId: step.id,
        claimId: claim.id,
      },
    });

    switch (outcome.status) {
      case "sent":
      case "queued": {
        const messageId = outcome.messageId;
        const { data: runWrite, error: runError } = await client
          .from("sequence_step_runs")
          .update({
            run_at: new Date().toISOString(),
            message_id: messageId,
            attempt_outcome: "accepted",
            failure_reason: null,
          })
          .eq("id", claim.id)
          .select("id")
          .maybeSingle();
        // The message has already been accepted. Keep the unique claim even
        // on bookkeeping failure: releasing it could send the same SMS twice.
        if (runError || !runWrite) {
          const pauseError = await pauseEnrollment(
            client,
            enrollment.id,
            "reconciliation_required",
            false,
          );
          return {
            status: "failed",
            enrollmentId: enrollment.id,
            message: `Message ${messageId} accepted; run write failed: ${runError?.message ?? "no run row updated"}${pauseError ? `; ${pauseError}` : ""}`,
          };
        }
        const advanceError = await advanceEnrollment(client, enrollment.id, enrollment.sequence_id, step.step_index);
        if (advanceError) {
          const pauseError = await pauseEnrollment(
            client,
            enrollment.id,
            "reconciliation_required",
            false,
          );
          return {
            status: "failed",
            enrollmentId: enrollment.id,
            message: `Message ${messageId} accepted; ${advanceError}${pauseError ? `; ${pauseError}` : ""}`,
          };
        }
        return {
          status: "sent",
          enrollmentId: enrollment.id,
          stepIndex: step.step_index,
          messageId: messageId ?? null,
        };
      }
      case "blocked_quiet_hours": {
        // Don't advance; retire only this proven no-attempt claim so we can retry after quiet hours.
        // +10h is a safe approximation that always
        // crosses the 21:00 → 08:00 gap on a US timezone (precise
        // "next 08:00 local" optimization deferred; see TODO).
        // TODO: compute exact next 08:00 local from property.state zone.
        const nextRunAt = new Date(Date.now() + 10 * 60 * 60 * 1000);
        const { data: retiredQuietClaim, error: quietClaimError } = await client
          .from("sequence_step_runs")
          .update({
            claim_active: false,
            run_at: new Date().toISOString(),
            skipped_reason: "quiet_hours",
            attempt_outcome: "not_attempted",
            recovery_action: "quiet_hours_deferred",
            recovery_evidence: "provider was not authorized during quiet hours",
          })
          .eq("id", claim.id)
          .eq("claim_active", true)
          .eq("attempt_outcome", "not_attempted")
          .select("id")
          .maybeSingle();
        if (quietClaimError || !retiredQuietClaim) {
          return failAfterRunWrite(
            client,
            enrollment.id,
            quietClaimError?.message ?? "quiet-hours claim changed before retirement",
            "Quiet-hours claim bookkeeping failed",
          );
        }
        const { data: rescheduled, error: rescheduleError } = await client
          .from("sequence_enrollments")
          .update({
            next_run_at: nextRunAt.toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", enrollment.id)
          .eq("status", "active")
          .eq("current_step_index", enrollment.current_step_index)
          .select("id")
          .maybeSingle();
        if (rescheduleError || !rescheduled) {
          return {
            status: "failed",
            enrollmentId: enrollment.id,
            message:
              rescheduleError?.message ??
              "Enrollment changed before quiet-hours reschedule",
          };
        }
        return {
          status: "rescheduled_quiet_hours",
          enrollmentId: enrollment.id,
          nextRunAt: nextRunAt.toISOString(),
        };
      }
      case "blocked_no_consent": {
        const runError = await markRunSkipped(client, claim.id, "consent_revoked", "definitively_rejected");
        if (runError) {
          return failAfterRunWrite(client, enrollment.id, runError, "Consent-revocation bookkeeping failed");
        }
        const pauseError = await pauseEnrollment(
          client,
          enrollment.id,
          "consent_revoked",
          true,
        );
        if (pauseError) {
          return { status: "failed", enrollmentId: enrollment.id, message: pauseError };
        }
        return { status: "paused", enrollmentId: enrollment.id, reason: "consent_revoked" };
      }
      case "blocked_terminal_dispo":
      case "blocked_automated_suppressed": {
        const runError = await markRunSkipped(client, claim.id, "paused", "definitively_rejected");
        if (runError) {
          return failAfterRunWrite(client, enrollment.id, runError, "Suppression bookkeeping failed");
        }
        const permanent =
          outcome.source === "consent_state" ||
          outcome.source === "sms_opted_out" ||
          outcome.source === "do_not_contact" ||
          outcome.source === "phone_suppression" ||
          outcome.outreachDispo === "dnc" ||
          outcome.outreachDispo === "opted_out";
        const pauseError = await pauseEnrollment(
          client,
          enrollment.id,
          permanent ? "consent_revoked" : "terminal_dispo",
          permanent,
        );
        if (pauseError) {
          return { status: "failed", enrollmentId: enrollment.id, message: pauseError };
        }
        return { status: "paused", enrollmentId: enrollment.id, reason: "terminal_dispo" };
      }
      case "blocked_no_phone":
      case "contact_not_found": {
        const runError = await markRunSkipped(client, claim.id, "no_phone", "definitively_rejected");
        if (runError) {
          return failAfterRunWrite(client, enrollment.id, runError, "No-phone bookkeeping failed");
        }
        const pauseError = await pauseEnrollment(
          client,
          enrollment.id,
          "inbound_reply",
          false,
        );
        if (pauseError) {
          return { status: "failed", enrollmentId: enrollment.id, message: pauseError };
        }
        return { status: "paused", enrollmentId: enrollment.id, reason: "no_phone" };
      }
      case "blocked_no_approved_sender": {
        const runError = await markRunSkipped(client, claim.id, "provider_failed", "not_attempted");
        if (runError) {
          return failAfterRunWrite(client, enrollment.id, runError, "Sender-selection bookkeeping failed");
        }
        const pauseError = await pauseEnrollment(
          client,
          enrollment.id,
          FIRST_TOUCH_SENDER_PAUSE_REASON,
          false,
        );
        if (pauseError) {
          return { status: "failed", enrollmentId: enrollment.id, message: pauseError };
        }
        return {
          status: "paused",
          enrollmentId: enrollment.id,
          reason: FIRST_TOUCH_SENDER_PAUSE_REASON,
        };
      }
      case "blocked_sequence_authorization": {
        const runError = await markRunSkipped(
          client,
          claim.id,
          "provider_failed",
          outcome.attemptOutcome,
          outcome.reason,
        );
        if (runError) {
          return failAfterRunWrite(client, enrollment.id, runError, "Sequence-authorization bookkeeping failed");
        }
        const pauseError = await pauseEnrollment(
          client,
          enrollment.id,
          outcome.attemptOutcome === "definitively_rejected"
            ? "provider_failed"
            : "reconciliation_required",
          false,
        );
        if (pauseError) {
          return { status: "failed", enrollmentId: enrollment.id, message: pauseError };
        }
        return { status: "paused", enrollmentId: enrollment.id, reason: outcome.reason };
      }
      case "provider_failed":
      case "blocked_provider_off":
      case "property_not_found":
      case "db_error":
      default: {
        const deliveryOutcome: SequenceAttemptOutcome =
          outcome.status === "provider_failed"
            ? outcome.deliveryOutcome ?? "unknown"
            : outcome.status === "db_error"
              ? outcome.deliveryOutcome ??
                (outcome.externalId ? "accepted" : "not_attempted")
              : "not_attempted";
        const failureReason =
          "error" in outcome
            ? outcome.error
            : "reason" in outcome
              ? outcome.reason
              : undefined;
        const runError = await markRunSkipped(
          client,
          claim.id,
          "provider_failed",
          deliveryOutcome,
          failureReason,
        );
        if (runError) {
          return failAfterRunWrite(client, enrollment.id, runError, "Provider-outcome bookkeeping failed");
        }
        const pauseError = await pauseEnrollment(
          client,
          enrollment.id,
          deliveryOutcome === "unknown" || deliveryOutcome === "accepted"
            ? "reconciliation_required"
            : "provider_failed",
          false,
        );
        if (pauseError) {
          return { status: "failed", enrollmentId: enrollment.id, message: pauseError };
        }
        return {
          status: "failed",
          enrollmentId: enrollment.id,
          message:
            "reason" in outcome
              ? outcome.reason
              : "error" in outcome
                ? outcome.error
                : outcome.status,
        };
      }
    }
  }

  if (step.action_type === "change_status" && step.target_status) {
    const { data: changedProperty, error: changeError } = await client
      .from("properties")
      .update({
        status: step.target_status,
        updated_at: new Date().toISOString(),
      })
      .eq("id", enrollment.property_id)
      .eq("is_dnc_locked", false)
      .select("id")
      .maybeSingle();
    if (changeError) {
      const runError = await markRunSkipped(client, claim.id, "provider_failed");
      if (runError) {
        return failAfterRunWrite(client, enrollment.id, runError, "Status-change bookkeeping failed");
      }
      return {
        status: "failed",
        enrollmentId: enrollment.id,
        message: changeError.message,
      };
    }
    if (!changedProperty) {
      const { data: currentProperty, error: reconcileError } = await client
        .from("properties")
        .select("is_dnc_locked")
        .eq("id", enrollment.property_id)
        .maybeSingle();
      const runError = await markRunSkipped(client, claim.id, "paused");
      if (runError) {
        return failAfterRunWrite(client, enrollment.id, runError, "DNC status-race bookkeeping failed");
      }
      if (reconcileError || !currentProperty?.is_dnc_locked) {
        return {
          status: "failed",
          enrollmentId: enrollment.id,
          message: reconcileError?.message ?? "Property changed before sequence status update.",
        };
      }
      const pauseError = await pauseEnrollment(
        client,
        enrollment.id,
        "dnc",
        true,
      );
      if (pauseError) {
        return {
          status: "failed",
          enrollmentId: enrollment.id,
          message: pauseError,
        };
      }
      return { status: "paused", enrollmentId: enrollment.id, reason: "dnc" };
    }
    const { data: runWrite, error: runError } = await client
      .from("sequence_step_runs")
      .update({ run_at: new Date().toISOString() })
      .eq("id", claim.id)
      .select("id")
      .maybeSingle();
    if (runError || !runWrite) {
      const pauseError = await pauseEnrollment(
        client,
        enrollment.id,
        "reconciliation_required",
        false,
      );
      return {
        status: "failed",
        enrollmentId: enrollment.id,
        message: `Property status changed; run write failed: ${runError?.message ?? "no run row updated"}${pauseError ? `; ${pauseError}` : ""}`,
      };
    }
    const advanceError = await advanceEnrollment(client, enrollment.id, enrollment.sequence_id, step.step_index);
    if (advanceError) {
      const pauseError = await pauseEnrollment(
        client,
        enrollment.id,
        "reconciliation_required",
        false,
      );
      return {
        status: "failed",
        enrollmentId: enrollment.id,
        message: `Property status changed; ${advanceError}${pauseError ? `; ${pauseError}` : ""}`,
      };
    }
    return {
      status: "status_changed",
      enrollmentId: enrollment.id,
      stepIndex: step.step_index,
    };
  }

  // Shouldn't reach here given the check constraint, but stay safe.
  const runError = await markRunSkipped(client, claim.id, "provider_failed");
  if (runError) {
    return failAfterRunWrite(client, enrollment.id, runError, "Unsupported-step bookkeeping failed");
  }
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
): Promise<string | null> {
  const { data: nextStep, error: nextStepError } = await client
    .from("sequence_steps")
    .select("delay_after_previous_minutes")
    .eq("sequence_id", sequenceId)
    .eq("step_index", currentStepIndex + 1)
    .maybeSingle();
  if (nextStepError) return `next step lookup failed: ${nextStepError.message}`;

  if (!nextStep) {
    const { data: completed, error } = await client
      .from("sequence_enrollments")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        next_run_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", enrollmentId)
      .eq("status", "active")
      .eq("current_step_index", currentStepIndex)
      .select("id")
      .maybeSingle();
    return error
      ? `completion write failed: ${error.message}`
      : completed
        ? null
        : "enrollment changed before completion";
  }

  const nextRunAt = delayToDate(
    nextStep.delay_after_previous_minutes,
    new Date(),
  ).toISOString();
  const { data: advanced, error } = await client
    .from("sequence_enrollments")
    .update({
      current_step_index: currentStepIndex + 1,
      next_run_at: nextRunAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", enrollmentId)
    .eq("status", "active")
    .eq("current_step_index", currentStepIndex)
    .select("id")
    .maybeSingle();
  return error
    ? `advancement write failed: ${error.message}`
    : advanced
      ? null
      : "enrollment changed before advancement";
}

async function markRunSkipped(
  client: SupabaseClient<Database>,
  runId: string,
  reason: "quiet_hours" | "consent_revoked" | "paused" | "escalated" | "no_phone" | "provider_failed",
  attemptOutcome: SequenceAttemptOutcome = "not_attempted",
  failureReason?: string,
): Promise<string | null> {
  // Outcome transitions are monotonic. In particular, an accepted/unknown
  // provider intent may never be downgraded to not_attempted by a later
  // bookkeeping path. The retry RPC also requires run_at, so a failed write
  // remains reconciliation-only rather than silently granting a resend.
  const allowedCurrentOutcomes: SequenceAttemptOutcome[] =
    attemptOutcome === "not_attempted"
      ? ["not_attempted"]
      : attemptOutcome === "definitively_rejected"
        ? ["not_attempted", "definitively_rejected", "unknown"]
        : attemptOutcome === "accepted"
          ? ["unknown", "accepted"]
          : ["unknown"];
  const { data, error } = await client
    .from("sequence_step_runs")
    .update({
      run_at: new Date().toISOString(),
      skipped_reason: reason,
      attempt_outcome: attemptOutcome,
      failure_reason: failureReason ?? null,
    })
    .eq("id", runId)
    .eq("claim_active", true)
    .in("attempt_outcome", allowedCurrentOutcomes)
    .select("id")
    .maybeSingle();
  if (error) return `sequence run write failed: ${error.message}`;
  if (!data) return "sequence run outcome changed before bookkeeping";
  return null;
}

async function failAfterRunWrite(
  client: SupabaseClient<Database>,
  enrollmentId: string,
  runError: string,
  context: string,
): Promise<TickOutcome> {
  const pauseError = await pauseEnrollment(
    client,
    enrollmentId,
    "reconciliation_required",
    false,
  );
  return {
    status: "failed",
    enrollmentId,
    message: `${context}: ${runError}${pauseError ? `; ${pauseError}` : ""}`,
  };
}

async function pauseEnrollment(
  client: SupabaseClient<Database>,
  enrollmentId: string,
  reason: string,
  permanent: boolean,
): Promise<string | null> {
  let pauseQuery = client
    .from("sequence_enrollments")
    .update({
      status: permanent ? "opted_out" : "paused",
      pause_reason: reason,
      ...(permanent ? { next_run_at: null } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", enrollmentId);
  pauseQuery = permanent
    ? pauseQuery.in("status", ["active", "paused"])
    : pauseQuery.eq("status", "active");
  const { error } = await pauseQuery;
  return error?.message ?? null;
}
