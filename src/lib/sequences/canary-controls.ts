import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

export type CanaryControlKey =
  | "SEQUENCE_CANARY_SCHEDULE_ENABLED"
  | "SEQUENCE_CANARY_FAILURE_ACK_RUN_ID"
  | "SEQUENCE_CANARY_MANUAL_RUN_ID";

/** No cached state. A missing row, duplicate, or failed read stops the canary. */
export async function readCanaryControl(client: SupabaseClient<Database>, key: CanaryControlKey): Promise<string> {
  const { data, error } = await client.from("sequence_canary_controls")
    .select("value").eq("key", key).single();
  if (error || !data || typeof data.value !== "string") {
    throw new Error(`Canary control ${key} unavailable`);
  }
  return data.value;
}
