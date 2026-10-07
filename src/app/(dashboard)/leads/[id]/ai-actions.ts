"use server";

import { assertNotTrainingTarget } from "@/lib/leads/training";
import { revalidatePath } from "next/cache";

import {
  applySuppressionForConfirmedReview,
  isSuppressionIncompleteReason,
  listOutstandingSuppressionReviews,
  recordSuppressionRetriedOk,
} from "@/lib/ai-responder/confirm-suppression";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { LEAD_EVENT_TYPES, recordLeadEvent } from "@/lib/events";
import { createAdminClient } from "@/lib/supabase/admin";
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
 * Outstanding failed-suppression review ids for a property (hold reason id plus
 * unresolved `suppression_incomplete` lead events). Read-only; drives the banner.
 */
export async function listOutstandingSuppressionFailures(
  propertyId: string,
): Promise<Result<{ reviewIds: string[] }>> {
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
    const { reviewIds } = await listOutstandingSuppressionReviews(
      supabase as never,
      propertyId,
    );
    return ok({ reviewIds });
  } catch (e) {
    reportError(e, {
      tags: { surface: "list_outstanding_suppression" },
      extra: { propertyId },
    });
    return {
      ok: false,
      error: {
        code: "LIST_SUPPRESSION_FAILED",
        message:
          e instanceof Error ? e.message : "Could not load suppression status",
      },
    };
  }
}

/**
 * Re-run phone suppression for exactly the confirmed opted_out/dnc reviews
 * whose suppression failed: the id carried in the `suppression_incomplete:<id>`
 * hold reason plus unresolved `suppression_incomplete` lead events (no later
 * `suppression_retried_ok`). Each success is recorded; then
 * fn_clear_suppression_hold_if_resolved decides, under the property row lock,
 * whether anything is still outstanding: it clears the hold only when nothing
 * is, otherwise rewrites the pointer to what remains. A preserved send-timeout
 * flag is never cleared.
 */
export async function retrySuppressionForProperty(
  propertyId: string,
): Promise<Result<{ cleared: boolean; remaining: number }>> {
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
    const fail = (message: string) => ({
      ok: false as const,
      error: { code: "RETRY_SUPPRESSION_FAILED", message },
    });

    const outstanding = await listOutstandingSuppressionReviews(
      supabase as never,
      propertyId,
    );
    let ids = outstanding.reviewIds;
    if (ids.length === 0 && isSuppressionIncompleteReason(outstanding.reason)) {
      // Legacy bare `suppression_incomplete` hold with no recorded id: fall
      // back to the most recent confirmed opt-out/DNC review.
      const { data: latest, error: latestError } = await supabase
        .from("ai_disposition_reviews")
        .select("id")
        .eq("property_id", propertyId)
        .eq("status", "confirmed")
        .in("disposition", ["opted_out", "dnc"])
        .order("human_reviewed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latestError) return fail(latestError.message);
      if (latest) ids = [latest.id];
    }
    if (ids.length === 0) {
      return fail("No failed suppression found for this lead");
    }

    const { data: reviews, error: reviewError } = await supabase
      .from("ai_disposition_reviews")
      .select("id")
      .eq("property_id", propertyId)
      .eq("status", "confirmed")
      .in("disposition", ["opted_out", "dnc"])
      .in("id", ids);
    if (reviewError) return fail(reviewError.message);
    const valid = new Set(
      ((reviews ?? []) as Array<{ id: string }>).map((r) => r.id),
    );
    const targets = ids.filter((id) => valid.has(id));
    if (targets.length === 0) {
      return fail("No confirmed opt-out or DNC review found for this lead");
    }

    let warning: string | null = null;
    for (const reviewId of targets) {
      const suppression = await applySuppressionForConfirmedReview(
        supabase as never,
        reviewId,
        user.id,
      );
      if (suppression.ok) {
        await recordSuppressionRetriedOk({
          propertyId,
          reviewId,
          actorId: user.id,
        });
      } else {
        warning = suppression.warning;
      }
    }

    // The clear decision is made inside the database under the property row
    // lock: it recomputes outstanding (pointer ids + ledger failures without a
    // later retried_ok), clears the hold only when that set is empty, and
    // otherwise rewrites the pointer to what remains. A failure recorded after
    // our retries but before this call is therefore seen, never cleared over.
    const { data: clearRows, error: clearError } = await createAdminClient().rpc(
      "fn_clear_suppression_hold_if_resolved",
      { p_property_id: propertyId },
    );
    if (clearError) {
      return {
        ok: false,
        error: { code: "CLEAR_ATTENTION_FAILED", message: clearError.message },
      };
    }
    const clearRow = (Array.isArray(clearRows) ? clearRows[0] : clearRows) as
      | { cleared: boolean; outstanding_ids: string[] | null }
      | null
      | undefined;
    const cleared = !!clearRow?.cleared;
    const remaining = (clearRow?.outstanding_ids ?? []).length;
    if (cleared) {
      await recordLeadEvent({
        propertyId,
        actorType: "user",
        actorId: user.id,
        eventType: LEAD_EVENT_TYPES.AI_ESCALATION_CLEARED,
        payload: {
          from: true,
          to: false,
          via: "retry_suppression",
          reviewIds: targets,
        },
      });
    }
    revalidatePath(`/leads/${propertyId}`);
    if (warning) {
      return {
        ok: false,
        error: { code: "SUPPRESSION_INCOMPLETE", message: warning },
      };
    }
    return ok({ cleared, remaining });
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
