import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

type Client = SupabaseClient<Database>;

const NO_TABLE = /42P01|PGRST205|does not exist|could not find the table/i;

export type LunaResolutionSource = "ai_disposition_review" | "jev_lead_decision";

/**
 * Bookkeeping after a human resolved a Jev queue item through the NORMAL
 * controls (confirm / correct in Review Jev): if Luna had a suggestion for that
 * inbound message and nobody has accepted or rejected it yet, record what the
 * human actually applied. A different outcome counts as a rejection (with
 * applied_outcome); the same outcome records applied_outcome only ("agreed
 * manually"). Best effort: never throws, never fails the action that already
 * happened, and never touches the item itself.
 *
 * `reader` is the signed-in user's client (RLS proves they can see the item);
 * `admin` is the service-role client that owns luna_suggestions writes.
 */
export async function recordLunaResolutionForItem(
  reader: Client,
  admin: Client,
  args: {
    source: LunaResolutionSource;
    itemId: string;
    /** The outcome the human applied. null = read it from the item (confirm). */
    appliedOutcome: string | null;
    userId: string;
    now?: string;
  },
): Promise<void> {
  try {
    const item =
      args.source === "jev_lead_decision"
        ? await reader
            .from("jev_lead_decisions")
            .select("org_id, source_inbound_message_id, proposed_outcome")
            .eq("id", args.itemId)
            .maybeSingle()
        : await reader
            .from("ai_disposition_reviews")
            .select("org_id, source_inbound_message_id, disposition")
            .eq("id", args.itemId)
            .maybeSingle();
    if (item.error || !item.data) return;
    const row = item.data as Record<string, string | null>;
    const applied =
      args.appliedOutcome ?? (args.source === "jev_lead_decision" ? row.proposed_outcome : row.disposition) ?? null;
    if (!applied || !row.source_inbound_message_id || !row.org_id) return;

    const { data: sug, error } = await admin
      .from("luna_suggestions")
      .select("id, outcome, accepted_at, rejected_at, applied_outcome")
      .eq("org_id", row.org_id)
      .eq("inbound_message_id", row.source_inbound_message_id)
      .maybeSingle();
    if (error) {
      if (!NO_TABLE.test(`${(error as { code?: string }).code ?? ""} ${error.message}`)) {
        reportError(new Error(error.message), { tags: { surface: "luna_record_resolution" } });
      }
      return;
    }
    if (!sug || sug.accepted_at || sug.rejected_at) return;

    const now = args.now ?? new Date().toISOString();
    const patch =
      applied === sug.outcome
        ? { applied_outcome: applied }
        : { rejected_at: now, rejected_by: args.userId, applied_outcome: applied };
    const { error: updateError } = await admin
      .from("luna_suggestions")
      .update(patch)
      .eq("id", sug.id)
      .is("accepted_at", null)
      .is("rejected_at", null);
    if (updateError) reportError(new Error(updateError.message), { tags: { surface: "luna_record_resolution" } });
  } catch (e) {
    reportError(e, { tags: { surface: "luna_record_resolution" } });
  }
}
