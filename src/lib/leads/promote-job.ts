import type { SupabaseClient } from "@supabase/supabase-js";

import { LEAD_EVENT_TYPES, recordLeadEvents } from "@/lib/events";
import type { Database, Json } from "@/lib/supabase/types";

type PromotionRpcClient = Pick<SupabaseClient<Database>, "rpc">;

export type PromotionChunkItem = {
  id: string;
  itemKey: string;
  propertyId: string | null;
};

type PromotedChunkItem = PromotionChunkItem & { propertyId: string };

export type PromotionItemOutcome =
  "promoted" | "already_lead" | "dnc_locked" | "missing" | "failed";

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
  args: {
    jobId: string;
    actorId: string;
    items: PromotionChunkItem[];
  },
): Promise<Array<{ itemKey: string; outcome: PromotionItemOutcome }>> {
  const outcomes: Array<{ itemKey: string; outcome: PromotionItemOutcome }> =
    [];
  const promoted: PromotedChunkItem[] = [];

  for (const item of args.items) {
    const { data, error } = await supabase.rpc("process_promote_leads_item", {
      p_job: args.jobId,
      p_item_key: item.itemKey,
    });
    if (!error) {
      const outcome = outcomeFromRpc(data);
      outcomes.push({ itemKey: item.itemKey, outcome });
      if (outcome === "promoted" && item.propertyId) {
        promoted.push({ ...item, propertyId: item.propertyId });
      }
      continue;
    }

    const checkpoint = await supabase.rpc("fail_promote_leads_item", {
      p_job: args.jobId,
      p_item_key: item.itemKey,
      p_error: error.message,
    });
    if (checkpoint.error) {
      throw new Error(
        `Promotion item ${item.itemKey} failed and its checkpoint failed: ${checkpoint.error.message}`,
      );
    }
    outcomes.push({ itemKey: item.itemKey, outcome: "failed" });
  }

  if (promoted.length > 0) {
    const batchId = crypto.randomUUID();
    await recordLeadEvents(
      promoted.map((item) => ({
        propertyId: item.propertyId,
        actorType: "user" as const,
        actorId: args.actorId,
        eventType: LEAD_EVENT_TYPES.QUALIFIED,
        payload: {
          from: "prospect",
          to: "new_lead",
          batch_id: batchId,
          batch_count: promoted.length,
        },
        sourceType: "job_items.qualified",
        sourceId: item.id,
      })),
    );
  }

  return outcomes;
}
