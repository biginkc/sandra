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
const MAX_DUE_ROWS_PER_SWEEP = 75;
const MAX_FRESH_ROWS_PER_SWEEP = 25;
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
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - PROCESSING_LEASE_MS).toISOString();
    const [retryable, freshPending, staleProcessing] = await Promise.all([
      admin
        .from("webhook_events")
        .select("external_id")
        .eq("provider", PROVIDER)
        .in("event_type", STATUS_EVENT_TYPES)
        .in("processing_status", ["pending", "error"])
        .is("reconciliation_quarantined_at", null)
        .lte("reconciliation_next_attempt_at", now)
        .order("reconciliation_next_attempt_at", { ascending: true })
        .order("received_at", { ascending: true })
        .limit(MAX_DUE_ROWS_PER_SWEEP),
      // Keep a bounded fresh lane ahead of an old poison backlog. A newly
      // stored callback starts pending and is therefore eligible immediately,
      // while rows that have already failed must respect their durable
      // backoff schedule below.
      admin
        .from("webhook_events")
        .select("external_id")
        .eq("provider", PROVIDER)
        .in("event_type", STATUS_EVENT_TYPES)
        .eq("processing_status", "pending")
        .is("reconciliation_quarantined_at", null)
        .order("received_at", { ascending: false })
        .limit(MAX_FRESH_ROWS_PER_SWEEP),
      admin
        .from("webhook_events")
        .select("external_id")
        .eq("provider", PROVIDER)
        .in("event_type", STATUS_EVENT_TYPES)
        .eq("processing_status", "processing")
        .is("reconciliation_quarantined_at", null)
        .lt("processing_started_at", cutoff)
        .order("received_at", { ascending: true })
        .limit(MAX_DUE_ROWS_PER_SWEEP),
    ]);
    if (retryable.error) {
      throw new Error(`fetch retryable Sendillo status events failed: ${retryable.error.message}`);
    }
    if (freshPending.error) {
      throw new Error(`fetch fresh Sendillo status events failed: ${freshPending.error.message}`);
    }
    if (staleProcessing.error) {
      throw new Error(`fetch stale Sendillo status events failed: ${staleProcessing.error.message}`);
    }

    const externalIds = [
      ...new Set([
        ...((retryable.data ?? []) as StatusEventCandidate[]).map((row) => row.external_id),
        ...((freshPending.data ?? []) as StatusEventCandidate[]).map((row) => row.external_id),
        ...((staleProcessing.data ?? []) as StatusEventCandidate[]).map((row) => row.external_id),
      ]),
    ];
    let candidates = 0;
    let reconciled = 0;
    let failed = 0;
    let retrySchedulingFailed = false;
    for (const externalId of externalIds) {
      try {
        const result = await reconcileStoredStatusEvents(admin, PROVIDER, externalId);
        candidates += result.candidates;
        reconciled += result.processed;
        // Count the explicit failure identities as the source of truth even
        // if a legacy/mock helper reports a stale aggregate alongside them.
        failed += Math.max(result.failed, result.failures.length);
        for (const failure of result.failures) {
          const scheduled = await admin.rpc("fn_schedule_webhook_event_reconciliation_retry", {
            p_provider: PROVIDER,
            p_event_type: failure.eventType,
            p_external_id: failure.externalId,
            p_error_message: failure.message,
          });
          if (scheduled.error || !isSuccessfulRetrySchedule(scheduled.data)) {
            retrySchedulingFailed = true;
            reportError(
              new Error(
                scheduled.error?.message ??
                  "Sendillo status reconciliation retry was not durably scheduled",
              ),
              {
                tags: { surface: "cron_sendillo_status_reconciliation_retry" },
                extra: { externalId: failure.externalId, eventType: failure.eventType },
              },
            );
          }
        }
      } catch (error) {
        failed += 1;
        candidates += 1;
        reportError(error, {
          tags: { surface: "cron_sendillo_status_reconciliation" },
          extra: { externalId },
        });
      }
    }

    // Per-event bridge errors are deliberately persisted as `error` by the
    // reconciliation helper. The service RPC above advances their durable
    // backoff/quarantine state. A top-level 500 is reserved for an unreadable
    // sweep, a process failure, or a failed retry-state write.
    return NextResponse.json({
      ok: failed === 0 && !retrySchedulingFailed,
      candidates,
      groups: externalIds.length,
      reconciled,
      failed,
    }, { status: failed === 0 && !retrySchedulingFailed ? 200 : 500 });
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

function isSuccessfulRetrySchedule(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.ok === true && result.matched === true;
}
