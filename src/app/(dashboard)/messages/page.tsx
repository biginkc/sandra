import { createClient } from "@/lib/supabase/server";

import { QueuePanel, type QueuedRow } from "./queue-panel";

export const metadata = {
  title: "Messages · Sandra CRM",
};

/**
 * Messages queue page. Lists every `messages` row with status='queued'
 * alongside its property address and contact name, then hands off to a
 * client component for the Send Next / Auto-send / Edit / Delete
 * controls. Server-rendered for the first paint; Realtime keeps it in
 * sync as rows leave the queue (status changes from queued → pending →
 * sent|failed).
 */
export default async function MessagesPage() {
  const supabase = await createClient();

  const { data: queuedRaw, error } = await supabase
    .from("messages")
    .select(
      `id, body, from_address, to_address, created_at, property_id, contact_id,
       property:properties(id, address, city, state),
       contact:contacts(id, first_name, last_name, entity_name, phone_1)`,
    )
    .eq("status", "queued")
    .order("created_at", { ascending: true });

  const queued: QueuedRow[] = (queuedRaw ?? []).map((r) => ({
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
      ? r.contact.entity_name ??
        ([r.contact.first_name, r.contact.last_name]
          .filter(Boolean)
          .join(" ") ||
          null)
      : null,
    contactPhone: r.contact?.phone_1 ?? null,
  }));

  return (
    <div className="flex flex-col gap-4 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Messages</h1>
        <p className="text-muted-foreground text-sm">
          Queued SMS waiting to be released. Drafted on lead pages, sent
          one-at-a-time from here at a cadence that keeps carrier reputation
          intact. Consent + quiet-hours are re-checked at release.
        </p>
      </div>

      {error ? (
        <div className="text-destructive text-sm">
          Failed to load queue: {error.message}
        </div>
      ) : null}

      <QueuePanel initial={queued} />
    </div>
  );
}
