import { buildSnapshot, enrichPage, FIRST_PAGE, HOLDS_LOAD_ERROR, loadEligibleHolds, snapshotFlagReasons, type WaitingSnapshot } from "./hold-list";
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
    return { ...rest, holds: [], holdsMeta: meta(0, 0, [], false), snapshot: { reasons: [], entries: [] }, unverified: 0, flagReasons: [], error: HOLDS_LOAD_ERROR };
  }
  const snapshot = buildSnapshot(list.holds);
  const enriched = await enrichPage(supabase, orgId, list.holds.slice(0, FIRST_PAGE));
  return {
    ...rest,
    holds: enriched.holds,
    holdsMeta: meta(enriched.holds.length, snapshot.entries.length, enriched.contextErrors, enriched.deadLetterUnavailable),
    snapshot,
    unverified: list.unverified,
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
  return { holds: enriched.holds, missing, unverified: list.unverified, contextErrors: enriched.contextErrors };
}
