import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import {
  reconcileStoredStatusEvents,
  statusWebhookEventType,
} from "@/lib/messaging/status-events";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

export const maxDuration = 60;

const PROVIDER = "sendillo";
const MAX_ROWS_PER_SWEEP = 100;
const PROCESSING_LEASE_MS = 5 * 60_000;
const STATUS_EVENT_TYPES = [
  statusWebhookEventType("sent"),
  statusWebhookEventType("delivered"),
  statusWebhookEventType("failed"),
];

type StatusEventCandidate = Pick<
  Database["public"]["Tables"]["webhook_events"]["Row"],
  "external_id"
>;

/**
 * The provider webhook is still the fast path. This sweep is the durable
 * recovery path for an event that was stored but could not be matched to its
 * transport row yet, or whose rep-SMS obligation bridge was unavailable.
 * Every query and reconciliation call uses the service-role client because
 * these rows can belong to any tenant and webhook processing is not a user
 * session operation.
 */
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const admin = createAdminClient();
    const cutoff = new Date(Date.now() - PROCESSING_LEASE_MS).toISOString();
    const [retryable, staleProcessing] = await Promise.all([
      admin
        .from("webhook_events")
        .select("external_id")
        .eq("provider", PROVIDER)
        .in("event_type", STATUS_EVENT_TYPES)
        .in("processing_status", ["pending", "error"])
        .order("received_at", { ascending: true })
        .limit(MAX_ROWS_PER_SWEEP),
      admin
        .from("webhook_events")
        .select("external_id")
        .eq("provider", PROVIDER)
        .in("event_type", STATUS_EVENT_TYPES)
        .eq("processing_status", "processing")
        .lt("processing_started_at", cutoff)
        .order("received_at", { ascending: true })
        .limit(MAX_ROWS_PER_SWEEP),
    ]);
    if (retryable.error) {
      throw new Error(`fetch retryable Sendillo status events failed: ${retryable.error.message}`);
    }
    if (staleProcessing.error) {
      throw new Error(`fetch stale Sendillo status events failed: ${staleProcessing.error.message}`);
    }

    const externalIds = [
      ...new Set([
        ...((retryable.data ?? []) as StatusEventCandidate[]).map((row) => row.external_id),
        ...((staleProcessing.data ?? []) as StatusEventCandidate[]).map((row) => row.external_id),
      ]),
    ];
    let failed = 0;
    for (const externalId of externalIds) {
      try {
        await reconcileStoredStatusEvents(admin, PROVIDER, externalId);
      } catch (error) {
        failed += 1;
        reportError(error, {
          tags: { surface: "cron_sendillo_status_reconciliation" },
          extra: { externalId },
        });
      }
    }

    // Per-event bridge errors are deliberately persisted as `error` by the
    // reconciliation helper and remain candidates for the next sweep. A
    // top-level 500 is reserved for an unreadable sweep or process failure.
    return NextResponse.json({
      ok: failed === 0,
      candidates: externalIds.length,
      reconciled: externalIds.length - failed,
      failed,
    }, { status: failed === 0 ? 200 : 500 });
  } catch (error) {
    reportError(error, { tags: { surface: "cron_sendillo_status_reconciliation" } });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "unknown" },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
