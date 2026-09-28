"use server";

import Anthropic from "@anthropic-ai/sdk";
import type { ScriptBundle } from "@biginkc/coach";

import { loadCoachCallContext } from "./coach-context-actions";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { CoachRecommendationResult } from "./recommendation-types";
import { createRuntimeCacheCoachRecommendationLimiter } from "./recommendation-runtime-limiter";
import {
  invalidCoachRecommendationRequestResult,
  parseCoachRecommendationRequest,
  requestCoachRecommendationsWithDeps,
} from "./recommendation-server";

type CoachCallIndexQuery = {
  select(columns: string): CoachCallIndexQuery;
  eq(column: string, value: string): CoachCallIndexQuery;
  maybeSingle(): Promise<{
    data: { property_id: string | null; script_digest: string | null } | null;
    error: { message: string } | null;
  }>;
};

type CoachCallIndexClient = {
  from(table: "coach_call_index"): CoachCallIndexQuery;
};

const limiter = createRuntimeCacheCoachRecommendationLimiter();

export async function requestCoachRecommendations(
  rawInput: unknown,
): Promise<CoachRecommendationResult> {
  const input = parseCoachRecommendationRequest(rawInput);
  if (!input) return invalidCoachRecommendationRequestResult();

  // Recommendations are deliberately an explicit server-side opt-in. Keep
  // the live script and transcript flow available while preventing a disabled
  // recommendation surface from authenticating, reading call data, or
  // constructing a provider client.
  if (process.env.COACH_RECOMMENDATIONS_ENABLED !== "1") {
    return {
      ok: false,
      requestId: input.requestId,
      callId: input.callId,
      activeSectionId: input.activeSectionId,
      mode: input.mode,
      code: "provider_error",
    };
  }

  const supabase = await createClient();
  const coachIndex = supabase as unknown as CoachCallIndexClient;

  return requestCoachRecommendationsWithDeps(input, {
    auth: {
      getUser: () => supabase.auth.getUser(),
    },
    calls: {
      async findOwnedCall({ callId, userId }) {
        const result = await coachIndex
          .from("coach_call_index")
          .select("property_id, script_digest")
          .eq("client_call_id", callId)
          .eq("operator_user_id", userId)
          .maybeSingle();
        return {
          data: result.data ? { propertyId: result.data.property_id, scriptDigest: result.data.script_digest } : null,
          error: result.error,
        };
      },
    },
    scripts: {
      async loadByDigest({ digest }) {
        const admin = createAdminClient() as unknown as {
          from(table: "coach_script_revisions"): { select(columns: string): { eq(column: string, value: string): { maybeSingle(): Promise<{ data: { bundle: unknown } | null; error: { message: string } | null }> } } };
        };
        const result = await admin.from("coach_script_revisions").select("bundle").eq("digest", digest).maybeSingle();
        return { data: result.data?.bundle as ScriptBundle | undefined ?? null, error: result.error };
      },
    },
    contexts: {
      async load({ propertyId }) {
        try {
          const context = await loadCoachCallContext({
            propertyId,
            sellerPhoneE164: null,
            repPhoneE164: null,
          });
          return {
            data: {
              sellerName: context.sellerName,
              propertyAddress: context.propertyAddress,
              propertyCounty: context.propertyCounty,
              yearBuilt: context.yearBuilt,
              leadSource: context.leadSource,
              occupancy: context.occupancy,
            },
            error: null,
          };
        } catch {
          return { data: null, error: { message: "context unavailable" } };
        }
      },
    },
    anthropic: new Anthropic(),
    limiter,
  });
}
