import { createClient } from "@/lib/supabase/server";
import { listThreads } from "@/lib/messages/list-threads";

import { markMessagesReadForProperty } from "../leads/actions";

import { CockpitView } from "./cockpit-view";
import { fetchInboxDetail } from "./inbox-detail-data";
import { type QueuedRow } from "./queue-panel";

export const metadata = {
  title: "Messages · Sandra CRM",
};

/**
 * Cockpit page — two tabs:
 *
 *   1. Inbox  (default) — Slack/iPhone-style conversation list with a
 *      side-panel detail view. Click a thread, reply inline, sends
 *      immediately via the existing send-now path. Replaces the Dialpad
 *      app for live conversation work.
 *
 *   2. Outbox — the legacy queue panel: drafts waiting to release with
 *      cadence (Send Next / Auto-send). Unchanged.
 *
 * State (active tab, selected thread) lives in the URL query string so
 * cockpit URLs are shareable.
 */
export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; thread?: string }>;
}) {
  const sp = await searchParams;
  const activeTab = sp.tab === "outbox" ? "outbox" : "inbox";
  const selectedContactId = sp.thread ?? null;

  const supabase = await createClient();

  // Fetch everything in parallel — cockpit needs all three datasets to
  // render either tab cleanly without a second roundtrip.
  const [threads, queuedResult, threadDetail] = await Promise.all([
    listThreads(supabase, {}),
    supabase
      .from("messages")
      .select(
        `id, body, from_address, to_address, created_at, property_id, contact_id,
         property:properties(id, address, city, state),
         contact:contacts(id, first_name, last_name, entity_name, phone_1)`,
      )
      .eq("status", "queued")
      .order("created_at", { ascending: true }),
    selectedContactId
      ? fetchInboxDetail(supabase, selectedContactId)
      : Promise.resolve(null),
  ]);

  const queued: QueuedRow[] = (queuedResult.data ?? []).map((r) => ({
    id: r.id,
    body: r.body,
    fromAddress: r.from_address,
    toAddress: r.to_address,
    createdAt: r.created_at,
    propertyId: r.property_id,
    contactId: r.contact_id,
    propertyAddress: r.property
      ? [r.property.address, r.property.city, r.property.state]
          .filter(Boolean)
          .join(", ")
      : null,
    contactName: r.contact
      ? (r.contact.entity_name ??
        ([r.contact.first_name, r.contact.last_name]
          .filter(Boolean)
          .join(" ") || null))
      : null,
    contactPhone: r.contact?.phone_1 ?? null,
  }));

  // Stamp messages as read whenever a thread is opened. Idempotent — the
  // partial index `WHERE read_at IS NULL` short-circuits if nothing's
  // unread. Done here on the server (not on click in the client) so a
  // direct deeplink also clears the badge.
  if (threadDetail?.propertyId) {
    await markMessagesReadForProperty(threadDetail.propertyId);
  }

  return (
    <CockpitView
      activeTab={activeTab}
      threads={threads}
      queued={queued}
      threadDetail={threadDetail}
    />
  );
}
