import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { checkQuietHours } from "@/lib/messaging/quiet-hours";
import type { Database } from "@/lib/supabase/types";
import {
  checkVoicemailDropEligibility,
  chicagoDayWindow,
  EligibilityReadError,
  findBlockedDropPhones,
  readDailyCap,
  readDropCallerId,
  VOICEMAIL_DROP_SCRIPT_MAX_CHARS,
} from "@/lib/voicemail-drop/eligibility";
import { getVoicemailDropProvider } from "@/lib/voicemail-drop/registry";
import type {
  VoicemailDropAudio,
  VoicemailDropProvider,
  VoicemailDropSendResult,
} from "@/lib/voicemail-drop/types";

import { renderTemplate } from "./render";
import { loadTemplateVars } from "./template-vars";
import {
  advanceEnrollment,
  failAfterRunWrite,
  markRunSkipped,
  pauseEnrollment,
  type TickOutcome,
} from "./tick";

/**
 * `send_voicemail_drop` worker branch (.planning/voicemail-drop-step-plan.md,
 * build-order step 3). Called by processEnrollmentTick after the shared
 * pre-claim checks (DNC lock, pausing outreach_dispo, status pause rules) and
 * after the step run claim was inserted.
 *
 * Order: provider configured → eligibility → quiet hours
 * → step config + deterministic render → per-number block re-check →
 * voicemail_drops row (cap-reserved under a per-org lock) → provider
 * intent fence (authorize_sequence_provider_attempt, run → 'unknown') → POST
 * → RULING RVM-4 result handling. Nothing here blind-retries a possibly
 * queued drop.
 */

const QUIET_HOURS_RETRY_MS = 10 * 60 * 60 * 1000;
const ELIGIBILITY_UNAVAILABLE_RETRY_MS = 5 * 60 * 1000;
const NOT_QUEUED_RETRY_MS = 5 * 60 * 1000;
/**
 * After this many consecutive 429/500 not-queued runs for the same enrollment
 * step (12 × 5 min ≈ 1 hour), stop retrying: pause provider_failed and report.
 */
export const MAX_CONSECUTIVE_NOT_QUEUED = 12;

type DropEnrollment = {
  id: string;
  org_id: string;
  sequence_id: string;
  property_id: string;
  contact_id: string | null;
  current_step_index: number;
};

type DropStep = {
  id: string;
  step_index: number;
  vm_media_id: string | null;
  vm_tts_body: string | null;
  vm_voice_id: string | null;
  vm_phone_line_id: string | null;
};

type DropProperty = { state: string | null };

/**
 * Callback URL for Drop Cowboy. null = DROPCOWBOY_CALLBACK_SECRET unset.
 * Throws when the app URL (NEXT_PUBLIC_APP_URL / APP_URL) is unset: no
 * hardcoded host, so a preview or misconfigured deploy never points callbacks
 * at production.
 */
export function voicemailDropCallbackUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = env.DROPCOWBOY_CALLBACK_SECRET?.trim();
  if (!secret) return null;
  const base = (env.NEXT_PUBLIC_APP_URL?.trim() || env.APP_URL?.trim() || "");
  if (!base) throw new Error("NEXT_PUBLIC_APP_URL is not set; cannot build the voicemail drop callback URL");
  const normalized = (base.startsWith("http") ? base : `https://${base}`).replace(/\/+$/, "");
  return `${normalized}/api/webhooks/dropcowboy/rvm-callback/${encodeURIComponent(secret)}`;
}

/**
 * Deterministic merge-field render for a TTS script. Same engine and same
 * variables as SMS steps (`{{first_name}}`, `{{property_address}}` …), no
 * opt-out footer and no rotation, so the same inputs always give the same
 * body (Drop Cowboy rejects a reused Idempotency-Key with a different body,
 * error 3027). Whitespace is collapsed for speech.
 */
export function renderVoicemailScript(
  template: string,
  vars: Parameters<typeof renderTemplate>[1],
): string {
  return renderTemplate(template, vars).replace(/\s+/g, " ").trim();
}

