import { buildSnapshot, enrichPage, FIRST_PAGE, HOLDS_LOAD_ERROR, loadEligibleHolds, recheckOpen, snapshotFlagReasons, type WaitingSnapshot } from "./hold-list";
import { loadMessagesV2Data, type LooseSupabase, type MessagesV2Data } from "./queries";
import type { HoldsMeta, OpenHold, RunWithSteps } from "./types";

export { HOLDS_LOAD_ERROR };

export type WaitingList = {
  /** Cards for the first FIRST_PAGE snapshot entries. Empty, with `error`, when the list could not be built. */
  holds: OpenHold<RunWithSteps>[];
  holdsMeta: HoldsMeta;
  /** The frozen order (and time, reason, run) the client pages through. */
  snapshot: WaitingSnapshot;
  /** Hidden because they could not be tied to exactly one property. */
  unverified: number;
  /** First-page snapshot ids dropped by the final check (locked or resolved while the page was built). */
  missing: string[];
  /** [runId, reason] from the snapshot, for the tape. */
  flagReasons: Array<[string, string | null]>;
  error: string | null;
};

const meta = (shown: number, total: number, contextErrors: string[], deadLetterUnavailable: boolean): HoldsMeta => ({
  total,
  shown,
  truncated: total > shown,
  totalState: "exact",
  failed: [],
  contextErrors,
  ...(deadLetterUnavailable ? { deadLetterUnavailable: true } : {}),
});

/** Applies the final check: holds no longer open -> missing; a displayed draft that no longer validates is removed. */
function finalCards(
  holds: OpenHold<RunWithSteps>[],
  still: { open: Set<string>; badDraft: Set<string> },
): { holds: OpenHold<RunWithSteps>[]; missing: string[] } {
  const kept = holds
    .filter((h) => still.open.has(h.id))
    .map((h) => (still.badDraft.has(h.id) ? { ...h, draft: undefined, draft_held: false } : h));
  return { holds: kept, missing: holds.filter((h) => !still.open.has(h.id)).map((h) => h.id) };
}

/** The page: the feed plus a snapshot of the complete waiting list and cards for its first entries. */
export async function loadMessagesV2Page(
  supabase: LooseSupabase,
  orgId: string,
  nowMs: number = Date.now(),
): Promise<Omit<MessagesV2Data, "holds" | "holdsMeta"> & WaitingList> {
  const [feed, list] = await Promise.all([
    loadMessagesV2Data(supabase, orgId, nowMs, { scope: { propertyIds: [], noPropertyDrafts: false } }),
    loadEligibleHolds(supabase, orgId),
  ]);
  const { holds: _h, holdsMeta: _m, ...rest } = feed;
  void _h;
  void _m;
  if (!list.ok) {
    return { ...rest, holds: [], holdsMeta: meta(0, 0, [], false), snapshot: { reasons: [], entries: [] }, unverified: 0, missing: [], flagReasons: [], error: HOLDS_LOAD_ERROR };
  }
  const snapshot = buildSnapshot(list.holds);
  const enriched = await enrichPage(supabase, orgId, list.holds.slice(0, FIRST_PAGE));
  // Final check after enrichment: a hold locked or resolved meanwhile is dropped (the column counts it as missing).
  const still = await recheckOpen(supabase, orgId, enriched.holds);
  if (!still) {
    return { ...rest, holds: [], holdsMeta: meta(0, 0, [], false), snapshot: { reasons: [], entries: [] }, unverified: 0, missing: [], flagReasons: [], error: HOLDS_LOAD_ERROR };
  }
  const keep = finalCards(enriched.holds, still);
  return {
    ...rest,
    holds: keep.holds,
    holdsMeta: meta(enriched.holds.length, snapshot.entries.length, enriched.contextErrors, enriched.deadLetterUnavailable),
    snapshot,
    unverified: list.unverified,
    missing: keep.missing,
    flagReasons: snapshotFlagReasons(snapshot),
    error: null,
  };
}

/**
 * "Show older": CURRENT card details for the requested snapshot ids. Ids no longer eligible (resolved, locked,
 * unverifiable since the snapshot) come back in `missing` and are never rendered. Null when the list cannot be
 * built (fail closed).
 */
export async function loadHoldsByIds(
  supabase: LooseSupabase,
  orgId: string,
  ids: readonly string[],
): Promise<{ holds: OpenHold<RunWithSteps>[]; missing: string[]; unverified: number; contextErrors: string[] } | null> {
  const list = await loadEligibleHolds(supabase, orgId);
  if (!list.ok) return null;
  const byId = new Map(list.holds.map((h) => [h.id, h]));
  const found = ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  const missing = ids.filter((id) => !byId.has(id));
  const enriched = await enrichPage(supabase, orgId, found);
  const still = await recheckOpen(supabase, orgId, enriched.holds);
  if (!still) return null;
  const keep = finalCards(enriched.holds, still);
  return {
    holds: keep.holds,
    missing: [...missing, ...keep.missing],
    unverified: list.unverified,
    contextErrors: enriched.contextErrors,
  };
}
