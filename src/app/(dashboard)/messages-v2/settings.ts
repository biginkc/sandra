import type { LooseSupabase } from "./queries";

/**
 * Seeds the org's Messages v2 cutover (messages_v2_settings.backlog_before)
 * the first time the page loads; the column's DB default (now()) stamps it,
 * so the cutover is database time, not app-server time. `ignoreDuplicates` makes it
 * `insert ... on conflict do nothing`, so an existing cutover is never moved.
 * Returns false when the seed failed (the hold classification will then report
 * unavailable rather than guess).
 */
export async function ensureMessagesV2Settings(
  admin: LooseSupabase,
  orgId: string,
): Promise<boolean> {
  const { error } = await admin
    .from("messages_v2_settings")
    .upsert(
      { org_id: orgId },
      { onConflict: "org_id", ignoreDuplicates: true },
    );
  return !error;
}
