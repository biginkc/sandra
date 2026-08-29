"use server";

import Anthropic from "@anthropic-ai/sdk";

import { loadCoachCallContext } from "./coach-context-actions";
import { createClient } from "@/lib/supabase/server";
import type { CoachRecommendationRequest, CoachRecommendationResult } from "./recommendation-types";
import { createRuntimeCacheCoachRecommendationLimiter } from "./recommendation-runtime-limiter";
import { requestCoachRecommendationsWithDeps } from "./recommendation-server";

type CoachCallIndexQuery = {
  select(columns: string): CoachCallIndexQuery;
  eq(column: string, value: string): CoachCallIndexQuery;
  maybeSingle(): Promise<{
    data: { property_id: string | null } | null;
    error: { message: string } | null;
  }>;
};

type CoachCallIndexClient = {
  from(table: "coach_call_index"): CoachCallIndexQuery;
};

const limiter = createRuntimeCacheCoachRecommendationLimiter();

export async function requestCoachRecommendations(
  input: CoachRecommendationRequest,
): Promise<CoachRecommendationResult> {
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
          .select("property_id")
          .eq("client_call_id", callId)
          .eq("operator_user_id", userId)
          .maybeSingle();
        return {
          data: result.data ? { propertyId: result.data.property_id } : null,
          error: result.error,
        };
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
