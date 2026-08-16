import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/types";

type PromotionRpcClient = Pick<SupabaseClient<Database>, "rpc">;

export type PromotionItemOutcome =
  | "promoted"
  | "already_lead"
  | "dnc_locked"
  | "missing"
  | "failed";

function outcomeFromRpc(data: Json | null): PromotionItemOutcome {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const outcome = data.outcome;
    if (
      outcome === "promoted" ||
      outcome === "already_lead" ||
      outcome === "dnc_locked" ||
      outcome === "missing" ||
      outcome === "failed"
    ) {
      return outcome;
    }
  }
  return "failed";
}

/**
 * Run one durable workflow chunk. The atomic SQL RPC owns every compliance
 * recheck and property write; this helper only advances item keys and ensures
 * an infrastructure error is itself durably checkpointed before continuing.
 */
export async function runPromoteLeadsChunk(
  supabase: PromotionRpcClient,
  args: { jobId: string; itemKeys: string[] },
): Promise<Array<{ itemKey: string; outcome: PromotionItemOutcome }>> {
  const outcomes: Array<{ itemKey: string; outcome: PromotionItemOutcome }> = [];

  for (const itemKey of args.itemKeys) {
    const { data, error } = await supabase.rpc("process_promote_leads_item", {
      p_job: args.jobId,
      p_item_key: itemKey,
    });
    if (!error) {
      outcomes.push({ itemKey, outcome: outcomeFromRpc(data) });
      continue;
    }

    const checkpoint = await supabase.rpc("fail_promote_leads_item", {
      p_job: args.jobId,
      p_item_key: itemKey,
      p_error: error.message,
    });
    if (checkpoint.error) {
      throw new Error(
        `Promotion item ${itemKey} failed and its checkpoint failed: ${checkpoint.error.message}`,
      );
    }
    outcomes.push({ itemKey, outcome: "failed" });
  }

  return outcomes;
}
