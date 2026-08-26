import type { SupabaseClient } from "@supabase/supabase-js";

import {
  LEAD_EVENT_TYPES,
  recordLeadEvents,
  type LeadEventType,
} from "@/lib/events";
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

type BulkEventDraft = {
  propertyId: string;
  eventType: LeadEventType;
  payload: Record<string, string | null>;
  groupKey: string;
};

function eventDraftsForUpdatedRow(
  subOperationId: SubOperationId,
  propertyId: string,
  result: Extract<RowResult, { kind: "updated" }>,
): BulkEventDraft[] {
  if (subOperationId === "update-property-status") {
    const from = result.before.status;
    const to = result.after.status;
    return typeof from === "string" && typeof to === "string"
      ? [
          {
            propertyId,
            eventType: LEAD_EVENT_TYPES.STATUS_CHANGED,
            payload: { from, to },
            groupKey: "status",
          },
        ]
      : [];
  }
  if (subOperationId === "update-motivation-level") {
    const from = result.before.motivation_level;
    const to = result.after.motivation_level;
    const validFrom = from === null || typeof from === "string";
    const validTo = to === null || typeof to === "string";
    return validFrom && validTo
      ? [
          {
            propertyId,
            eventType: LEAD_EVENT_TYPES.MOTIVATION_CHANGED,
            payload: { from: from as string | null, to: to as string | null },
            groupKey: "motivation",
          },
        ]
      : [];
  }
  if (subOperationId !== "tag-existing-properties") return [];

  const tags = result.after.tags;
  if (!Array.isArray(tags)) return [];
  return tags.flatMap((tag) => {
    if (
      !tag ||
      typeof tag !== "object" ||
      Array.isArray(tag) ||
      typeof tag.id !== "string" ||
      typeof tag.label !== "string"
    ) {
      return [];
    }
    return [
      {
        propertyId,
        eventType: LEAD_EVENT_TYPES.TAG_APPLIED,
        payload: { tag_id: tag.id, label: tag.label },
        groupKey: `tag:${tag.id}`,
      },
    ];
  });
}

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
  const eventDrafts: BulkEventDraft[] = [];

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
    if (result.kind === "updated") {
      updatedCount++;
      eventDrafts.push(
        ...eventDraftsForUpdatedRow(
          args.subOperationId,
          match.property.id,
          result,
        ),
      );
    } else if (result.kind === "rejected") failedCount++;
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

  if (args.userId && eventDrafts.length > 0) {
    const batchId = crypto.randomUUID();
    const counts = new Map<string, number>();
    for (const draft of eventDrafts) {
      counts.set(draft.groupKey, (counts.get(draft.groupKey) ?? 0) + 1);
    }
    await recordLeadEvents(
      eventDrafts.map((draft) => ({
        propertyId: draft.propertyId,
        actorType: "user" as const,
        actorId: args.userId!,
        eventType: draft.eventType,
        payload: {
          ...draft.payload,
          batch_id: batchId,
          batch_count: counts.get(draft.groupKey) ?? 1,
        },
      })),
    );
  }

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
