import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

import type { DirectCallFullRow } from "./store";
import { createDirectRecordingHandler, syncDirectRecordingActivity, type DirectRecordingSaved } from "./recording";
import type { TelnyxRecording } from "./telnyx";

const MAX_ATTEMPTS = 8;
const MAX_ROWS = 100;
const DEFAULT_BUDGET_MS = 45_000;

type QueryResult = { data: unknown; error: { message?: string } | null };
type SweepQuery = {
  select(columns: string): SweepQuery;
  in(column: string, values: string[]): SweepQuery;
  eq(column: string, value: string): SweepQuery;
  lt(column: string, value: number | string): SweepQuery;
  lte(column: string, value: number | string): SweepQuery;
  order(column: string, options: { ascending: boolean }): SweepQuery;
  limit(value: number): Promise<QueryResult>;
  maybeSingle(): Promise<QueryResult>;
};
type SweepDb = {
  from(table: string): SweepQuery;
};

type LedgerRow = {
  status: "pending" | "failed" | "available";
  direct_call_id: string;
  provider_recording_id: string;
  provider_call_control_id: string;
  provider_call_leg_id: string | null;
  provider_call_session_id: string | null;
};

/**
 * Retries captures that outlived a webhook request. Claim leases and status
 * transitions live in SQL, so overlapping cron invocations remain idempotent.
 */
export async function sweepDirectRecordingCaptures(options: {
  admin?: unknown;
  getRecording: (recordingId: string) => Promise<TelnyxRecording>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  limit?: number;
  budgetMs?: number;
}): Promise<{ candidates: number; attempted: number; succeeded: number; failed: number }> {
  const admin = (options.admin ?? createAdminClient()) as SweepDb;
  const now = options.now ?? (() => new Date());
  const limit = Math.min(MAX_ROWS, Math.max(1, Math.floor(options.limit ?? MAX_ROWS)));
  const budgetMs = Math.min(55_000, Math.max(1_000, Math.floor(options.budgetMs ?? DEFAULT_BUDGET_MS)));
  const nowIso = now().toISOString();
  const captureResult = await admin
    .from("direct_call_recordings")
    .select("status,direct_call_id,provider_recording_id,provider_call_control_id,provider_call_leg_id,provider_call_session_id")
    .in("status", ["pending", "failed"])
    .lt("attempt_count", MAX_ATTEMPTS)
    .lte("next_attempt_at", nowIso)
    .order("next_attempt_at", { ascending: true })
    .limit(limit);
  if (captureResult.error) throw new Error(captureResult.error.message ?? "recording_sweep_lookup_failed");

  const linkResult = await admin
    .from("direct_call_recordings")
    .select("status,direct_call_id,provider_recording_id,provider_call_control_id,provider_call_leg_id,provider_call_session_id")
    .eq("status", "available")
    .lt("link_attempt_count", MAX_ATTEMPTS)
    .lte("link_next_attempt_at", nowIso)
    .order("link_next_attempt_at", { ascending: true })
    .limit(limit);
  if (linkResult.error) throw new Error(linkResult.error.message ?? "recording_link_sweep_lookup_failed");

  const captureRows = Array.isArray(captureResult.data) ? captureResult.data as LedgerRow[] : [];
  const linkRows = Array.isArray(linkResult.data) ? linkResult.data as LedgerRow[] : [];
  const rows = [...captureRows, ...linkRows];
  const startedAt = Date.now();
  let succeeded = 0;
  let failed = 0;
  let attempted = 0;
  for (const ledger of rows) {
    if (Date.now() - startedAt >= budgetMs) break;
    attempted++;
    try {
      if (ledger.status === "available") {
        await syncDirectRecordingActivity(admin, ledger.direct_call_id, ledger.provider_recording_id, now);
      } else {
        const call = await admin.from("direct_calls").select("*").eq("id", ledger.direct_call_id).maybeSingle();
        if (call.error) throw new Error(call.error.message ?? "recording_sweep_call_lookup_failed");
        if (!call.data) throw new Error("recording_sweep_call_missing");
        const recording: DirectRecordingSaved = {
          recordingId: ledger.provider_recording_id,
          callControlId: ledger.provider_call_control_id,
          callLegId: ledger.provider_call_leg_id,
          callSessionId: ledger.provider_call_session_id,
          occurredAt: null,
        };
        await createDirectRecordingHandler({
          admin,
          getRecording: options.getRecording,
          fetchImpl: options.fetchImpl,
          now,
        })(call.data as DirectCallFullRow, recording);
      }
      succeeded++;
    } catch {
      failed++;
    }
  }
  return { candidates: rows.length, attempted, succeeded, failed };
}
