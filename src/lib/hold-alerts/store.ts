import type { LooseSupabase } from "@/app/(dashboard)/messages-v2/queries";

import {
  MAX_ATTEMPTS,
  type AlertChannel,
  type AlertStage,
  type DeliveryRow,
  type DeliveryStatus,
  type DeliveryStore,
  type EnsureInput,
} from "./types";

type DbRow = {
  id: string;
  org_id: string;
  property_id: string | null;
  hold_key: string;
  recipient_user_id: string;
  channel: AlertChannel;
  stage: AlertStage;
  status: DeliveryStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
};

const COLUMNS =
  "id, org_id, property_id, hold_key, recipient_user_id, channel, stage, status, attempts, last_error, created_at";

function fail(op: string, error: { message?: string } | null): never {
  throw new Error(`hold_alert_deliveries ${op} failed: ${error?.message ?? "unknown"}`);
}

/** Service-role store over hold_alert_deliveries (the table is not in the generated types yet). */
export function createSupabaseDeliveryStore(db: LooseSupabase): DeliveryStore {
  const table = () => db.from("hold_alert_deliveries");
  return {
    async ensure(input: EnsureInput): Promise<DeliveryRow> {
      const insert = await table().upsert(
        {
          org_id: input.orgId,
          property_id: input.propertyId,
          hold_key: input.holdKey,
          recipient_user_id: input.recipientUserId,
          channel: input.channel,
          stage: input.stage,
        },
        { onConflict: "hold_key,recipient_user_id,channel,stage", ignoreDuplicates: true },
      );
      if (insert.error) fail("insert", insert.error);
      const { data, error } = await table()
        .select(COLUMNS)
        .eq("hold_key", input.holdKey)
        .eq("recipient_user_id", input.recipientUserId)
        .eq("channel", input.channel)
        .eq("stage", input.stage)
        .single();
      if (error || !data) fail("select", error);
      const r = data as DbRow;
      return {
        id: r.id,
        orgId: r.org_id,
        propertyId: r.property_id,
        holdKey: r.hold_key,
        recipientUserId: r.recipient_user_id,
        channel: r.channel,
        stage: r.stage,
        status: r.status,
        attempts: r.attempts,
        lastError: r.last_error,
        createdAt: r.created_at,
      };
    },

    async claim(row) {
      const { data, error } = await table()
        .update({ attempts: row.attempts + 1 })
        .eq("id", row.id)
        .in("status", ["pending", "failed"])
        .eq("attempts", row.attempts)
        .select("id");
      if (error) fail("claim", error);
      return Array.isArray(data) && data.length === 1;
    },

    async markSent(id) {
      const { error } = await table()
        .update({ status: "sent", sent_at: new Date().toISOString(), last_error: null })
        .eq("id", id);
      if (error) fail("markSent", error);
    },

    async markSkipped(id, reason) {
      const { error } = await table().update({ status: "skipped", last_error: reason }).eq("id", id);
      if (error) fail("markSkipped", error);
    },

    async markFailed(id, message, terminal) {
      const patch: Record<string, unknown> = { status: "failed", last_error: message.slice(0, 500) };
      if (terminal) patch.attempts = MAX_ATTEMPTS;
      const { error } = await table().update(patch).eq("id", id);
      if (error) fail("markFailed", error);
    },

    async countSentSince(q) {
      let query = table()
        .select("id", { count: "exact", head: true })
        .eq("org_id", q.orgId)
        .eq("channel", q.channel)
        .eq("status", "sent")
        .gte("sent_at", q.sinceIso);
      if (q.recipientUserId) query = query.eq("recipient_user_id", q.recipientUserId);
      const { count, error } = await query;
      if (error) fail("count", error);
      return count ?? 0;
    },
  };
}
