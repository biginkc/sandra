import type { HoldCursor } from "./hold-activity";
import { effectiveFlagReasons, enrichPage, FIRST_PAGE, HOLDS_LOAD_ERROR, loadEligibleHolds, pageHolds } from "./hold-list";
import { loadMessagesV2Data, type LooseSupabase, type MessagesV2Data } from "./queries";
import type { HoldsMeta, OpenHold, RunWithSteps } from "./types";

export { HOLDS_LOAD_ERROR };

export type WaitingList = {
  /** The first page of the waiting list (server order). Empty, with `error`, when it could not be built. */
  holds: OpenHold<RunWithSteps>[];
  holdsMeta: HoldsMeta;
  total: number;
  remaining: number;
  nextCursor: HoldCursor | null;
  /** Hidden because they could not be tied to exactly one property. */
  unverified: number;
  /** [runId, flag reason] for the run each eligible hold shows, over the COMPLETE list (tape and card share it). */
  flagReasons: Array<[string, string]>;
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

const FAILED: Omit<WaitingList, "holdsMeta"> = {
  holds: [],
  total: 0,
  remaining: 0,
  nextCursor: null,
  unverified: 0,
  flagReasons: [],
  error: HOLDS_LOAD_ERROR,
};

/** The page: the feed (runs, badges) plus the first page of the waiting list, built by hold-list.ts. */
export async function loadMessagesV2Page(
  supabase: LooseSupabase,
  orgId: string,
  nowMs: number = Date.now(),
): Promise<Omit<MessagesV2Data, "holds" | "holdsMeta"> & WaitingList> {
  const [feed, list] = await Promise.all([
    // Feed only: an empty hold scope means no hold queries run here.
    loadMessagesV2Data(supabase, orgId, nowMs, { scope: { propertyIds: [], noPropertyDrafts: false } }),
    loadEligibleHolds(supabase, orgId),
  ]);
  const { holds: _ignored, holdsMeta: _ignoredMeta, ...rest } = feed;
  void _ignored;
  void _ignoredMeta;
  if (!list.ok) return { ...rest, ...FAILED, holdsMeta: meta(0, 0, [], false) };
  const page = pageHolds(list.holds, null, FIRST_PAGE);
  const enriched = await enrichPage(supabase, orgId, page.holds);
  return {
    ...rest,
    holds: enriched.holds,
    holdsMeta: meta(enriched.holds.length, page.total, enriched.contextErrors, enriched.deadLetterUnavailable),
    total: page.total,
    remaining: page.remaining,
    nextCursor: page.nextCursor,
    unverified: list.unverified,
    flagReasons: effectiveFlagReasons(list.holds),
    error: null,
  };
}

/** "Show older": the same list, the keyset page after the server-issued cursor. Null when it could not be built. */
export async function loadHoldsSlice(
  supabase: LooseSupabase,
  orgId: string,
  cursor: HoldCursor | null,
  limit: number,
): Promise<{ holds: OpenHold<RunWithSteps>[]; total: number; remaining: number; nextCursor: HoldCursor | null; unverified: number; contextErrors: string[] } | null> {
  const list = await loadEligibleHolds(supabase, orgId);
  if (!list.ok) return null;
  const page = pageHolds(list.holds, cursor, limit);
  const enriched = await enrichPage(supabase, orgId, page.holds);
  return {
    holds: enriched.holds,
    total: page.total,
    remaining: page.remaining,
    nextCursor: page.nextCursor,
    unverified: list.unverified,
    contextErrors: enriched.contextErrors,
  };
}
