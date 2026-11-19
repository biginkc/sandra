import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import { V2_REPLY_CATEGORY, V2_REPLY_NAMES, V2_REPLY_TEXTS, type V2ReplyKey } from "./reply-texts";

/**
 * Idempotent seed of the routing v2 approved reply texts into one org's Templates library,
 * UNAPPROVED (same contract as `seedApprovedReplyTemplates`): `approved_for_auto_send`
 * stays false, no mapping is created, so nothing can send until an owner approves and maps
 * the template AND `routing_v2_flags.replies` is on. A key whose exact text already lives
 * in the org is skipped.
 */
export async function seedV2ReplyTemplates(
  supabase: SupabaseClient<Database>,
  orgId: string,
  options: { dryRun?: boolean } = {},
): Promise<{ created: V2ReplyKey[]; alreadyPresent: V2ReplyKey[] }> {
  const result = { created: [] as V2ReplyKey[], alreadyPresent: [] as V2ReplyKey[] };
  const keys = Object.keys(V2_REPLY_TEXTS) as V2ReplyKey[];
  const { data: existing, error } = await supabase
    .from("sms_templates")
    .select("content")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .in("content", keys.map((k) => V2_REPLY_TEXTS[k]));
  if (error) throw new Error(`seedV2ReplyTemplates lookup: ${error.message}`);
  const present = new Set((existing ?? []).map((row) => row.content));
  for (const key of keys) {
    const content = V2_REPLY_TEXTS[key];
    if (present.has(content)) {
      result.alreadyPresent.push(key);
      continue;
    }
    if (!options.dryRun) {
      const { error: insertError } = await supabase
        .from("sms_templates")
        .insert({ org_id: orgId, name: V2_REPLY_NAMES[key], content, category: V2_REPLY_CATEGORY });
      if (insertError) throw new Error(`seedV2ReplyTemplates insert ${key}: ${insertError.message}`);
    }
    result.created.push(key);
  }
  return result;
}
