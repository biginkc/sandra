"use server";

import { revalidatePath } from "next/cache";

import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
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
    const { error } = await supabase
      .from("properties")
      .update({
        needs_human_attention: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", propertyId);
    if (error) {
      return {
        ok: false,
        error: { code: "CLEAR_ATTENTION_FAILED", message: error.message },
      };
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
    const { error } = await supabase
      .from("properties")
      .update({
        ai_responder_disabled: disabled,
        updated_at: new Date().toISOString(),
      })
      .eq("id", propertyId);
    if (error) {
      return {
        ok: false,
        error: { code: "AI_TOGGLE_FAILED", message: error.message },
      };
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
