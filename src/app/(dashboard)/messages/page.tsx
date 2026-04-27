import { createClient } from "@/lib/supabase/server";
import { listThreads } from "@/lib/messages/list-threads";
import { listUnknownSenders } from "@/lib/messages/list-unknown-senders";

import { markMessagesReadForProperty } from "../leads/actions";

import { CockpitView } from "./cockpit-view";
import { fetchInboxDetail } from "./inbox-detail-data";
import { type InboxFilter } from "./inbox-filters";
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
 *      Filters: All (default), Unknown (Phase 2 — unmatched inbounds),
 *      Dismissed (Phase 2 — soft-deleted unknown senders).
 *
 *   2. Outbox — the legacy queue panel: drafts waiting to release with
 *      cadence (Send Next / Auto-send). Unchanged.
 *
 * State (active tab, filter, selected thread) lives in the URL query
 * string so cockpit URLs are shareable.
 */
export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; thread?: string; filter?: string }>;
}) {
  const sp = await searchParams;
  const activeTab = sp.tab === "outbox" ? "outbox" : "inbox";
  const filter: InboxFilter =
    sp.filter === "unknown"
      ? "unknown"
      : sp.filter === "dismissed"
        ? "dismissed"
        : "all";
  const selectedContactId = sp.thread ?? null;

  const supabase = await createClient();

  // Fetch everything in parallel. The thread list + unknown active count
  // are needed regardless of which filter is active (badge counts on the
  // tab + filter chips). Other queries are conditional on the filter.
  const [threads, queuedResult, threadDetail, unknownActive, unknownAll] =
    await Promise.all([
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
      filter === "all" && selectedContactId
        ? fetchInboxDetail(supabase, selectedContactId)
        : Promise.resolve(null),
      listUnknownSenders(supabase, {}),
      filter === "dismissed"
        ? listUnknownSenders(supabase, { includeDismissed: true })
        : Promise.resolve([]),
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

  if (filter === "all" && threadDetail?.propertyId) {
    await markMessagesReadForProperty(threadDetail.propertyId);
  }

  const unknownSenders =
    filter === "dismissed"
      ? unknownAll.filter((s) => s.isDismissed)
      : unknownActive;

  return (
    <CockpitView
      activeTab={activeTab}
      filter={filter}
      threads={threads}
      queued={queued}
      threadDetail={threadDetail}
      unknownSenders={unknownSenders}
      unknownActiveCount={unknownActive.length}
    />
  );
}
