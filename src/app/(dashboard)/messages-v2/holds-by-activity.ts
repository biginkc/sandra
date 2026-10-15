import { HOLD_SORT_CAP, sortNewestFirst } from "./hold-activity";
import { lockedPropertyIds, withoutDncLocked } from "./dnc-locked";
import {
  DECISION_COLUMNS,
  draftColumns,
  loadMessagesV2Data,
  PROPERTY_COLUMNS,
  REVIEW_COLUMNS,
  type HoldDecisionRow,
  type HoldDraftRow,
  type HoldPropertyRow,
  type HoldReviewRow,
  type LooseSupabase,
  type MessagesV2Data,
} from "./queries";
import type { OpenHold, RunWithSteps } from "./types";

/** Rows per request while paging a source to exhaustion. */
const SOURCE_PAGE = 1000;

export type OpenHoldSources = {
  properties: HoldPropertyRow[];
  decisions: HoldDecisionRow[];
  reviews: HoldReviewRow[];
  drafts: HoldDraftRow[];
  /** Distinct holds (a property, or a propertyless draft, is one hold), DNC-locked excluded. */
  total: number;
  /** A source query failed: show "unavailable", never an empty column. */
  failed: boolean;
};

/** Pages one source table until it returns a short page. No row cap: a failure is reported, a long table is not truncated. */
async function pageAll<T>(
  make: () => { range(from: number, to: number): PromiseLike<{ data: unknown; error: unknown }> },
): Promise<{ rows: T[]; failed: boolean }> {
  const rows: T[] = [];
  for (let from = 0; ; from += SOURCE_PAGE) {
    const res = await make().range(from, from + SOURCE_PAGE - 1);
    if (res.error) return { rows: [], failed: true };
    const page = (res.data ?? []) as T[];
    rows.push(...page);
    if (page.length < SOURCE_PAGE) return { rows, failed: false };
  }
}

/**
 * EVERY open hold source row, straight from the tables that own the state: flagged properties (DNC-locked
 * excluded), pending decisions, pending reviews and pending reply drafts including propertyless ones. Each
 * is paged to exhaustion and locked properties are removed. Nothing is cut here: the ceiling comes after sorting.
 */
export async function collectOpenHoldSources(supabase: LooseSupabase, orgId: string, includeDraftBody = true): Promise<OpenHoldSources> {
  const [props, decs, revs, drafts] = await Promise.all([
    pageAll<HoldPropertyRow>(() =>
      supabase
        .from("properties")
        .select(PROPERTY_COLUMNS)
        .eq("org_id", orgId)
        .eq("needs_human_attention", true)
        .eq("is_dnc_locked", false)
        .order("id", { ascending: true }),
    ),
    pageAll<HoldDecisionRow>(() =>
      supabase
        .from("jev_lead_decisions")
        .select(DECISION_COLUMNS)
        .eq("org_id", orgId)
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .order("source_inbound_message_id", { ascending: true })
        .order("property_id", { ascending: true }),
    ),
    pageAll<HoldReviewRow>(() =>
      supabase
        .from("ai_disposition_reviews")
        .select(REVIEW_COLUMNS)
        .eq("org_id", orgId)
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .order("source_inbound_message_id", { ascending: true })
        .order("property_id", { ascending: true }),
    ),
    pageAll<HoldDraftRow>(() =>
      supabase
        .from("ai_reply_drafts")
        .select(draftColumns(includeDraftBody))
        .eq("org_id", orgId)
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .order("id", { ascending: true }),
    ),
  ]);
  const failed = props.failed || decs.failed || revs.failed || drafts.failed;

  // Locked properties never count: drop their decision / review / draft rows before anything is loaded or sorted.
  const referenced = [
    ...decs.rows.map((d) => d.property_id),
    ...revs.rows.map((r) => r.property_id),
    ...drafts.rows.flatMap((d) => (d.property_id ? [d.property_id] : [])),
  ];
  const locked = referenced.length ? await lockedPropertyIds(supabase, orgId, referenced) : new Set<string>();
  const open = (id: string | null | undefined) => !id || !locked || !locked.has(id);

  const base = {
    properties: props.rows,
    decisions: decs.rows.filter((d) => open(d.property_id)),
    reviews: revs.rows.filter((r) => open(r.property_id)),
    drafts: drafts.rows.filter((d) => open(d.property_id)),
  };
  // No ceiling here: activity (runs, steps) is only known after load, so the ceiling is applied after sorting.
  const holdKeys = new Set<string>([
    ...base.properties.map((p) => p.id),
    ...base.decisions.map((d) => d.property_id),
    ...base.reviews.map((r) => r.property_id),
    ...base.drafts.map((d) => d.property_id ?? `draft:${d.id}`),
  ]);
  return { ...base, total: holdKeys.size, failed };
}

/** Newest HOLD_SORT_CAP of an already-sorted list, plus the full count when it had to cut (never silent). */
export function applyHoldCeiling<T>(sorted: readonly T[]): { holds: T[]; cutFrom: number | null } {
  return sorted.length > HOLD_SORT_CAP
    ? { holds: sorted.slice(0, HOLD_SORT_CAP), cutFrom: sorted.length }
    : { holds: [...sorted], cutFrom: null };
}

export type SortedHolds = {
  /** All open holds, DNC-locked excluded, latest activity first. */
  holds: OpenHold<RunWithSteps>[];
  /** All open holds when more than HOLD_SORT_CAP exist (only the newest are kept); null otherwise. Never silent. */
  cutFrom: number | null;
  /** The source lookup failed: show "unavailable", not an empty column. */
  error: string | null;
};

const NO_SCOPE = { propertyIds: [] as string[], noPropertyDrafts: false };

/** The page's feed (runs, badges) plus every open hold in ONE latest-activity order. */
export async function loadMessagesV2Page(
  supabase: LooseSupabase,
  orgId: string,
  nowMs: number = Date.now(),
): Promise<MessagesV2Data & SortedHolds> {
  const sources = await collectOpenHoldSources(supabase, orgId);
  const data = await loadMessagesV2Data(supabase, orgId, nowMs, {
    includeDraftBody: true,
    scope: NO_SCOPE,
    preloaded: sources,
  });
  const { holds, cutFrom } = applyHoldCeiling(sortNewestFirst(await withoutDncLocked(supabase, orgId, data.holds)));
  return {
    ...data,
    holds,
    cutFrom,
    error: sources.failed ? "a hold source query failed" : null,
  };
}

/** One slice of the same ordering, for "Show older". Holds only: no feed, badges or totals. */
export async function loadHoldsSlice(
  supabase: LooseSupabase,
  orgId: string,
  offset: number,
  limit: number,
  nowMs: number = Date.now(),
): Promise<{ holds: OpenHold<RunWithSteps>[]; total: number; cutFrom: number | null; failed: boolean } | null> {
  const sources = await collectOpenHoldSources(supabase, orgId);
  if (sources.failed) return null;
  const data = await loadMessagesV2Data(supabase, orgId, nowMs, {
    includeDraftBody: true,
    holdsOnly: true,
    scope: NO_SCOPE,
    preloaded: sources,
  });
  const { holds: sorted, cutFrom } = applyHoldCeiling(sortNewestFirst(await withoutDncLocked(supabase, orgId, data.holds)));
  return {
    holds: sorted.slice(offset, offset + limit),
    total: sorted.length,
    cutFrom,
    failed: data.holdsMeta.failed.length > 0,
  };
}
