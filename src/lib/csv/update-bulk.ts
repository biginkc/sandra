import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import { matchPropertyByAddress } from "./match-by-address";
import { normalizeAddress } from "./normalize";
import {
  getSubOperation,
  type ParsedRow,
  type RowResult,
  type SubOperationId,
} from "./update-operations";

export type MatchedRow = {
  rowIndex: number;
  address: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

export type UnmatchedRow = {
  rowIndex: number;
  address: string;
  reason: string;
  detail?: string;
};

export type UpdatePreview = {
  matched: MatchedRow[];
  unmatched: UnmatchedRow[];
  /** Deduped, lowercased tag names that the admin needs to create
   *  before re-running the upload. Empty for non-tag sub-ops. */
  unknownTags: string[];
  /** Normalized addresses that appear in more than one row of the
   *  uploaded sheet. Last-write-wins on apply, but the user gets a
   *  heads-up at preview. */
  duplicateAddresses: string[];
  totalRows: number;
};

export type ApplyBulkUpdateResult = {
  matchedCount: number;
  updatedCount: number;
  failedCount: number;
};

/**
 * Dry-run every row through match + sub-op apply (with dryRun=true).
 * Returns the matched/unmatched buckets the preview UI renders. No
 * writes happen here — the user confirms the diff before any changes
 * land in the DB.
 */
export async function previewBulkUpdate(
  supabase: SupabaseClient<Database>,
  args: { subOperationId: SubOperationId; rows: ParsedRow[] },
): Promise<UpdatePreview> {
  const op = getSubOperation(args.subOperationId);
  const matched: MatchedRow[] = [];
  const unmatched: UnmatchedRow[] = [];
  const unknownTagsSet = new Set<string>();
  const seenAddresses = new Map<string, number>();
  const duplicateSet = new Set<string>();

  for (let i = 0; i < args.rows.length; i++) {
    const row = args.rows[i];
    const address = (row.Address ?? "").trim();
    const normalized = normalizeAddress(address);
    if (normalized) {
      const seen = seenAddresses.get(normalized);
      seenAddresses.set(normalized, (seen ?? 0) + 1);
      if (seen) duplicateSet.add(normalized);
    }

    const match = await matchPropertyByAddress(supabase, { address });
    if (match.kind !== "matched") {
      unmatched.push({
        rowIndex: i,
        address,
        reason: match.reason,
      });
      continue;
    }
    const result = await op.apply(
      { supabase, userId: null },
      { rowIndex: i, parsedRow: row, property: match.property },
      { dryRun: true },
    );
    collectResult(result, matched, unmatched, unknownTagsSet);
  }

  return {
    matched,
    unmatched,
    unknownTags: Array.from(unknownTagsSet).sort(),
    duplicateAddresses: Array.from(duplicateSet),
    totalRows: args.rows.length,
  };
}

/**
 * Commit every row to the DB via the sub-op's apply (dryRun=false). One
 * row, one write — no transaction. Idempotency is the per-op responsibility
 * (e.g., setting status='contacted' when already 'contacted' is a no-op).
 *
 * Updates the parent `jobs` row as it progresses: status flips queued →
 * running → completed (or `failed` if every single row blew up). Counters
 * are populated so the /jobs UI shows real progress numbers.
 */
export async function applyBulkUpdate(
  supabase: SupabaseClient<Database>,
  args: {
    subOperationId: SubOperationId;
    rows: ParsedRow[];
    userId: string | null;
    jobId: string;
  },
): Promise<ApplyBulkUpdateResult> {
  const op = getSubOperation(args.subOperationId);

  await supabase
    .from("jobs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", args.jobId);

  let matchedCount = 0;
  let updatedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < args.rows.length; i++) {
    const row = args.rows[i];
    const address = (row.Address ?? "").trim();
    const match = await matchPropertyByAddress(supabase, { address });
    if (match.kind !== "matched") {
      failedCount++;
      continue;
    }
    matchedCount++;
    const result = await op.apply(
      { supabase, userId: args.userId },
      { rowIndex: i, parsedRow: row, property: match.property },
      { dryRun: false },
    );
    if (result.kind === "updated") updatedCount++;
    else if (result.kind === "rejected") failedCount++;
    // `unchanged` is not a failure — counted as neither updated nor failed.
  }

  const finalStatus =
    failedCount === args.rows.length && args.rows.length > 0
      ? "failed"
      : "completed";

  await supabase
    .from("jobs")
    .update({
      status: finalStatus,
      processed_items: args.rows.length,
      succeeded_items: updatedCount,
      failed_items: failedCount,
      completed_at: new Date().toISOString(),
    })
    .eq("id", args.jobId);

  return { matchedCount, updatedCount, failedCount };
}

function collectResult(
  result: RowResult,
  matched: MatchedRow[],
  unmatched: UnmatchedRow[],
  unknownTagsSet: Set<string>,
): void {
  if (result.kind === "updated") {
    matched.push({
      rowIndex: result.rowIndex,
      address: result.address,
      before: result.before,
      after: result.after,
    });
    return;
  }
  if (result.kind === "rejected") {
    unmatched.push({
      rowIndex: result.rowIndex,
      address: result.address,
      reason: result.reason,
      detail: result.detail,
    });
    if (result.unknownTags) {
      for (const t of result.unknownTags) unknownTagsSet.add(t);
    }
    return;
  }
  // `unchanged` is silently dropped from both buckets. The preview UI
  // shows totals (e.g., "8 matched, 2 unmatched, 0 will-write") — the
  // caller can derive unchanged-count from totalRows - matched - unmatched.
}