/**
 * Retire a proven no-attempt claim and reschedule — the quiet-hours retire
 * block from the send_sms branch, verbatim apart from the labels.
 */
async function retireNotAttemptedClaim(
  client: SupabaseClient<Database>,
  enrollment: DropEnrollment,
  claimId: string,
  nextRunAt: Date,
  labels: {
    skipped_reason: "quiet_hours" | null;
    failure_reason: string | null;
    recovery_action: string;
    recovery_evidence: string;
  },
): Promise<string | null> {
  const { data: retired, error: retireError } = await client
    .from("sequence_step_runs")
    .update({
      claim_active: false,
      run_at: new Date().toISOString(),
      skipped_reason: labels.skipped_reason,
      attempt_outcome: "not_attempted",
      failure_reason: labels.failure_reason,
      recovery_action: labels.recovery_action,
      recovery_evidence: labels.recovery_evidence,
    })
    .eq("id", claimId)
    .eq("claim_active", true)
    .eq("attempt_outcome", "not_attempted")
    .select("id")
    .maybeSingle();
  if (retireError || !retired) {
    return retireError?.message ?? "claim changed before retirement";
  }
  return rescheduleEnrollment(client, enrollment, nextRunAt);
}

async function rescheduleEnrollment(
  client: SupabaseClient<Database>,
  enrollment: DropEnrollment,
  nextRunAt: Date,
): Promise<string | null> {
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
    return `reschedule: ${rescheduleError?.message ?? "Enrollment changed before reschedule"}`;
  }
  return null;
}

async function pauseNotAttempted(
  client: SupabaseClient<Database>,
  enrollmentId: string,
  claimId: string,
  pauseReason: string,
  failureReason: string,
): Promise<TickOutcome> {
  const runError = await markRunSkipped(client, claimId, "provider_failed", "not_attempted", failureReason);
  if (runError) {
    return failAfterRunWrite(client, enrollmentId, runError, "Voicemail drop bookkeeping failed");
  }
  const pauseError = await pauseEnrollment(client, enrollmentId, pauseReason, false);
  if (pauseError) return { status: "failed", enrollmentId, message: pauseError };
  return { status: "paused", enrollmentId, reason: pauseReason };
}

async function updateDropRow(
  client: SupabaseClient<Database>,
  dropId: string,
  patch: Database["public"]["Tables"]["voicemail_drops"]["Update"],
): Promise<string | null> {
  const { error } = await client.from("voicemail_drops").update(patch).eq("id", dropId);
  return error?.message ?? null;
}

