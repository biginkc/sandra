import { redirect } from "next/navigation";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { NORMA_QUEUE_COPY } from "@/lib/norma/queue/copy";
import { readNormaQueueConfig } from "@/lib/norma/queue/config";
import { createClient } from "@/lib/supabase/server";

import { NormaQueueTable, type NormaQueueRow } from "./queue-table";

export const metadata = { title: `${NORMA_QUEUE_COPY.page.title} · Sandra CRM` };
export const dynamic = "force-dynamic";

type Entry = { id: string; property_id: string; status: string; pause_reason: string | null; blocked_reason: string | null; next_attempt_at: string | null; display_tz: string | null };

type LooseQuery = PromiseLike<{ data: unknown; count?: number | null }> & {
  select: (columns: string, options?: { count: "exact"; head: true }) => LooseQuery;
  in: (column: string, values: string[]) => LooseQuery;
  eq: (column: string, value: string) => LooseQuery;
  gte: (column: string, value: string) => LooseQuery;
  order: (column: string, options: { ascending: boolean }) => LooseQuery;
  limit: (n: number) => LooseQuery;
};

export default async function NormaQueuePage() {
  const client = await createClient();
  const {
    data: { user },
    error: authError,
  } = await client.auth.getUser();
  if (authError || !user) redirect("/login");

  const from = (table: string) => (client as unknown as { from: (t: string) => LooseQuery }).from(table);
  const config = readNormaQueueConfig(process.env);

  const { data: entryData } = await from("norma_queue_entries")
    .select("id, property_id, status, pause_reason, blocked_reason, next_attempt_at, display_tz")
    .in("status", ["queued", "calling", "paused"])
    .order("next_attempt_at", { ascending: true })
    .limit(500);
  const entries = (entryData ?? []) as Entry[];
  const propertyIds = [...new Set(entries.map((entry) => entry.property_id))];

  const [{ data: propertyData }, { data: reassignData }, { data: attemptData }, { count: held }] = await Promise.all([
    propertyIds.length ? from("properties").select("id, address").in("id", propertyIds) : Promise.resolve({ data: [] }),
    propertyIds.length ? from("norma_followup_reassignments").select("property_id").eq("status", "open").in("property_id", propertyIds) : Promise.resolve({ data: [] }),
    from("norma_queue_attempts").select("sent_at").gte("sent_at", new Date(Date.now() - 36 * 3600_000).toISOString()),
    from("norma_call_requests").select("id", { count: "exact", head: true }).eq("status", "needs_review").limit(1),
  ]);

  const address = new Map(((propertyData ?? []) as Array<{ id: string; address: string }>).map((row) => [row.id, row.address]));
  const reassign = new Set(((reassignData ?? []) as Array<{ property_id: string }>).map((row) => row.property_id));
  const dayOf = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: config.capTz }).format(date);
  const today = dayOf(new Date());
  const todayCount = ((attemptData ?? []) as Array<{ sent_at: string | null }>).filter((row) => row.sent_at && dayOf(new Date(row.sent_at)) === today).length;

  const rows: NormaQueueRow[] = entries.map((entry) => ({
    id: entry.id,
    propertyId: entry.property_id,
    address: address.get(entry.property_id) ?? entry.property_id,
    status: entry.status,
    pauseReason: entry.pause_reason,
    blockedReason: entry.blocked_reason,
    nextAttemptAt: entry.next_attempt_at,
    displayTz: entry.display_tz,
    needsReassignment: reassign.has(entry.property_id),
  }));

  return <Page>
    <PageHeader title={NORMA_QUEUE_COPY.page.title} />
    <NormaQueueTable rows={rows} todayCount={todayCount} dailyCap={config.dailyCap ?? 0} heldSlots={held ?? 0} />
  </Page>;
}
