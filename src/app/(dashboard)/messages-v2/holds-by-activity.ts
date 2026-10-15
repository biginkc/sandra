import { holdsAfter, sortNewestFirst, type HoldCursor } from "./hold-activity";
import { lockedPropertyIds, withoutDncLocked } from "./dnc-locked";
import { fetchAllPages } from "./paged";
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

/** Pages one source table to exhaustion; a failed page fails the whole source. */
async function pageAll<T>(
  make: () => { range(from: number, to: number): PromiseLike<{ data: unknown; error: unknown }> },
): Promise<{ rows: T[]; failed: boolean }> {
  const res = await fetchAllPages<T>(make);
  return { rows: res.rows, failed: res.error !== null };
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
  // Fail closed: if ANY source or the lock lookup fails, no cards are built from partial or unverified data.
  const sourceFailed = props.failed || decs.failed || revs.failed || drafts.failed;
  if (sourceFailed) return { properties: [], decisions: [], reviews: [], drafts: [], total: 0, failed: true };

  // Locked properties never count: drop their decision / review / draft rows before anything is loaded or sorted.
  const referenced = [
    ...decs.rows.map((d) => d.property_id),
    ...revs.rows.map((r) => r.property_id),
    ...drafts.rows.flatMap((d) => (d.property_id ? [d.property_id] : [])),
  ];
  const locked = referenced.length ? await lockedPropertyIds(supabase, orgId, referenced) : new Set<string>();
  if (!locked) return { properties: [], decisions: [], reviews: [], drafts: [], total: 0, failed: true };
  const open = (id: string | null | undefined) => !id || !locked.has(id);

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
  return { ...base, total: holdKeys.size, failed: false };
}

export type SortedHolds = {
  /** EVERY open hold (no ceiling), DNC-locked excluded, latest activity first. Empty (with `error`) if anything could not be verified. */
  holds: OpenHold<RunWithSteps>[];
  /** The waiting list could not be loaded or verified: show this and no cards. */
  error: string | null;
  /** Waiting texts hidden because their property could not be determined (so its DNC lock is unknown). */
  unverified: number;
};

/**
 * A propertyless hold whose draft IS linked (to a run or an inbound message) but whose link did not resolve
 * cannot have its property's DNC lock verified, so it is not shown. A draft with no link at all (or one whose
 * run is known to have no property) cannot belong to a locked property and is shown.
 */
export function splitUnverifiable(holds: readonly OpenHold<RunWithSteps>[]): { holds: OpenHold<RunWithSteps>[]; unverified: number } {
  const keep: OpenHold<RunWithSteps>[] = [];
  let unverified = 0;
  for (const h of holds) {
    const d = h.draft;
    const linked = !!h.conversation_id || (!!d && (!!d.run_id || !!d.inbound_message_id));
    const resolved = !!h.run && ((!!d?.run_id && h.run.id === d.run_id) || (!!d?.inbound_message_id && h.run.inbound_message_id === d.inbound_message_id));
    if (h.property_id === null && linked && !resolved) unverified += 1;
    else keep.push(h);
  }
  return { holds: keep, unverified };
}

export const HOLDS_LOAD_ERROR = "Waiting list could not be loaded. Reload to retry.";

/** False when a source, run or step lookup failed: the activity order would be built on incomplete data. */
export function orderingDataComplete(meta: { failed: readonly unknown[]; contextErrors: readonly string[] }): boolean {
  return meta.failed.length === 0 && !meta.contextErrors.some((e) => e.startsWith("run lookup") || e === "step lookup");
}

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
  // Ordering needs every hold's latest run and steps. If any of that is missing, a sort would be wrong: fail closed.
  const verified = sources.failed || !orderingDataComplete(data.holdsMeta) ? null : await withoutDncLocked(supabase, orgId, data.holds);
  if (!verified) return { ...data, holds: [], error: HOLDS_LOAD_ERROR, unverified: 0 };
  const { holds, unverified } = splitUnverifiable(verified);
  return { ...data, holds: sortNewestFirst(holds), error: null, unverified };
}

/**
 * The next keyset page of the same ordering: holds strictly after `cursor` (the last card the client has),
 * `limit` of them, plus how many remain after those. Null when anything could not be verified (fail closed).
 */
export async function loadHoldsSlice(
  supabase: LooseSupabase,
  orgId: string,
  cursor: HoldCursor | null,
  limit: number,
  nowMs: number = Date.now(),
): Promise<{ holds: OpenHold<RunWithSteps>[]; remaining: number } | null> {
  const sources = await collectOpenHoldSources(supabase, orgId);
  if (sources.failed) return null;
  const data = await loadMessagesV2Data(supabase, orgId, nowMs, {
    includeDraftBody: true,
    holdsOnly: true,
    scope: NO_SCOPE,
    preloaded: sources,
  });
  if (!orderingDataComplete(data.holdsMeta)) return null;
  const verified = await withoutDncLocked(supabase, orgId, data.holds);
  if (!verified) return null;
  const after = holdsAfter(sortNewestFirst(splitUnverifiable(verified).holds), cursor);
  return { holds: after.slice(0, limit), remaining: Math.max(0, after.length - limit) };
}
