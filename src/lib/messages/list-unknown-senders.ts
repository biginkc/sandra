import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

export type UnknownSender = {
  fromAddress: string;
  toAddress: string | null;
  latestBody: string;
  latestAt: string;
  messageCount: number;
  isDismissed: boolean;
};

export type ListUnknownSendersOpts = {
  /**
   * Include rows where dismissed_at IS NOT NULL. Default false (the
   * Unknown bucket). Set true to render the Dismissed sub-tab.
   */
  includeDismissed?: boolean;
};

/**
 * Fetch every inbound SMS row that has no contact_id, group by sender
 * phone, and return one row per distinct from_address with the latest
 * message preview + total count from that sender.
 *
 * The 72-and-growing leak in prod (and ~10/day on working days) is
 * everything this query surfaces. From there a VA can match it to an
 * existing contact, create a new contact + property, or dismiss.
 */
export async function listUnknownSenders(
  supabase: SupabaseClient<Database>,
  opts: ListUnknownSendersOpts,
): Promise<UnknownSender[]> {
  const includeDismissed = opts.includeDismissed ?? false;

  let query = supabase
    .from("messages")
    .select("from_address, to_address, body, created_at, dismissed_at")
    .eq("channel", "sms")
    .eq("direction", "inbound")
    .is("contact_id", null)
    .not("from_address", "is", null)
    .order("created_at", { ascending: false });
  if (!includeDismissed) {
    query = query.is("dismissed_at", null);
  }

  const { data, error } = await query;
  if (error) throw new Error(`listUnknownSenders: ${error.message}`);
  if (!data || data.length === 0) return [];

  type Bucket = {
    latestBody: string;
    latestAt: string;
    toAddress: string | null;
    messageCount: number;
    isDismissed: boolean;
  };
  const byFrom = new Map<string, Bucket>();
  for (const m of data) {
    if (!m.from_address) continue;
    const existing = byFrom.get(m.from_address);
    if (!existing) {
      byFrom.set(m.from_address, {
        latestBody: m.body,
        latestAt: m.created_at,
        toAddress: m.to_address,
        messageCount: 1,
        // The query is sorted DESC by created_at, so the first row we
        // see for a sender is the latest. Whether that latest row is
        // dismissed determines the sender's display state.
        isDismissed: m.dismissed_at !== null,
      });
    } else {
      existing.messageCount += 1;
    }
  }

  return Array.from(byFrom.entries())
    .map(([fromAddress, b]) => ({
      fromAddress,
      toAddress: b.toAddress,
      latestBody: b.latestBody,
      latestAt: b.latestAt,
      messageCount: b.messageCount,
      isDismissed: b.isDismissed,
    }))
    .sort((a, b) => b.latestAt.localeCompare(a.latestAt));
}
