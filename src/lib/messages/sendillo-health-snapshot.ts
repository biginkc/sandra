import type { SupabaseClient } from "@supabase/supabase-js";

import { isWithinCreditRefreshWindow } from "@/lib/skip-trace/balance";
import type { Database, Json } from "@/lib/supabase/types";

import {
  EMPTY_SENDILLO_SMS_HEALTH,
  type SendilloSmsHealth,
  type SendilloSmsHealthResult,
} from "./sendillo-health";

export const SENDILLO_HEALTH_SNAPSHOT_KEY = "sendillo_sms_health";
const SENDILLO_HEALTH_STALE_MS = 30 * 60 * 1000;

type SnapshotRow = Pick<
  Database["public"]["Tables"]["dashboard_snapshots"]["Row"],
  "payload" | "captured_at"
>;

export async function getStoredSendilloSmsHealth(
  supabase: SupabaseClient<Database>,
  now = new Date(),
): Promise<SendilloSmsHealthResult> {
  const { data, error } = await supabase
    .from("dashboard_snapshots")
    .select("payload, captured_at")
    .eq("snapshot_key", SENDILLO_HEALTH_SNAPSHOT_KEY)
    .maybeSingle();

  if (error || !data) return unavailable();
  const row = data as SnapshotRow;
  const health = parseSendilloSmsHealth(row.payload);
  if (!health) return unavailable();

  return {
    status: "available",
    health,
    updatedAt: row.captured_at,
    stale:
      isWithinCreditRefreshWindow(now) &&
      now.getTime() - new Date(row.captured_at).getTime() >
        SENDILLO_HEALTH_STALE_MS,
  };
}

export async function captureSendilloSmsHealthSnapshot(
  supabase: SupabaseClient<Database>,
  capturedAt = new Date(),
): Promise<Extract<SendilloSmsHealthResult, { status: "available" }>> {
  const { data, error } = await supabase.rpc(
    "capture_sendillo_sms_health_snapshot",
    { p_captured_at: capturedAt.toISOString() },
  );
  if (error) {
    throw new Error(`Could not capture Sendillo SMS health: ${error.message}`);
  }

  const row = data?.[0];
  if (!row) throw new Error("Sendillo SMS health snapshot returned no row");
  const health = parseSendilloSmsHealth(row.payload);
  if (!health) throw new Error("Sendillo SMS health snapshot was malformed");

  return {
    status: "available",
    health,
    updatedAt: row.captured_at,
    stale: false,
  };
}

function unavailable(): SendilloSmsHealthResult {
  return {
    status: "unavailable",
    health: EMPTY_SENDILLO_SMS_HEALTH,
    message: "Sendillo SMS health unavailable",
  };
}

function parseSendilloSmsHealth(payload: Json): SendilloSmsHealth | null {
  if (!payload || Array.isArray(payload) || typeof payload !== "object")
    return null;
  const value = payload as Record<string, Json | undefined>;
  const numberKeys = [
    "smsRows",
    "outboundMessages",
    "inboundMessages",
    "conversations",
    "latestInboundMissingDisposition",
    "unreadMissingDisposition",
    "humanAttentionMissingDisposition",
    "anyInboundMissingDisposition",
  ] as const;

  for (const key of numberKeys) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0)
      return null;
  }
  if (
    !isNullableIso(value.firstMessageAt) ||
    !isNullableIso(value.latestMessageAt)
  ) {
    return null;
  }

  return {
    smsRows: Number(value.smsRows),
    outboundMessages: Number(value.outboundMessages),
    inboundMessages: Number(value.inboundMessages),
    conversations: Number(value.conversations),
    latestInboundMissingDisposition: Number(
      value.latestInboundMissingDisposition,
    ),
    unreadMissingDisposition: Number(value.unreadMissingDisposition),
    humanAttentionMissingDisposition: Number(
      value.humanAttentionMissingDisposition,
    ),
    anyInboundMissingDisposition: Number(value.anyInboundMissingDisposition),
    firstMessageAt: value.firstMessageAt as string | null,
    latestMessageAt: value.latestMessageAt as string | null,
  };
}

function isNullableIso(value: Json | undefined): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && Number.isFinite(new Date(value).getTime()))
  );
}
