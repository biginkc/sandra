import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

type MessageRow = Database["public"]["Tables"]["messages"]["Row"];
type PropertyRow = Database["public"]["Tables"]["properties"]["Row"];

export type SendilloSmsHealthMessageRow = Pick<
  MessageRow,
  | "id"
  | "channel"
  | "provider"
  | "direction"
  | "status"
  | "contact_id"
  | "property_id"
  | "conversation_id"
  | "created_at"
  | "read_at"
>;

export type SendilloSmsHealthPropertyRow = Pick<
  PropertyRow,
  "id" | "outreach_dispo" | "needs_human_attention"
>;

export type SendilloSmsHealth = {
  smsRows: number;
  outboundMessages: number;
  inboundMessages: number;
  conversations: number;
  latestInboundMissingDisposition: number;
  unreadMissingDisposition: number;
  humanAttentionMissingDisposition: number;
  anyInboundMissingDisposition: number;
  firstMessageAt: string | null;
  latestMessageAt: string | null;
};

export type SendilloSmsHealthResult =
  | {
      status: "available";
      health: SendilloSmsHealth;
      updatedAt: string;
    }
  | {
      status: "unavailable";
      health: SendilloSmsHealth;
      message: string;
    };

export const EMPTY_SENDILLO_SMS_HEALTH: SendilloSmsHealth = {
  smsRows: 0,
  outboundMessages: 0,
  inboundMessages: 0,
  conversations: 0,
  latestInboundMissingDisposition: 0,
  unreadMissingDisposition: 0,
  humanAttentionMissingDisposition: 0,
  anyInboundMissingDisposition: 0,
  firstMessageAt: null,
  latestMessageAt: null,
};

type ThreadBucket = {
  latest: SendilloSmsHealthMessageRow;
  hasInbound: boolean;
  hasUnreadInbound: boolean;
};

const SENDILLO_HEALTH_PAGE_SIZE = 1000;

export function summarizeSendilloSmsHealth(
  rows: SendilloSmsHealthMessageRow[],
  propertiesById: ReadonlyMap<string, SendilloSmsHealthPropertyRow>,
): SendilloSmsHealth {
  const sendilloSmsRows = rows.filter(
    (row) => row.channel === "sms" && row.provider === "sendillo",
  );
  const summary = countRows(sendilloSmsRows);
  const buckets = bucketThreads(sendilloSmsRows);
  summary.conversations = buckets.size;
  applyDispositionCounts(summary, buckets, propertiesById);
  return summary;
}

function countRows(rows: SendilloSmsHealthMessageRow[]): SendilloSmsHealth {
  const summary = { ...EMPTY_SENDILLO_SMS_HEALTH, smsRows: rows.length };
  for (const row of rows) {
    if (row.direction === "outbound" && row.status !== "queued") {
      summary.outboundMessages += 1;
    }
    if (row.direction === "inbound") summary.inboundMessages += 1;
    summary.firstMessageAt = minIso(summary.firstMessageAt, row.created_at);
    summary.latestMessageAt = maxIso(summary.latestMessageAt, row.created_at);
  }
  return summary;
}

function bucketThreads(
  rows: SendilloSmsHealthMessageRow[],
): Map<string, ThreadBucket> {
  const buckets = new Map<string, ThreadBucket>();
  for (const row of rows) {
    if (row.status === "queued") continue;
    upsertThreadBucket(buckets, row);
  }
  return buckets;
}

function upsertThreadBucket(
  buckets: Map<string, ThreadBucket>,
  row: SendilloSmsHealthMessageRow,
) {
  const key = threadKey(row);
  const bucket = buckets.get(key);
  if (!bucket) {
    buckets.set(key, newThreadBucket(row));
    return;
  }

  bucket.hasInbound ||= isInbound(row);
  bucket.hasUnreadInbound ||= isUnreadInbound(row);
  if (isLater(row, bucket.latest)) {
    bucket.latest = row;
  }
}

function newThreadBucket(row: SendilloSmsHealthMessageRow): ThreadBucket {
  return {
    latest: row,
    hasInbound: isInbound(row),
    hasUnreadInbound: isUnreadInbound(row),
  };
}

function applyDispositionCounts(
  summary: SendilloSmsHealth,
  buckets: ReadonlyMap<string, ThreadBucket>,
  propertiesById: ReadonlyMap<string, SendilloSmsHealthPropertyRow>,
) {
  for (const bucket of buckets.values()) {
    const property = linkedUndispositionedProperty(bucket, propertiesById);
    if (!property) continue;
    if (isInbound(bucket.latest)) {
      summary.latestInboundMissingDisposition += 1;
    }
    if (bucket.hasUnreadInbound) {
      summary.unreadMissingDisposition += 1;
    }
    if (property.needs_human_attention) {
      summary.humanAttentionMissingDisposition += 1;
    }
    if (bucket.hasInbound) {
      summary.anyInboundMissingDisposition += 1;
    }
  }
}