export async function processVoicemailDropStep(
  client: SupabaseClient<Database>,
  enrollment: DropEnrollment,
  step: DropStep,
  property: DropProperty,
  claimId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TickOutcome> {
  // 0. Feature gate. Unset provider = feature off: nothing fires. Same as
  //    send_sms with the SMS provider off (blocked_provider_off): the run is
  //    recorded as not attempted and the enrollment pauses with
  //    provider_failed, so it is visible and resumable instead of silently
  //    skipping every lead past the drop.
  let provider: VoicemailDropProvider | null;
  try {
    provider = getVoicemailDropProvider(env);
  } catch (error) {
    reportError(error, { tags: { surface: "sequence_tick_voicemail_drop_config" } });
    return pauseNotAttempted(
      client,
      enrollment.id,
      claimId,
      "provider_failed",
      `voicemail drop provider misconfigured: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!provider) {
    return pauseNotAttempted(client, enrollment.id, claimId, "provider_failed", "voicemail drop provider off");
  }
  let callbackUrl: string | null;
  try {
    callbackUrl = voicemailDropCallbackUrl(env);
  } catch (error) {
    reportError(error, { tags: { surface: "sequence_tick_voicemail_drop_config" } });
    return pauseNotAttempted(client, enrollment.id, claimId, "provider_failed", "voicemail drop callback url missing");
  }
  if (!callbackUrl) {
    reportError(new Error("DROPCOWBOY_CALLBACK_SECRET is not set"), {
      tags: { surface: "sequence_tick_voicemail_drop_config" },
    });
    return pauseNotAttempted(client, enrollment.id, claimId, "provider_failed", "voicemail drop callback secret missing");
  }

  // BYOC caller ID (dedicated Telnyx number). Set = send caller_id and no
  // phone line; unset = the step's vm_phone_line_id.
  let callerId: string | null;
  try {
    callerId = readDropCallerId(env);
  } catch (error) {
    reportError(error, { tags: { surface: "sequence_tick_voicemail_drop_config" } });
    return pauseNotAttempted(
      client,
      enrollment.id,
      claimId,
      "provider_failed",
      `voicemail drop caller id misconfigured: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // VOICEMAIL_DROP_DAILY_CAP: unset = no cap; set but invalid = fail closed.
  let cap: number | null;
  try {
    cap = readDailyCap(env);
  } catch (error) {
    reportError(error, { tags: { surface: "sequence_tick_voicemail_drop_config" } });
    return pauseNotAttempted(
      client,
      enrollment.id,
      claimId,
      "provider_failed",
      `voicemail drop daily cap misconfigured: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 1. Eligibility (RULING RVM-2 / RVM-3).
  const notEligible = async (reason: string): Promise<TickOutcome> => {
    const runError = await markRunSkipped(client, claimId, "not_eligible", "not_attempted", reason);
    if (runError) {
      return failAfterRunWrite(client, enrollment.id, runError, "Not-eligible voicemail drop bookkeeping failed");
    }
    const advanceError = await advanceEnrollment(client, enrollment.id, enrollment.sequence_id, step.step_index);
    if (advanceError) return { status: "failed", enrollmentId: enrollment.id, message: advanceError };
    return { status: "skipped_not_eligible", enrollmentId: enrollment.id, stepIndex: step.step_index, reason };
  };
  if (!enrollment.contact_id) return notEligible("no_contact");

  let eligibility;
  try {
    eligibility = await checkVoicemailDropEligibility(client, {
      orgId: enrollment.org_id,
      contactId: enrollment.contact_id,
      propertyId: enrollment.property_id,
    });
  } catch (error) {
    if (!(error instanceof EligibilityReadError)) throw error;
    // Fail closed: nothing sent, retry shortly.
    const retryAt = new Date(Date.now() + ELIGIBILITY_UNAVAILABLE_RETRY_MS);
    const retireError = await retireNotAttemptedClaim(client, enrollment, claimId, retryAt, {
      skipped_reason: null,
      failure_reason: "voicemail_eligibility_unavailable",
      recovery_action: "voicemail_eligibility_deferred",
      recovery_evidence: `eligibility could not be read (${error.message}); no provider attempt was made`,
    });
    if (retireError) {
      return failAfterRunWrite(client, enrollment.id, retireError, "Eligibility-unavailable claim bookkeeping failed");
    }
    return { status: "failed", enrollmentId: enrollment.id, message: error.message };
  }
  if (!eligibility.eligible) return notEligible(eligibility.reason);

  // 2. Quiet hours — the send_sms blocked_quiet_hours retire block.
  const quiet = checkQuietHours(property.state);
  if (!quiet.ok) {
    const nextRunAt = new Date(Date.now() + QUIET_HOURS_RETRY_MS);
    const retireError = await retireNotAttemptedClaim(client, enrollment, claimId, nextRunAt, {
      skipped_reason: "quiet_hours",
      failure_reason: null,
      recovery_action: "quiet_hours_deferred",
      recovery_evidence: "provider was not authorized during quiet hours",
    });
    if (retireError) {
      return failAfterRunWrite(client, enrollment.id, retireError, "Quiet-hours claim bookkeeping failed");
    }
    return { status: "rescheduled_quiet_hours", enrollmentId: enrollment.id, nextRunAt: nextRunAt.toISOString() };
  }

  // 4. Step config + deterministic render.
  const mediaId = step.vm_media_id?.trim() || null;
  const ttsTemplate = step.vm_tts_body?.trim() || null;
  const voiceId = step.vm_voice_id?.trim() || null;
  const phoneLineId = step.vm_phone_line_id?.trim() || null;
  if ((!callerId && !phoneLineId) || (mediaId ? Boolean(ttsTemplate) : !ttsTemplate || !voiceId)) {
    return pauseNotAttempted(client, enrollment.id, claimId, "step_misconfigured", "voicemail drop step is missing audio, voice, or phone line");
  }
  const vars = await loadTemplateVars(client, {
    propertyId: enrollment.property_id,
    contactId: enrollment.contact_id,
  });
  let audio: VoicemailDropAudio;
  let renderedScript: string | null = null;
  if (mediaId) {
    audio = { kind: "media", mediaId };
  } else {
    renderedScript = renderVoicemailScript(ttsTemplate ?? "", vars);
    // Drop Cowboy treats braces as its own merge fields: nothing unrendered
    // (malformed or single-brace placeholders) may reach it.
    if (/[{}]/.test(renderedScript)) {
      return pauseNotAttempted(
        client,
        enrollment.id,
        claimId,
        "step_misconfigured",
        "voicemail drop script has an unrendered merge field ({ or } left after render)",
      );
    }
    if (!renderedScript || renderedScript.length > VOICEMAIL_DROP_SCRIPT_MAX_CHARS) {
      return pauseNotAttempted(
        client,
        enrollment.id,
        claimId,
        "step_misconfigured",
        `voicemail drop script is empty or over ${VOICEMAIL_DROP_SCRIPT_MAX_CHARS} characters`,
      );
    }
    audio = { kind: "tts", ttsBody: renderedScript, voiceId: voiceId ?? "" };
  }
  const postalCode = typeof vars.property_zip === "string" && vars.property_zip.trim() ? vars.property_zip.trim() : null;

  // 5. Re-check the per-number blocks right before the attempt (eligibility
  //    read them earlier in this tick; this closes most of the gap). Not
  //    inside the DB fence: authorize_sequence_provider_attempt does not know
  //    voicemail-only rules.
  let lateBlock: string | undefined;
  try {
    lateBlock = (await findBlockedDropPhones(client, enrollment.org_id, [eligibility.phone])).get(eligibility.phone);
  } catch (error) {
    if (!(error instanceof EligibilityReadError)) throw error;
    const retryAt = new Date(Date.now() + ELIGIBILITY_UNAVAILABLE_RETRY_MS);
    const retireError = await retireNotAttemptedClaim(client, enrollment, claimId, retryAt, {
      skipped_reason: null,
      failure_reason: "voicemail_eligibility_unavailable",
      recovery_action: "voicemail_eligibility_deferred",
      recovery_evidence: `phone block re-check could not be read (${error.message}); no provider attempt was made`,
    });
    if (retireError) {
      return failAfterRunWrite(client, enrollment.id, retireError, "Eligibility-unavailable claim bookkeeping failed");
    }
    return { status: "failed", enrollmentId: enrollment.id, message: error.message };
  }
  if (lateBlock) return notEligible(lateBlock);

  // 6. voicemail_drops row (attempt_outcome 'unknown' until the POST answers).
  //    With VOICEMAIL_DROP_DAILY_CAP set, the count and the insert run in one
  //    transaction under a per-org advisory lock so parallel ticks cannot
  //    overshoot the cap.
  let dropRowId: string;
  if (cap !== null) {
    const day = chicagoDayWindow(new Date());
    const { data: reservedId, error: reserveError } = await (
      client.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: string | null; error: { message: string } | null }>
    )("reserve_voicemail_drop_with_cap", {
      p_org_id: enrollment.org_id,
      p_cap: cap,
      p_since: day.start.toISOString(),
      p_enrollment_id: enrollment.id,
      p_step_run_id: claimId,
      p_contact_id: enrollment.contact_id,
      p_property_id: enrollment.property_id,
      p_to_phone: eligibility.phone,
      p_provider: provider.id,
      p_audio_kind: audio.kind,
      p_rendered_script: renderedScript,
    });
    if (reserveError || !reservedId) {
      // Fail closed when the cap cannot be checked: retry in 5 minutes.
      const nextRunAt = reserveError ? new Date(Date.now() + ELIGIBILITY_UNAVAILABLE_RETRY_MS) : day.next;
      const retireError = await retireNotAttemptedClaim(client, enrollment, claimId, nextRunAt, {
        skipped_reason: null,
        failure_reason: "voicemail_drop_daily_cap",
        recovery_action: "voicemail_drop_daily_cap_deferred",
        recovery_evidence: reserveError
          ? `daily cap check unavailable (${reserveError.message}); no provider attempt was made`
          : `org reached VOICEMAIL_DROP_DAILY_CAP=${cap}; no provider attempt was made`,
      });
      if (retireError) {
        return failAfterRunWrite(client, enrollment.id, retireError, "Daily-cap claim bookkeeping failed");
      }
      return { status: "rescheduled_daily_cap", enrollmentId: enrollment.id, nextRunAt: nextRunAt.toISOString() };
    }
    dropRowId = reservedId;
  } else {
    const { data: dropRow, error: dropInsertError } = await client
      .from("voicemail_drops")
      .insert({
        org_id: enrollment.org_id,
        enrollment_id: enrollment.id,
        step_run_id: claimId,
        idempotency_key: claimId,
        contact_id: enrollment.contact_id,
        property_id: enrollment.property_id,
        to_phone: eligibility.phone,
        provider: provider.id,
        audio_kind: audio.kind,
        rendered_script: renderedScript,
        status: "queued",
        attempt_outcome: "unknown",
      })
      .select("id")
      .single();
    if (dropInsertError || !dropRow) {
      return pauseNotAttempted(
        client,
        enrollment.id,
        claimId,
        "provider_failed",
        `voicemail_drops insert failed: ${dropInsertError?.message ?? "no row"}`,
      );
    }
    dropRowId = dropRow.id;
  }

  // 7. Provider intent fence: locks the enrollment, re-checks suppression and
  //    that the phone is still saved on the contact, and moves the run to
  //    attempt_outcome 'unknown' before the POST. message_id stays null.
  const { data: authRows, error: authError } = await client.rpc("authorize_sequence_provider_attempt", {
    p_enrollment_id: enrollment.id,
    p_step_id: step.id,
    p_claim_id: claimId,
    p_contact_id: enrollment.contact_id,
    p_property_id: enrollment.property_id,
    p_phone: eligibility.phone,
    p_message_id: null as unknown as string,
  });
  const auth = authRows?.[0];
  if (authError || !auth?.authorized) {
    const reason = authError?.message ?? auth?.reason ?? "authorization returned no row";
    await updateDropRow(client, dropRowId, {
      status: "skipped",
      attempt_outcome: authError ? "unknown" : "not_queued",
      reason,
    });
    const rejected = !authError && auth?.attempt_outcome === "definitively_rejected";
    const runError = await markRunSkipped(
      client,
      claimId,
      "provider_failed",
      rejected ? "definitively_rejected" : "unknown",
      reason,
    );
    if (runError && !authError) {
      return failAfterRunWrite(client, enrollment.id, runError, "Voicemail drop authorization bookkeeping failed");
    }
    const pauseReason = rejected ? "provider_failed" : "reconciliation_required";
    const pauseError = await pauseEnrollment(client, enrollment.id, pauseReason, false);
    if (pauseError) return { status: "failed", enrollmentId: enrollment.id, message: pauseError };
    return { status: "paused", enrollmentId: enrollment.id, reason: pauseReason };
  }

  // 8. POST. Idempotency-Key = step_run_id.
  let result: VoicemailDropSendResult;
  try {
    result = await provider.sendDrop({
      idempotencyKey: claimId,
      to: eligibility.phone,
      audio,
      ...(callerId ? { callerId, phoneLineId: null } : { phoneLineId }),
      foreignId: dropRowId,
      callbackUrl,
      mobileOnly: true,
      maxAttempts: 1,
      postalCode,
    });
  } catch (error) {
    result = {
      outcome: "unknown",
      httpStatus: null,
      cause: "network",
      error: error instanceof Error ? error.message : String(error),
      raw: null,
    };
  }

  // 9. RULING RVM-4.
  return handleSendResult(client, enrollment, step, claimId, dropRowId, result);
}

async function handleSendResult(
  client: SupabaseClient<Database>,
  enrollment: DropEnrollment,
  step: DropStep,
  claimId: string,
  dropRowId: string,
  result: VoicemailDropSendResult,
): Promise<TickOutcome> {
  const payload = (result.raw ?? null) as Database["public"]["Tables"]["voicemail_drops"]["Update"]["provider_payload"];
  switch (result.outcome) {
    case "accepted": {
      const dropError = await updateDropRow(client, dropRowId, {
        status: "queued",
        attempt_outcome: "queued",
        queued_at: new Date().toISOString(),
        provider_payload: payload,
      });
      const { data: runWrite, error: runError } = await client
        .from("sequence_step_runs")
        .update({
          run_at: new Date().toISOString(),
          message_id: null,
          attempt_outcome: "accepted",
          failure_reason: null,
        })
        .eq("id", claimId)
        .eq("claim_active", true)
        .in("attempt_outcome", ["unknown", "accepted"])
        .select("id")
        .maybeSingle();
      // Queued already: keep the claim even on bookkeeping failure.
      if (dropError || runError || !runWrite) {
        const pauseError = await pauseEnrollment(client, enrollment.id, "reconciliation_required", false);
        return {
          status: "failed",
          enrollmentId: enrollment.id,
          message: `Voicemail drop ${dropRowId} queued; bookkeeping failed: ${dropError ?? runError?.message ?? "no run row updated"}${pauseError ? `; ${pauseError}` : ""}`,
        };
      }
      const advanceError = await advanceEnrollment(client, enrollment.id, enrollment.sequence_id, step.step_index);
      if (advanceError) {
        const pauseError = await pauseEnrollment(client, enrollment.id, "reconciliation_required", false);
        return {
          status: "failed",
          enrollmentId: enrollment.id,
          message: `Voicemail drop ${dropRowId} queued; ${advanceError}${pauseError ? `; ${pauseError}` : ""}`,
        };
      }
      return { status: "voicemail_queued", enrollmentId: enrollment.id, stepIndex: step.step_index, dropId: dropRowId };
    }
    case "not_queued": {
      // 429 / 500: nothing queued. Release the claim; the next tick gets a
      // new run id (and so a new Idempotency-Key and a new drop row).
      const reason = `provider returned ${result.httpStatus}; not queued`;
      await updateDropRow(client, dropRowId, {
        status: "failed",
        attempt_outcome: "not_queued",
        reason,
        provider_payload: payload,
      });
      const { data: released, error: releaseError } = await client
        .from("sequence_step_runs")
        .update({
          claim_active: false,
          run_at: new Date().toISOString(),
          attempt_outcome: "definitively_rejected",
          failure_reason: reason,
          recovery_action: "voicemail_drop_not_queued_retry",
          recovery_evidence: `Drop Cowboy answered ${result.httpStatus}; the drop was not queued`,
        })
        .eq("id", claimId)
        .eq("claim_active", true)
        .eq("attempt_outcome", "unknown")
        .select("id")
        .maybeSingle();
      if (releaseError || !released) {
        return failAfterRunWrite(
          client,
          enrollment.id,
          releaseError?.message ?? "claim changed before release",
          "Not-queued voicemail drop bookkeeping failed",
        );
      }
      const streak = await countNotQueuedStreak(client, enrollment.id, step.id);
      if (streak === null || streak >= MAX_CONSECUTIVE_NOT_QUEUED) {
        const why = streak === null
          ? "not-queued streak could not be read"
          : `${streak} consecutive not-queued attempts (limit ${MAX_CONSECUTIVE_NOT_QUEUED})`;
        reportError(new Error(`voicemail drop retries exhausted: ${why}`), {
          tags: { surface: "sequence_tick_voicemail_drop", outcome: "not_queued_exhausted" },
          extra: { enrollmentId: enrollment.id, claimId, dropRowId, httpStatus: result.httpStatus },
        });
        const pauseError = await pauseEnrollment(client, enrollment.id, "provider_failed", false);
        if (pauseError) return { status: "failed", enrollmentId: enrollment.id, message: pauseError };
        return { status: "paused", enrollmentId: enrollment.id, reason: "provider_failed" };
      }
      const nextRunAt = new Date(Date.now() + NOT_QUEUED_RETRY_MS);
      const rescheduleError = await rescheduleEnrollment(client, enrollment, nextRunAt);
      if (rescheduleError) return { status: "failed", enrollmentId: enrollment.id, message: rescheduleError };
      return { status: "rescheduled_provider_not_queued", enrollmentId: enrollment.id, nextRunAt: nextRunAt.toISOString() };
    }
    case "unknown": {
      // 502 / timeout / network / unexpected status: may be queued. Keep the
      // claim at 'unknown' and pause; never re-fire.
      const reason = `voicemail drop outcome unknown (${result.cause}${result.httpStatus ? ` ${result.httpStatus}` : ""})${result.error ? `: ${result.error}` : ""}`;
      await updateDropRow(client, dropRowId, {
        attempt_outcome: "unknown",
        reason,
        provider_payload: payload,
      });
      const runError = await markRunSkipped(client, claimId, "provider_failed", "unknown", reason);
      const pauseError = await pauseEnrollment(client, enrollment.id, "reconciliation_required", false);
      if (runError || pauseError) {
        return {
          status: "failed",
          enrollmentId: enrollment.id,
          message: `${reason}; ${[runError, pauseError].filter(Boolean).join("; ")}`,
        };
      }
      return { status: "paused", enrollmentId: enrollment.id, reason: "reconciliation_required" };
    }
    case "bad_request":
    case "unauthorized": {
      // 400 = adapter bug, 401 = credentials. Nothing sent.
      const reason = `voicemail drop ${result.outcome} (${result.httpStatus})${result.detail ? `: ${result.detail}` : ""}`;
      reportError(new Error(reason), {
        tags: { surface: "sequence_tick_voicemail_drop", outcome: result.outcome },
        extra: { enrollmentId: enrollment.id, claimId, dropRowId },
      });
      await updateDropRow(client, dropRowId, {
        status: "failed",
        attempt_outcome: "not_queued",
        reason,
        provider_payload: payload,
      });
      const runError = await markRunSkipped(client, claimId, "provider_failed", "definitively_rejected", reason);
      if (runError) {
        return failAfterRunWrite(client, enrollment.id, runError, "Rejected voicemail drop bookkeeping failed");
      }
      const pauseError = await pauseEnrollment(client, enrollment.id, "provider_failed", false);
      if (pauseError) return { status: "failed", enrollmentId: enrollment.id, message: pauseError };
      return { status: "paused", enrollmentId: enrollment.id, reason: "provider_failed" };
    }
  }
}

/**
 * Consecutive most-recent runs of this enrollment step that ended as a
 * not-queued retry (the run just released included). Null on read error.
 */
async function countNotQueuedStreak(
  client: SupabaseClient<Database>,
  enrollmentId: string,
  stepId: string,
): Promise<number | null> {
  const { data, error } = await client
    .from("sequence_step_runs")
    .select("recovery_action")
    .eq("enrollment_id", enrollmentId)
    .eq("step_id", stepId)
    .order("created_at", { ascending: false })
    .limit(MAX_CONSECUTIVE_NOT_QUEUED);
  if (error || !data) return null;
  let streak = 0;
  for (const row of data as { recovery_action: string | null }[]) {
    if (row.recovery_action !== "voicemail_drop_not_queued_retry") break;
    streak += 1;
  }
  return streak;
}
