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
 * produce the same body. Different seeds distribute deterministically across
 * the pool via SHA-256 hash mod pool size; this is distribution, not a strict
 * no-repeat rotation.
 *
 * @param seed  Typically enrollment.id (sequences) or the batch position
 *              string (bulk send) to distribute recipients deterministically.
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
  return data[poolIndex(seed, data.length)];
}

/** SHA-256(seed) mod size: the same seed always maps to the same slot. */
export function poolIndex(seed: string, size: number): number {
  const hash = crypto.createHash("sha256").update(seed).digest();
  return hash.readUInt32BE(0) % size;
}

/**
 * Pick one saved voicemail script from a group, the same way pickFromPool
 * picks SMS templates. Reads voicemail_templates only, never sms_templates,
 * so a text template can never be read aloud.
 */
export async function pickVoicemailFromPool(
  supabase: SupabaseClient<Database>,
  orgId: string,
  category: string,
  seed: string,
): Promise<PoolTemplate | null> {
  const { data, error } = await supabase
    .from("voicemail_templates")
    .select("id, content")
    .eq("org_id", orgId)
    .eq("category", category)
    .is("deleted_at", null)
    .order("id");
  if (error || !data || data.length === 0) return null;
  return data[poolIndex(seed, data.length)];
}
