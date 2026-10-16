import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import {
  APPROVED_REPLY_CATEGORY,
  APPROVED_REPLY_NAMES,
  APPROVED_REPLY_TEXTS,
  type ApprovedReplyKey,
} from "./approved-reply-texts";

export type SeedReplyTemplatesResult = {
  created: ApprovedReplyKey[];
  alreadyPresent: ApprovedReplyKey[];
};

/**
 * Idempotent seed of the four approved reply texts into one org's Templates
 * library. Every row is inserted UNAPPROVED (`approved_for_auto_send` stays
 * false; the database trigger refuses anything else from a non-RPC writer), so
 * nothing can send until an owner clicks Approve. A key is skipped when a live
 * (not deleted) template with that exact text already exists in the org, so a
 * re-run, or an owner who already created the text by hand, never duplicates it.
 * Mappings are NOT created here: choosing which template answers which label
 * is an owner decision in the Templates UI.
 */
export async function seedApprovedReplyTemplates(
  supabase: SupabaseClient<Database>,
  orgId: string,
  options: { dryRun?: boolean } = {},
): Promise<SeedReplyTemplatesResult> {
  const result: SeedReplyTemplatesResult = { created: [], alreadyPresent: [] };
  const keys = Object.keys(APPROVED_REPLY_TEXTS) as ApprovedReplyKey[];

  const { data: existing, error } = await supabase
    .from("sms_templates")
    .select("content")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .in(
      "content",
      keys.map((key) => APPROVED_REPLY_TEXTS[key]),
    );
  if (error) throw new Error(`seedApprovedReplyTemplates lookup: ${error.message}`);
  const present = new Set((existing ?? []).map((row) => row.content));

  for (const key of keys) {
    const content = APPROVED_REPLY_TEXTS[key];
    if (present.has(content)) {
      result.alreadyPresent.push(key);
      continue;
    }
    if (!options.dryRun) {
      const { error: insertError } = await supabase.from("sms_templates").insert({
        org_id: orgId,
        name: APPROVED_REPLY_NAMES[key],
        content,
        category: APPROVED_REPLY_CATEGORY,
      });
      if (insertError) throw new Error(`seedApprovedReplyTemplates insert ${key}: ${insertError.message}`);
    }
    result.created.push(key);
  }
  return result;
}
