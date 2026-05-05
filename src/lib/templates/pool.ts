import crypto from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

type PoolTemplate = {
  id: string;
  content: string;
};

/**
 * Pick one template from a named pool deterministically.
 *
 * The same seed always returns the same template, so retries and replays
 * produce the same body. Different seeds distribute uniformly across the
 * pool via SHA-256 hash mod pool size.
 *
 * @param seed  Typically enrollment.id (sequences) or the batch position
 *              string (bulk send) so every recipient gets a distinct variant.
 */
export async function pickFromPool(
  supabase: SupabaseClient<Database>,
  orgId: string,
  category: string,
  seed: string,
): Promise<PoolTemplate | null> {
  const { data, error } = await supabase
    .from("sms_templates")
    .select("id, content")
    .eq("org_id", orgId)
    .eq("category", category)
    .is("deleted_at", null)
    .order("id"); // stable order so the same index always maps to the same row

  if (error || !data || data.length === 0) return null;

  const hash = crypto.createHash("sha256").update(seed).digest();
  const index = hash.readUInt32BE(0) % data.length;
  return data[index];
}
