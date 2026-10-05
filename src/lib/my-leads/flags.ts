import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/** Every My Leads kill switch (column of `public.my_leads_feature_flags`). */
export const MY_LEADS_FLAGS = [
  "call_next_strip",
  "post_call_prompt",
  "click_to_dial",
  "native_matcher",
  "auto_prompt",
  "callback_alert",
  "call_screen",
  "contract_card",
  "seller_reminders",
  "artifact_fetch",
  "facts_job",
  "offer_projection",
  "comp_queue",
] as const;

export type MyLeadsFlag = (typeof MY_LEADS_FLAGS)[number];

type FlagClient = {
  from(table: "my_leads_feature_flags"): {
    select(columns: string): {
      eq(
        column: "org_id",
        value: string,
      ): {
        maybeSingle(): PromiseLike<{
          data: Record<string, unknown> | null;
          error: { code?: string; message?: string } | null;
        }>;
      };
    };
  };
};

/**
 * Reads one kill switch for an org through the service-role client. A missing
 * table (42P01), missing column (42703), missing row, or any error or throw
 * reads as OFF, so a surface or job that reaches `main` before its migration is
 * applied stays inert.
 */
export async function getMyLeadsFlag(
  orgId: string,
  flag: MyLeadsFlag,
): Promise<boolean> {
  if (!orgId || !(MY_LEADS_FLAGS as readonly string[]).includes(flag)) {
    return false;
  }
  try {
    const client = createAdminClient() as unknown as FlagClient;
    const { data, error } = await client
      .from("my_leads_feature_flags")
      .select(flag)
      .eq("org_id", orgId)
      .maybeSingle();
    if (error || !data) return false;
    return data[flag] === true;
  } catch {
    return false;
  }
}
