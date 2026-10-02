import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

import type { DirectCallFullRow } from "./store";
import { createDirectRecordingHandler, type DirectRecordingSaved } from "./recording";
import type { TelnyxRecording } from "./telnyx";

const MAX_ATTEMPTS = 8;
const MAX_ROWS = 100;

type SweepDb = {
  from(table: string): any;
};

type LedgerRow = {
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
}): Promise<{ candidates: number; attempted: number; succeeded: number; failed: number }> {
  const admin = (options.admin ?? createAdminClient()) as SweepDb;
  const now = options.now ?? (() => new Date());
  const limit = Math.min(MAX_ROWS, Math.max(1, Math.floor(options.limit ?? MAX_ROWS)));
  const { data, error } = await admin
    .from("direct_call_recordings")
    .select("direct_call_id,provider_recording_id,provider_call_control_id,provider_call_leg_id,provider_call_session_id")
    .in("status", ["pending", "failed"])
    .lt("attempt_count", MAX_ATTEMPTS)
    .lte("next_attempt_at", now().toISOString())
    .order("next_attempt_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message ?? "recording_sweep_lookup_failed");

  const rows = (data ?? []) as LedgerRow[];
  let succeeded = 0;
  let failed = 0;
  for (const ledger of rows) {
    const call = await admin.from("direct_calls").select("*").eq("id", ledger.direct_call_id).maybeSingle();
    if (call.error) throw new Error(call.error.message ?? "recording_sweep_call_lookup_failed");
    if (!call.data) {
      failed++;
      continue;
    }
    const recording: DirectRecordingSaved = {
      recordingId: ledger.provider_recording_id,
      callControlId: ledger.provider_call_control_id,
      callLegId: ledger.provider_call_leg_id,
      callSessionId: ledger.provider_call_session_id,
      occurredAt: null,
    };
    try {
      await createDirectRecordingHandler({
        admin,
        getRecording: options.getRecording,
        fetchImpl: options.fetchImpl,
        now,
      })(call.data as DirectCallFullRow, recording);
      succeeded++;
    } catch {
      failed++;
    }
  }
  return { candidates: rows.length, attempted: rows.length, succeeded, failed };
}
