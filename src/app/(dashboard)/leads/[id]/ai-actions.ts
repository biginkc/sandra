"use server";

import { assertNotTrainingTarget } from "@/lib/leads/training";
import { revalidatePath } from "next/cache";

import {
  applySuppressionForConfirmedReview,
  SUPPRESSION_INCOMPLETE_REASON,
} from "@/lib/ai-responder/confirm-suppression";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { LEAD_EVENT_TYPES, recordLeadEvent } from "@/lib/events";
import { createClient } from "@/lib/supabase/server";

/**
 * Clear the `needs_human_attention` flag on a property. Called from
 * the lead-detail banner's Dismiss button after a VA has actually
 * handled the escalation.
 */
export async function clearNeedsHumanAttention(
  propertyId: string,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return {
        ok: false,
        error: { code: "UNAUTHENTICATED", message: "Not signed in" },
      };
    }
    const { data: updated, error } = await supabase
      .from("properties")
      .update({
        needs_human_attention: false,
        last_ai_escalation_reason: null,
        last_ai_escalation_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", propertyId)
      .eq("needs_human_attention", true)
      .select("id")
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        error: { code: "CLEAR_ATTENTION_FAILED", message: error.message },
      };
    }
    if (updated) {
      await recordLeadEvent({
        propertyId,
        actorType: "user",
        actorId: user.id,
        eventType: LEAD_EVENT_TYPES.AI_ESCALATION_CLEARED,
        payload: { from: true, to: false },
      });
    }
    revalidatePath(`/leads/${propertyId}`);
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "clear_needs_human_attention" },
      extra: { propertyId },
    });
    return errFromUnknown(e, "CLEAR_ATTENTION_FAILED");
  }
}

/**
 * Re-run phone suppression for the latest confirmed opted_out/dnc review on
 * a property whose earlier suppression failed (`suppression_incomplete`
 * hold). Success clears the hold (only when the hold is the
 * suppression_incomplete one, so a preserved send-timeout flag stays up) and
 * audits it; failure keeps the hold and returns the warning.
 */
export async function retrySuppressionForProperty(
  propertyId: string,
): Promise<Result<{ cleared: boolean }>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return {
        ok: false,
        error: { code: "UNAUTHENTICATED", message: "Not signed in" },
      };
    }
    const { data: review, error: reviewError } = await supabase
      .from("ai_disposition_reviews")
      .select("id")
      .eq("property_id", propertyId)
      .eq("status", "confirmed")
      .in("disposition", ["opted_out", "dnc"])
      .order("human_reviewed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (reviewError) {
      return {
        ok: false,
        error: { code: "RETRY_SUPPRESSION_FAILED", message: reviewError.message },
      };
    }
    if (!review) {
      return {
        ok: false,
        error: {
          code: "RETRY_SUPPRESSION_FAILED",
          message: "No confirmed opt-out or DNC review found for this lead",
        },
      };
    }
    const suppression = await applySuppressionForConfirmedReview(
      supabase as never,
      review.id,
      user.id,
    );
    if (!suppression.ok) {
      return {
        ok: false,
        error: { code: "SUPPRESSION_INCOMPLETE", message: suppression.warning },
      };
    }
    const { data: cleared, error: clearError } = await supabase
      .from("properties")
      .update({
        needs_human_attention: false,
        last_ai_escalation_reason: null,
        last_ai_escalation_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", propertyId)
      .eq("last_ai_escalation_reason", SUPPRESSION_INCOMPLETE_REASON)
      .select("id")
      .maybeSingle();
    if (clearError) {
      return {
        ok: false,
        error: { code: "CLEAR_ATTENTION_FAILED", message: clearError.message },
      };
    }
    if (cleared) {
      await recordLeadEvent({
        propertyId,
        actorType: "user",
        actorId: user.id,
        eventType: LEAD_EVENT_TYPES.AI_ESCALATION_CLEARED,
        payload: { from: true, to: false, via: "retry_suppression", reviewId: review.id },
      });
    }
    revalidatePath(`/leads/${propertyId}`);
    return ok({ cleared: !!cleared });
  } catch (e) {
    reportError(e, {
      tags: { surface: "retry_suppression" },
      extra: { propertyId },
    });
    return errFromUnknown(e, "RETRY_SUPPRESSION_FAILED");
  }
}

/**
 * Flip skip-trace on/off for a specific property. VA-controlled kill
 * switch — when true, this property is excluded from any skip-trace
 * request (silently dropped from bulk, refused outright on single).
 * Use case: do-not-contact homeowners, properties already under
 * contract elsewhere, anything where spending Tracerfy credits is wasted.
 */
export async function setSkipTraceDisabled(
  propertyId: string,
  disabled: boolean,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return {
        ok: false,
        error: { code: "UNAUTHENTICATED", message: "Not signed in" },
      };
    }
    await assertNotTrainingTarget(supabase, { propertyId });
    const { data: updated, error } = await supabase
      .from("properties")
      .update({
        skip_trace_disabled: disabled,
        updated_at: new Date().toISOString(),
      })
      .eq("id", propertyId)
      .eq("skip_trace_disabled", !disabled)
      .select("id")
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        error: { code: "SKIP_TRACE_TOGGLE_FAILED", message: error.message },
      };
    }
    if (updated) {
      await recordLeadEvent({
        propertyId,
        actorType: "user",
        actorId: user.id,
        eventType: LEAD_EVENT_TYPES.SKIP_TRACE_TOGGLED,
        payload: { from: !disabled, to: disabled },
      });
    }
    revalidatePath(`/leads/${propertyId}`);
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "set_skip_trace_disabled" },
      extra: { propertyId, disabled },
    });
    return errFromUnknown(e, "SKIP_TRACE_TOGGLE_FAILED");
  }
}

/**
 * Flip the AI responder on/off for a specific property. VA-controlled
 * kill switch for when a lead is especially sensitive or the AI's
 * tone isn't the right fit.
 */
export async function setAiResponderDisabled(
  propertyId: string,
  disabled: boolean,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return {
        ok: false,
        error: { code: "UNAUTHENTICATED", message: "Not signed in" },
      };
    }
    await assertNotTrainingTarget(supabase, { propertyId });
    const { data: updated, error } = await supabase
      .from("properties")
      .update({
        ai_responder_disabled: disabled,
        updated_at: new Date().toISOString(),
      })
      .eq("id", propertyId)
      .eq("ai_responder_disabled", !disabled)
      .select("id")
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        error: { code: "AI_TOGGLE_FAILED", message: error.message },
      };
    }
    if (updated) {
      await recordLeadEvent({
        propertyId,
        actorType: "user",
        actorId: user.id,
        eventType: LEAD_EVENT_TYPES.AI_RESPONDER_TOGGLED,
        payload: { from: !disabled, to: disabled },
      });
    }
    revalidatePath(`/leads/${propertyId}`);
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "set_ai_responder_disabled" },
      extra: { propertyId, disabled },
    });
    return errFromUnknown(e, "AI_TOGGLE_FAILED");
  }
}
