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

/** Rows per archive page, and the page cap per run (the rest is picked up next run). */
const ARCHIVE_BATCH = 500;
const ARCHIVE_MAX_PAGES = 20;

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

    async getOrInitAlertsSince(orgId, nowIso) {
      const settings = () => db.from("hold_alert_settings");
      const inserted = await settings()
        .upsert({ org_id: orgId, alerts_since: nowIso }, { onConflict: "org_id", ignoreDuplicates: true })
        .select("alerts_since");
      if (inserted.error) fail("watermark insert", inserted.error);
      const created = Array.isArray(inserted.data) && inserted.data.length === 1;
      if (created) return { alertsSince: (inserted.data as Array<{ alerts_since: string }>)[0]!.alerts_since, created };
      const { data, error } = await settings().select("alerts_since").eq("org_id", orgId).single();
      if (error || !data) fail("watermark select", error);
      return { alertsSince: (data as { alerts_since: string }).alerts_since, created: false };
    },

    async claim(row) {
      const { data, error } = await table()
        .update({ attempts: row.attempts + 1, status: "sending", sending_at: new Date().toISOString() })
        .eq("id", row.id)
        .in("status", ["pending", "failed"])
        .eq("attempts", row.attempts)
        .select("id");
      if (error) fail("claim", error);
      return Array.isArray(data) && data.length === 1;
    },

    async failInterrupted(cutoffIso) {
      const { data, error } = await table()
        .update({ status: "failed", attempts: MAX_ATTEMPTS, last_error: "interrupted" })
        .eq("status", "sending")
        .lt("sending_at", cutoffIso)
        .select("id");
      if (error) fail("failInterrupted", error);
      return Array.isArray(data) ? data.length : 0;
    },

    async sentAt(q) {
      const { data, error } = await table()
        .select("sent_at")
        .eq("hold_key", q.holdKey)
        .eq("recipient_user_id", q.recipientUserId)
        .eq("channel", q.channel)
        .eq("stage", q.stage)
        .eq("status", "sent")
        .maybeSingle();
      if (error) fail("sentAt", error);
      return (data as { sent_at: string | null } | null)?.sent_at ?? null;
    },

    async archiveClosed(orgId, openPropertyIds) {
      const open = new Set(openPropertyIds);
      let archived = 0;
      // Page by id cursor: still-open rows are skipped client-side, so they can
      // never fill the window and starve closed rows behind them.
      let cursor: string | null = null;
      for (let page = 0; page < ARCHIVE_MAX_PAGES; page += 1) {
        let q = table()
          .select("id, property_id, hold_key")
          .eq("org_id", orgId)
          .not("property_id", "is", null)
          .not("hold_key", "like", "%:closed:%")
          .order("id", { ascending: true })
          .limit(ARCHIVE_BATCH);
        if (cursor) q = q.gt("id", cursor);
        const { data, error } = await q;
        if (error) fail("archive select", error);
        const rows = (data ?? []) as Array<{ id: string; property_id: string | null; hold_key: string }>;
        // One set-based update per page; the function skips rows a concurrent pass already archived.
        const closedIds = rows.filter((r) => r.property_id && !open.has(r.property_id)).map((r) => r.id);
        if (closedIds.length > 0) {
          const { data: n, error: rpcError } = await db.rpc("hold_alert_archive_rows", {
            p_org_id: orgId,
            p_ids: closedIds,
          });
          if (rpcError) fail("archive update", rpcError);
          archived += typeof n === "number" ? n : 0;
        }
        if (rows.length < ARCHIVE_BATCH) break;
        cursor = rows[rows.length - 1]!.id;
      }
      return archived;
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
        // An in-flight delivery (`sending`, stamped by sending_at) counts toward the cap as well as a
        // finished one (`sent`, stamped by sent_at), so concurrent runs cannot all slip past it.
        .or(
          `and(status.eq.sent,sent_at.gte.${q.sinceIso}),and(status.eq.sending,sending_at.gte.${q.sinceIso})`,
        );
      if (q.recipientUserId) query = query.eq("recipient_user_id", q.recipientUserId);
      const { count, error } = await query;
      if (error) fail("count", error);
      return count ?? 0;
    },
  };
}