function linkedUndispositionedProperty(
  bucket: ThreadBucket,
  propertiesById: ReadonlyMap<string, SendilloSmsHealthPropertyRow>,
): SendilloSmsHealthPropertyRow | null {
  const linkedPropertyId = bucket.latest.property_id;
  if (!linkedPropertyId) return null;
  const property = propertiesById.get(linkedPropertyId);
  if (!property || property.outreach_dispo !== null) return null;
  return property;
}

export async function loadSendilloSmsHealth(
  supabase: SupabaseClient<Database>,
): Promise<SendilloSmsHealth> {
  const rows = await fetchSendilloMessageRows(supabase);
  const threadLatestPropertyIds = latestLinkedPropertyIds(rows);
  const properties = await fetchPropertiesById(supabase, threadLatestPropertyIds);
  return summarizeSendilloSmsHealth(
    rows,
    new Map(properties.map((property) => [property.id, property])),
  );
}

async function fetchSendilloMessageRows(
  supabase: SupabaseClient<Database>,
): Promise<SendilloSmsHealthMessageRow[]> {
  const rows: SendilloSmsHealthMessageRow[] = [];
  let cursor: SendilloSmsHealthMessageRow | null = null;

  for (;;) {
    let query = supabase
      .from("messages")
      .select(
        "id, channel, provider, direction, status, contact_id, property_id, conversation_id, created_at, read_at",
      )
      .eq("channel", "sms")
      .eq("provider", "sendillo")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(SENDILLO_HEALTH_PAGE_SIZE);

    if (cursor) {
      query = query.or(
        `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`,
      );
    }

    const { data, error } = await query;

    if (error) throw new Error(`loadSendilloSmsHealth messages: ${error.message}`);

    const page = (data ?? []) as SendilloSmsHealthMessageRow[];
    rows.push(...page);
    if (page.length < SENDILLO_HEALTH_PAGE_SIZE) break;
    cursor = page[page.length - 1] ?? null;
    if (!cursor) break;
  }
  return rows;
}

function threadKey(row: SendilloSmsHealthMessageRow): string {
  if (row.conversation_id) return `conversation:${row.conversation_id}`;
  if (row.contact_id || row.property_id) {
    return `legacy:${row.contact_id ?? "none"}:${row.property_id ?? "none"}`;
  }
  return `message:${row.id}`;
}

function isLater(
  candidate: SendilloSmsHealthMessageRow,
  current: SendilloSmsHealthMessageRow,
): boolean {
  if (candidate.created_at !== current.created_at) {
    return candidate.created_at > current.created_at;
  }
  return candidate.id > current.id;
}

function isInbound(row: SendilloSmsHealthMessageRow): boolean {
  return row.direction === "inbound";
}

function isUnreadInbound(row: SendilloSmsHealthMessageRow): boolean {
  return isInbound(row) && row.read_at === null;
}

function minIso(current: string | null, next: string): string {
  return !current || next < current ? next : current;
}

function maxIso(current: string | null, next: string): string {
  return !current || next > current ? next : current;
}

function latestLinkedPropertyIds(rows: SendilloSmsHealthMessageRow[]): string[] {
  const buckets = new Map<string, SendilloSmsHealthMessageRow>();
  for (const row of rows) {
    if (row.channel !== "sms" || row.provider !== "sendillo" || row.status === "queued") {
      continue;
    }
    const key = threadKey(row);
    const current = buckets.get(key);
    if (!current || isLater(row, current)) {
      buckets.set(key, row);
    }
  }

  return Array.from(
    new Set(
      Array.from(buckets.values())
        .map((row) => row.property_id)
        .filter((id): id is string => id !== null),
    ),
  );
}

async function fetchPropertiesById(
  supabase: SupabaseClient<Database>,
  propertyIds: string[],
): Promise<SendilloSmsHealthPropertyRow[]> {
  if (propertyIds.length === 0) return [];

  const rows: SendilloSmsHealthPropertyRow[] = [];
  const chunkSize = 250;
  for (let i = 0; i < propertyIds.length; i += chunkSize) {
    const chunk = propertyIds.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from("properties")
      .select("id, outreach_dispo, needs_human_attention")
      .in("id", chunk);
    if (error) throw new Error(`loadSendilloSmsHealth properties: ${error.message}`);
    rows.push(...((data ?? []) as SendilloSmsHealthPropertyRow[]));
  }
  return rows;
}
