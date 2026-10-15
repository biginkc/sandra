import { withoutDncLocked } from "./dnc-locked";
import { loadHoldBuckets, loadMessagesV2Data, type LooseSupabase, type MessagesV2Data } from "./queries";
import type { OpenHold, RunWithSteps } from "./types";

import { HOLD_SORT_CAP, sortNewestFirst } from "./hold-activity";
const BUCKET_PAGE = 500;


/**
 * Every open hold property id, New then Backlog, up to HOLD_SORT_CAP. The
 * server pages these buckets by start time; the page needs ONE ordering (latest
 * activity) across all of them, so it collects the ids and sorts after loading.
 * Returns null when the classification query fails (callers say so, never "none").
 */
export async function collectHoldPropertyIds(
  supabase: LooseSupabase,
  orgId: string,
): Promise<{ ids: string[]; capped: boolean } | null> {
  const ids = new Set<string>();
  let capped = false;
  for (const bucket of ["new", "backlog"] as const) {
    let offset = 0;
    for (;;) {
      const page = await loadHoldBuckets(supabase, orgId, bucket, BUCKET_PAGE, offset);
      if (!page) return null;
      const total = bucket === "new" ? page.newTotal : page.backlogTotal;
      for (const id of page.propertyIds) ids.add(id);
      offset += page.propertyIds.length;
      if (page.propertyIds.length === 0 || offset >= total) break;
      if (ids.size >= HOLD_SORT_CAP) {
        capped = true;
        break;
      }
    }
    if (capped) break;
  }
  return { ids: [...ids], capped };
}

export type SortedHolds = {
  /** All open holds, DNC-locked excluded, newest activity first. */
  holds: OpenHold<RunWithSteps>[];
  capped: boolean;
  /** The id lookup failed: show "unavailable", not an empty column. */
  error: string | null;
};

/** The page's feed (runs, badges) plus every open hold in one latest-activity order. */
export async function loadMessagesV2Page(
  supabase: LooseSupabase,
  orgId: string,
  nowMs: number = Date.now(),
): Promise<MessagesV2Data & SortedHolds> {
  const collected = await collectHoldPropertyIds(supabase, orgId);
  const data = await loadMessagesV2Data(supabase, orgId, nowMs, {
    includeDraftBody: true,
    scope: { propertyIds: collected?.ids ?? [], noPropertyDrafts: true },
  });
  const holds = sortNewestFirst(await withoutDncLocked(supabase, orgId, data.holds));
  return {
    ...data,
    holds,
    capped: collected?.capped ?? false,
    error: collected ? null : "hold classification query failed",
  };
}

/** One slice of the same ordering, for "Show older". Holds only: no feed, badges or totals. */
export async function loadHoldsSlice(
  supabase: LooseSupabase,
  orgId: string,
  offset: number,
  limit: number,
  nowMs: number = Date.now(),
): Promise<{ holds: OpenHold<RunWithSteps>[]; total: number; failed: boolean } | null> {
  const collected = await collectHoldPropertyIds(supabase, orgId);
  if (!collected) return null;
  const data = await loadMessagesV2Data(supabase, orgId, nowMs, {
    includeDraftBody: true,
    holdsOnly: true,
    scope: { propertyIds: collected.ids, noPropertyDrafts: true },
  });
  const sorted = sortNewestFirst(await withoutDncLocked(supabase, orgId, data.holds));
  return {
    holds: sorted.slice(offset, offset + limit),
    total: sorted.length,
    failed: data.holdsMeta.failed.length > 0,
  };
}
