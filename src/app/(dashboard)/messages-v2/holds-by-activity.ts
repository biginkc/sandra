import { HOLD_SORT_CAP, sortNewestFirst } from "./hold-activity";
import { withoutDncLocked } from "./dnc-locked";
import {
  compareInstants,
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
  /** Distinct holds before any ceiling (a property, or a propertyless draft, is one hold). */
  total: number;
  /** More holds than HOLD_SORT_CAP: only the newest are kept. Never silent. */
  cut: boolean;
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

const newer = (a: string | null | undefined, b: string | null | undefined) => (a && (!b || compareInstants(a, b) > 0) ? a : b);

/**
 * EVERY open hold source row, straight from the tables that own the state: flagged properties (DNC-locked
 * excluded), pending decisions, pending reviews and pending reply drafts including propertyless ones. Each
 * is paged to exhaustion. Only above HOLD_SORT_CAP distinct holds are the oldest dropped, and `cut` says so.
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
        .order("source_inbound_message_id", { ascending: true }),
    ),
    pageAll<HoldReviewRow>(() =>
      supabase
        .from("ai_disposition_reviews")
        .select(REVIEW_COLUMNS)
        .eq("org_id", orgId)
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .order("source_inbound_message_id", { ascending: true }),
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
  const base = { properties: props.rows, decisions: decs.rows, reviews: revs.rows, drafts: drafts.rows };

  // A hold is a property, or one propertyless draft. Its source-time is the newest instant among its own rows.
  const latest = new Map<string, string>();
  const bump = (key: string, at: string | null | undefined) => {
    const cur = newer(at, latest.get(key));
    if (cur) latest.set(key, cur);
  };
  for (const p of base.properties) bump(p.id, p.needs_human_attention_since ?? p.last_ai_escalation_at);
  for (const d of base.decisions) bump(d.property_id, d.created_at);
  for (const r of base.reviews) bump(r.property_id, r.created_at);
  for (const d of base.drafts) bump(d.property_id ?? `draft:${d.id}`, d.created_at);
  const total = latest.size;
  if (total <= HOLD_SORT_CAP) return { ...base, total, cut: false, failed };

  const keep = new Set(
    [...latest.entries()]
      .sort((a, b) => compareInstants(b[1], a[1]))
      .slice(0, HOLD_SORT_CAP)
      .map(([key]) => key),
  );
  return {
    properties: base.properties.filter((p) => keep.has(p.id)),
    decisions: base.decisions.filter((d) => keep.has(d.property_id)),
    reviews: base.reviews.filter((r) => keep.has(r.property_id)),
    drafts: base.drafts.filter((d) => keep.has(d.property_id ?? `draft:${d.id}`)),
    total,
    cut: true,
    failed,
  };
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
  const holds = sortNewestFirst(await withoutDncLocked(supabase, orgId, data.holds));
  return {
    ...data,
    holds,
    cutFrom: sources.cut ? sources.total : null,
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
  const sorted = sortNewestFirst(await withoutDncLocked(supabase, orgId, data.holds));
  return {
    holds: sorted.slice(offset, offset + limit),
    total: sorted.length,
    cutFrom: sources.cut ? sources.total : null,
    failed: data.holdsMeta.failed.length > 0,
  };
}
