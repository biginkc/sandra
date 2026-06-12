"use server";

import { revalidatePath } from "next/cache";

import { isAdminEmail } from "@/lib/auth/allowlist";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { createClient } from "@/lib/supabase/server";

export type AiResponderConfigRow = {
  id: string;
  active: boolean;
  model: string;
  system_prompt: string;
  max_turns: number;
  min_confidence: number;
  business_hours_only: boolean;
  escalation_keywords: string[];
  updated_at: string;
};

/**
 * Load the active AI responder config for the caller's org. Returns
 * null if no config exists yet (shouldn't happen post-migration
 * 019, but defensive).
 */
export async function getAiResponderConfig(): Promise<
  Result<AiResponderConfigRow | null>
> {
  try {
    const supabase = await createClient();
    const { data: org } = await supabase
      .from("organizations")
      .select("id")
      .limit(1)
      .maybeSingle();
    if (!org) return ok(null);

    const { data, error } = await supabase
      .from("ai_responder_configs")
      .select(
        "id, active, model, system_prompt, max_turns, min_confidence, business_hours_only, escalation_keywords, updated_at",
      )
      .eq("org_id", org.id)
      .eq("active", true)
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        error: { code: "AI_CONFIG_FETCH_FAILED", message: error.message },
      };
    }
    return ok(data);
  } catch (e) {
    reportError(e, { tags: { surface: "get_ai_responder_config" } });
    return errFromUnknown(e, "AI_CONFIG_FETCH_FAILED");
  }
}

export type UpdateAiResponderInput = {
  configId: string;
  active: boolean;
  system_prompt: string;
  max_turns: number;
  min_confidence: number;
  business_hours_only: boolean;
};

/**
 * Update an AI responder config. Admin-only (same `isAdminEmail`
 * check the Team page uses — this is a system-wide tunable that
 * affects every lead's inbound reply handling).
 */
export async function updateAiResponderConfig(
  input: UpdateAiResponderInput,
): Promise<Result<null>> {
  // Input bounds — mirror the DB check constraints so users get a
  // friendly error rather than a raw constraint-violation message.
  if (input.max_turns < 1 || input.max_turns > 10) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Max turns must be between 1 and 10.",
      },
    };
  }
  if (input.min_confidence < 0 || input.min_confidence > 1) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Min confidence must be between 0 and 1.",
      },
    };
  }
  if (!input.system_prompt.trim()) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "System prompt is required.",
      },
    };
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!isAdminEmail(user?.email)) {
      return {
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "Only admins can edit the AI responder config.",
        },
      };
    }

    const { error } = await supabase
      .from("ai_responder_configs")
      .update({
        active: input.active,
        system_prompt: input.system_prompt,
        max_turns: input.max_turns,
        min_confidence: input.min_confidence,
        business_hours_only: input.business_hours_only,
        updated_at: new Date().toISOString(),
      })
      .eq("id", input.configId);
    if (error) {
      return {
        ok: false,
        error: { code: "AI_CONFIG_UPDATE_FAILED", message: error.message },
      };
    }
    revalidatePath("/settings/ai-responder");
    return ok(null);
  } catch (e) {
    reportError(e, { tags: { surface: "update_ai_responder_config" } });
    return errFromUnknown(e, "AI_CONFIG_UPDATE_FAILED");
  }
}
