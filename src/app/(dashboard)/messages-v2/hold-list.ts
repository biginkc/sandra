/**
 * The "Waiting for a person" list, built one way for the first page AND every "Show older" slice:
 *
 *   1. every open hold source, paged by keyset to exhaustion (flagged properties, pending decisions, reviews, drafts)
 *   2. every draft resolved to exactly one property (its own, its run's, its inbound message's, or its
 *      conversation's messages'); none or several = unverifiable (hidden and counted)
 *   3. every candidate property's DNC lock checked; a locked candidate removes the row (not counted)
 *   4. each hold's latest activity from its runs (latest per property, its source messages' runs, its drafts' runs,
 *      property-less runs in its conversations) and those runs' steps, all paged to exhaustion
 *   5. one sort (newest activity first, microsecond precision, id tiebreak), frozen into a client-held snapshot
 *      (buildSnapshot); "Show older" asks for snapshot ids and gets their CURRENT details (loadHoldsByIds)
 *
 * Any failed or possibly-truncated lookup in 1-4 fails the whole list closed: an error and zero cards, because
 * a partial list could show a locked property or a wrong order. Card annotations (step 6, page only) are amber notes.
 */
import { verifyProperties } from "./dnc-locked";
import { holdActivityAt, sortNewestFirst } from "./hold-activity";
import { loadFreshSeen, mergeSeen } from "./hold-seen";
import { SEEN_CHECK_FAILED } from "./snapshot-codec";
import { fetchAllKeyset } from "./paged";
import {
  compareInstants,
  DECISION_COLUMNS,
  deriveOpenHolds,
  draftColumns,
  enrichHoldCards,
  PROPERTY_COLUMNS,
  REVIEW_COLUMNS,
  type HoldDecisionRow,
  type HoldDraftRow,
  type HoldPropertyRow,
  type HoldReviewRow,
  type LooseSupabase,
} from "./queries";
import type { HoldSeen, OpenHold, PipelineRun, PipelineRunStep, RunWithSteps } from "./types";

const CHUNK = 100;

const LATEST_RUN_CHUNK = 200;

export const HOLDS_LOAD_ERROR = "Waiting list could not be loaded. Reload to retry.";
/** Holds on the first paint; the rest come through "Show older". */
export const FIRST_PAGE = 40;

const chunks = <T,>(items: readonly T[], size = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};
const uniq = <T,>(items: Iterable<T>): T[] => [...new Set(items)];

/**
 * Optional narrowing of a build to some held properties (the final check, Show older, live re-check, the tape).
 * Every pending draft is still resolved and verified (a draft's property is only known after resolution); only
 * drafts resolving to a scoped property are built into holds. `unverified` is null (not a whole-org count).
 */
export type HoldScope = { propertyIds: readonly string[] };

/** Columns a list build reads from pipeline_run_steps: enough for activity, never `detail`. */
export const ACTIVITY_STEP_COLUMNS = "id, run_id, seq, created_at";

export type HoldSources = {
  properties: HoldPropertyRow[];
  decisions: Array<HoldDecisionRow & { id: string }>;
  reviews: Array<HoldReviewRow & { id: string }>;
  drafts: HoldDraftRow[];
};

/** Step 1. Null when any source fails. */
export async function loadHoldSources(supabase: LooseSupabase, orgId: string, scope?: HoldScope): Promise<HoldSources | null> {
  // Unscoped: one keyset read. Scoped: one keyset read per chunk of property ids, merged; any failure fails all.
  const read = async <T,>(make: (ids: string[] | null) => unknown): Promise<{ rows: T[]; error: unknown }> => {
    if (!scope) return fetchAllKeyset<T>(() => make(null));
    const parts = await Promise.all(chunks(uniq(scope.propertyIds)).map((ids) => fetchAllKeyset<T>(() => make(ids))));
    const bad = parts.find((r) => r.error);
    return bad ? { rows: [], error: bad.error } : { rows: parts.flatMap((r) => r.rows), error: null };
  };
  type Q = { in(col: string, v: string[]): unknown };
  const narrow = (q: unknown, col: string, ids: string[] | null) => (ids ? (q as Q).in(col, ids) : q);
  const [properties, decisions, reviews, drafts] = await Promise.all([
    read<HoldPropertyRow>((ids) =>
      narrow(
        supabase
          .from("properties")
          .select(PROPERTY_COLUMNS)
          .eq("org_id", orgId)
          .eq("needs_human_attention", true)
          .eq("is_dnc_locked", false),
        "id",
        ids,
      ),
    ),
    read<HoldDecisionRow & { id: string }>((ids) =>
      narrow(supabase.from("jev_lead_decisions").select(`id, ${DECISION_COLUMNS}`).eq("org_id", orgId).eq("status", "pending"), "property_id", ids),
    ),
    read<HoldReviewRow & { id: string }>((ids) =>
      narrow(supabase.from("ai_disposition_reviews").select(`id, ${REVIEW_COLUMNS}`).eq("org_id", orgId).eq("status", "pending"), "property_id", ids),
    ),
    scope
      ? scopedDrafts(supabase, orgId, uniq(scope.propertyIds))
      : fetchAllKeyset<HoldDraftRow>(() =>
          supabase.from("ai_reply_drafts").select(draftColumns(false)).eq("org_id", orgId).eq("status", "pending"),
        ),
  ]);
  if (properties.error || decisions.error || reviews.error || drafts.error) return null;
  return { properties: properties.rows, decisions: decisions.rows, reviews: reviews.rows, drafts: drafts.rows };
}

/**
 * The pending drafts that COULD resolve to one of these properties: a draft resolves to P only through its own
 * property_id, a run on P, an inbound message on P, or a conversation holding a message on P, so those four lookups
 * find every one of them (each is then resolved in full, so a second link elsewhere still makes it ambiguous).
 * Reads are bounded by the requested properties, not the org's backlog. Any failure fails the read.
 */
async function scopedDrafts(supabase: LooseSupabase, orgId: string, propertyIds: string[]): Promise<{ rows: HoldDraftRow[]; error: unknown }> {
  const fail = (error: unknown) => ({ rows: [] as HoldDraftRow[], error });
  const linkRuns: string[] = [];
  const linkMsgs: string[] = [];
  const linkConvs = new Set<string>();
  for (const ids of chunks(propertyIds)) {
    const [runs, msgs] = await Promise.all([
      fetchAllKeyset<{ id: string }>(() => supabase.from("pipeline_runs").select("id").eq("org_id", orgId).in("property_id", ids)),
      fetchAllKeyset<{ id: string; conversation_id: string | null }>(() =>
        supabase.from("messages").select("id, conversation_id").eq("org_id", orgId).in("property_id", ids),
      ),
    ]);
    if (runs.error) return fail(runs.error);
    if (msgs.error) return fail(msgs.error);
    linkRuns.push(...runs.rows.map((r) => r.id));
    for (const m of msgs.rows) {
      linkMsgs.push(m.id);
      if (m.conversation_id) linkConvs.add(m.conversation_id);
    }
  }
  const byId = new Map<string, HoldDraftRow>();
  const lookups: Array<[string, string[]]> = [
    ["property_id", propertyIds],
    ["run_id", uniq(linkRuns)],
    ["inbound_message_id", uniq(linkMsgs)],
    ["conversation_id", [...linkConvs]],
  ];
  for (const [col, all] of lookups) {
    for (const ids of chunks(all)) {
      const res = await fetchAllKeyset<HoldDraftRow>(() =>
        supabase.from("ai_reply_drafts").select(draftColumns(false)).eq("org_id", orgId).eq("status", "pending").in(col, ids),
      );
      if (res.error) return fail(res.error);
      for (const d of res.rows) byId.set(d.id, d);
    }
  }
  return { rows: [...byId.values()], error: null };
}

/** Step 2. Every property each draft could belong to. Null when any lookup fails. */
export async function resolveDraftProperties(
  supabase: LooseSupabase,
  orgId: string,
  drafts: readonly HoldDraftRow[],
): Promise<Map<string, Set<string>> | null> {
  const runIds = uniq(drafts.flatMap((d) => (d.run_id ? [d.run_id] : [])));
  const msgIds = uniq(drafts.flatMap((d) => (d.inbound_message_id ? [d.inbound_message_id] : [])));
  const convIds = uniq(drafts.flatMap((d) => (d.conversation_id ? [d.conversation_id] : [])));

  const runProperty = new Map<string, string | null>();
  const msgProperty = new Map<string, string | null>();
  const convProperties = new Map<string, Set<string>>();
  let failed = false;

  await Promise.all([
    ...chunks(runIds).map(async (ids) => {
      const res = await fetchAllKeyset<{ id: string; property_id: string | null; started_at: string }>(() =>
        supabase.from("pipeline_runs").select("id, property_id, started_at").eq("org_id", orgId).in("id", ids),
      );
      if (res.error) failed = true;
      else for (const r of res.rows) runProperty.set(r.id, r.property_id);
    }),
    // (A referenced run or message with no row in this org is UNRESOLVED, not "no property": see below.)
    ...chunks(msgIds).map(async (ids) => {
      const res = await fetchAllKeyset<{ id: string; property_id: string | null; created_at: string }>(() =>
        supabase.from("messages").select("id, property_id, created_at").eq("org_id", orgId).in("id", ids),
      );
      if (res.error) failed = true;
      else for (const m of res.rows) msgProperty.set(m.id, m.property_id);
    }),
    ...chunks(convIds).map(async (ids) => {
      const res = await fetchAllKeyset<{ conversation_id: string; property_id: string; created_at: string }>(() =>
        supabase
          .from("messages")
          .select("id, conversation_id, property_id, created_at")
          .eq("org_id", orgId)
          .in("conversation_id", ids)
          .not("property_id", "is", null),
      );
      if (res.error) failed = true;
      else
        for (const m of res.rows) {
          const set = convProperties.get(m.conversation_id) ?? new Set<string>();
          set.add(m.property_id);
          convProperties.set(m.conversation_id, set);
        }
    }),
  ]);
  if (failed) return null;

  // Every candidate property, from any path, must exist in THIS org; otherwise the draft is unverifiable (an
  // org-scoped lock check could not see it). Keyset-paged, fail closed.
  const raw = new Set<string>();
  for (const d of drafts) if (d.property_id) raw.add(d.property_id);
  for (const p of runProperty.values()) if (p) raw.add(p);
  for (const p of msgProperty.values()) if (p) raw.add(p);
  for (const set of convProperties.values()) for (const p of set) raw.add(p);
  const inOrg = new Set<string>();
  for (const c of chunks([...raw])) {
    const res = await fetchAllKeyset<{ id: string }>(() => supabase.from("properties").select("id").eq("org_id", orgId).in("id", c));
    if (res.error) return null;
    for (const p of res.rows) inOrg.add(p.id);
  }

  const out = new Map<string, Set<string>>();
  for (const d of drafts) {
    // A reference that could not be read (absent, another org's, or hidden) might point anywhere: the draft is
    // unverifiable even if another link names a readable property.
    if ((d.run_id && !runProperty.has(d.run_id)) || (d.inbound_message_id && !msgProperty.has(d.inbound_message_id))) {
      out.set(d.id, new Set());
      continue;
    }
    const c = new Set<string>();
    if (d.property_id) c.add(d.property_id);
    const viaRun = d.run_id ? runProperty.get(d.run_id) : null;
    if (viaRun) c.add(viaRun);
    const viaMsg = d.inbound_message_id ? msgProperty.get(d.inbound_message_id) : null;
    if (viaMsg) c.add(viaMsg);
    for (const p of d.conversation_id ? (convProperties.get(d.conversation_id) ?? []) : []) c.add(p);
    // A property outside the org makes the draft unverifiable: return no candidates (excluded and counted).
    out.set(d.id, [...c].every((p) => inOrg.has(p)) ? c : new Set());
  }
  return out;
}

/** The newest run, by microsecond then id. */
const newerRun = <R extends PipelineRun>(a: R | null, b: R): R =>
  !a || compareInstants(b.started_at, a.started_at) > 0 || (compareInstants(b.started_at, a.started_at) === 0 && b.id > a.id) ? b : a;

/**
 * Step 4. Attaches each hold's newest related run. Its `steps` carry only ACTIVITY_STEP_COLUMNS (id, run_id, seq,
 * created_at): enough to order, never rendered. enrichPage swaps in full steps for the runs a page shows. Null when
 * any lookup fails.
 */
export async function loadHoldActivity(
  supabase: LooseSupabase,
  orgId: string,
  holds: OpenHold<PipelineRun>[],
  links: { convsByProperty: Map<string, Set<string>>; draftRunsByProperty: Map<string, Set<string>> },
): Promise<OpenHold<RunWithSteps>[] | null> {
  const propertyIds = holds.map((h) => h.id);
  const msgIds = uniq(holds.flatMap((h) => h.message_ids ?? []));
  const draftRunIds = uniq([...links.draftRunsByProperty.values()].flatMap((s) => [...s]));
  const convIds = uniq([...links.convsByProperty.values()].flatMap((s) => [...s]));
  const runs = new Map<string, PipelineRun>();
  let failed = false;
  const take = (rows: unknown) => {
    for (const r of (rows ?? []) as PipelineRun[]) runs.set(r.id, r);
  };

  await Promise.all([
    // EVERY run on each hold's property (not just the latest): an older run can carry a newer step.
    ...chunks(propertyIds).map(async (ids) => {
      const res = await fetchAllKeyset<PipelineRun>(() =>
        supabase.from("pipeline_runs").select("*").eq("org_id", orgId).in("property_id", ids),
      );
      if (res.error) failed = true;
      else take(res.rows);
    }),
    ...chunks(propertyIds, LATEST_RUN_CHUNK).map(async (ids) => {
      const res = await supabase.rpc("pipeline_runs_latest_for_properties", { p_org_id: orgId, p_property_ids: ids });
      if (res.error) failed = true;
      else take(res.data);
    }),
    ...chunks(msgIds).map(async (ids) => {
      const res = await fetchAllKeyset<PipelineRun>(() =>
        supabase.from("pipeline_runs").select("*").eq("org_id", orgId).in("inbound_message_id", ids),
      );
      if (res.error) failed = true;
      else take(res.rows);
    }),
    ...chunks(draftRunIds).map(async (ids) => {
      const res = await fetchAllKeyset<PipelineRun>(() => supabase.from("pipeline_runs").select("*").eq("org_id", orgId).in("id", ids));
      if (res.error) failed = true;
      else take(res.rows);
    }),
    // Only PROPERTY-LESS runs in a hold's conversations count: a run on another property never moves this hold.
    ...chunks(convIds).map(async (ids) => {
      const res = await fetchAllKeyset<PipelineRun>(() =>
        supabase.from("pipeline_runs").select("*").eq("org_id", orgId).in("conversation_id", ids).is("property_id", null),
      );
      if (res.error) failed = true;
      else take(res.rows);
    }),
  ]);
  if (failed) return null;

  const all = [...runs.values()];

  // Every (run -> hold) link from every path: property, source message, draft run, property-less conversation run.
  // Indexed, not holds x runs: each run looks up the holds each of its keys links to.
  const index = (pairs: Array<[string, string]>) => {
    const m = new Map<string, Set<string>>();
    for (const [k, h] of pairs) m.set(k, (m.get(k) ?? new Set<string>()).add(h));
    return m;
  };
  const heldIds = new Set(holds.map((h) => h.id));
  const byMsg = index(holds.flatMap((h) => (h.message_ids ?? []).map((m) => [m, h.id] as [string, string])));
  const byDraftRun = index([...links.draftRunsByProperty].flatMap(([h, rs]) => [...rs].map((r) => [r, h] as [string, string])));
  const byConv = index([...links.convsByProperty].flatMap(([h, cs]) => [...cs].map((c) => [c, h] as [string, string])));
  const holdOrder = new Map(holds.map((h, i) => [h.id, i]));
  const candidates = new Map<string, string[]>();
  for (const r of all) {
    const linked = new Set<string>();
    if (r.property_id && heldIds.has(r.property_id)) linked.add(r.property_id);
    for (const h of byMsg.get(r.inbound_message_id) ?? []) linked.add(h);
    for (const h of byDraftRun.get(r.id) ?? []) linked.add(h);
    if (r.property_id === null && r.conversation_id !== null) for (const h of byConv.get(r.conversation_id) ?? []) linked.add(h);
    // Same order the old holds-outer loop produced (pick() sorts, but keep it identical anyway).
    if (linked.size) candidates.set(r.id, [...linked].sort((a, b) => holdOrder.get(a)! - holdOrder.get(b)!));
  }

  const stepRunIds = [...candidates.keys()];
  const steps = new Map<string, PipelineRunStep[]>();
  const stepResults = await Promise.all(
    chunks(stepRunIds).map((ids) =>
      fetchAllKeyset<PipelineRunStep>(() =>
        supabase.from("pipeline_run_steps").select(ACTIVITY_STEP_COLUMNS).eq("org_id", orgId).in("run_id", ids),
      ),
    ),
  );
  if (stepResults.some((r) => r.error)) return null;
  for (const st of stepResults.flatMap((r) => r.rows)) {
    const list = steps.get(st.run_id) ?? [];
    list.push(st);
    steps.set(st.run_id, list);
  }
  for (const list of steps.values()) list.sort((a, b) => a.seq - b.seq);

  const newest = (vals: Array<string | null | undefined>): string | null =>
    vals.reduce<string | null>((m, v) => (!v ? m : m === null || compareInstants(v, m) > 0 ? v : m), null);
  const runActivity = (r: PipelineRun) => newest([r.started_at, ...(steps.get(r.id) ?? []).map((st) => st.created_at)]);

  // Each run belongs to EXACTLY ONE hold, globally, before any context or reason is computed:
  //   - a run on a held property belongs to that property's hold;
  //   - otherwise (a property-less run, or one linked to several holds by different paths) it goes to the linked
  //     hold with the newest activity counting only its uncontested runs (tie: lowest hold id).
  const uncontested = new Map<string, PipelineRun[]>();
  for (const r of all) {
    const c = candidates.get(r.id);
    if (!c) continue;
    const solo = r.property_id && c.includes(r.property_id) ? r.property_id : c.length === 1 ? c[0] : null;
    if (solo) uncontested.set(solo, [...(uncontested.get(solo) ?? []), r]);
  }
  const baseActivity = new Map(
    holds.map((h) => [h.id, newest([h.since, h.last_activity, ...(uncontested.get(h.id) ?? []).map(runActivity)])] as const),
  );
  const pick = (ids: string[]) =>
    [...ids].sort((x, y) => {
      const ax = baseActivity.get(x) ?? null;
      const ay = baseActivity.get(y) ?? null;
      if (ax !== ay) {
        if (ax === null) return 1;
        if (ay === null) return -1;
        const c = compareInstants(ay, ax);
        if (c) return c;
      }
      return x < y ? -1 : x > y ? 1 : 0;
    })[0];
  const related = new Map<string, PipelineRun[]>();
  for (const r of all) {
    const c = candidates.get(r.id);
    if (!c) continue;
    const owner = r.property_id && c.includes(r.property_id) ? r.property_id : pick(c);
    related.set(owner, [...(related.get(owner) ?? []), r]);
  }

  return holds.map((h) => {
    const mine = related.get(h.id) ?? [];
    let run: PipelineRun | null = null;
    for (const r of mine) run = newerRun(run, r);
    return {
      ...h,
      related_activity: newest(mine.map(runActivity)),
      run: run ? { ...run, steps: steps.get(run.id) ?? [] } : null,
    };
  });
}

/** `unverified` is the whole-org count for an unscoped build, null for a scoped one (it only sees some sources). */
export type EligibleHolds =
  | { ok: true; holds: OpenHold<RunWithSteps>[]; unverified: number | null }
  | { ok: false; error: string };

/**
 * Steps 1-5: the COMPLETE eligible list from CURRENT sources, sorted newest activity first. With `scope`, the same
 * build for only those properties (see HoldScope).
 */
export async function loadEligibleHolds(supabase: LooseSupabase, orgId: string, scope?: HoldScope): Promise<EligibleHolds> {
  const fail = { ok: false as const, error: HOLDS_LOAD_ERROR };
  const sources = await loadHoldSources(supabase, orgId, scope);
  if (!sources) return fail;
  const candidates = await resolveDraftProperties(supabase, orgId, sources.drafts);
  if (!candidates) return fail;
  const inScope = scope ? new Set(scope.propertyIds) : null;

  const every = uniq([
    ...sources.properties.map((p) => p.id),
    ...sources.decisions.map((d) => d.property_id),
    ...sources.reviews.map((r) => r.property_id),
    ...[...candidates.values()].flatMap((s) => [...s]),
  ]);
  // EVERY candidate property from EVERY source must be positively verified: in this org and readably unlocked.
  const verified = every.length ? await verifyProperties(supabase, orgId, every) : { unlocked: new Set<string>(), locked: new Set<string>() };
  if (!verified) return fail;
  const { locked, unlocked } = verified;

  let unverified = 0;
  const drafts: HoldDraftRow[] = [];
  for (const d of sources.drafts) {
    const c = [...(candidates.get(d.id) ?? [])];
    if (c.some((p) => locked.has(p))) continue; // locked: never shown, not "unverified"
    if (c.length !== 1 || !unlocked.has(c[0])) {
      unverified += 1; // no property, more than one, or one that cannot be verified
      continue;
    }
    if (inScope && !inScope.has(c[0])) continue; // another hold's draft: counted above, not built here
    drafts.push({ ...d, property_id: c[0] });
  }
  // Locked: hidden, not counted. Absent / another org's / unreadable: hidden AND counted.
  const keep = (pid: string) => {
    if (locked.has(pid)) return false;
    if (!unlocked.has(pid)) {
      unverified += 1;
      return false;
    }
    return true;
  };
  const decisions = sources.decisions.filter((d) => keep(d.property_id));
  const reviews = sources.reviews.filter((r) => keep(r.property_id));
  const properties = sources.properties.filter((p) => keep(p.id));

  const convsByProperty = new Map<string, Set<string>>();
  const draftRunsByProperty = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, k: string, v: string | null) => {
    if (!v) return;
    const s = m.get(k) ?? new Set<string>();
    s.add(v);
    m.set(k, s);
  };
  for (const r of [...decisions, ...reviews]) add(convsByProperty, r.property_id, r.conversation_id);
  for (const d of drafts) {
    add(convsByProperty, d.property_id!, d.conversation_id);
    add(draftRunsByProperty, d.property_id!, d.run_id);
  }

  // The hold Send/Edit path only sends a draft tied DIRECTLY to the property and to the seller text it answers
  // (hold-actions.ts performSend). Anything else is shown, but its Send/Edit are disabled on the card.
  const original = new Map(sources.drafts.map((d) => [d.id, d] as const));
  const base = deriveOpenHolds({ properties, decisions, reviews, drafts, runs: [] }).map((h) => {
    if (!h.draft) return h;
    const row = original.get(h.draft.id);
    return { ...h, draft: { ...h.draft, sendable: row?.property_id === h.id && !!row?.inbound_message_id } };
  });
  const withRuns = await loadHoldActivity(supabase, orgId, base, { convsByProperty, draftRunsByProperty });
  if (!withRuns) return fail;
  return { ok: true, holds: sortNewestFirst(withRuns), unverified: scope ? null : unverified };
}

/**
 * The client-held snapshot of the waiting list. Order is computed ONCE from current sources and frozen here; pages
 * are positions in `entries`. Time (`at`), reason (`r`, index into `reasons`, -1 = none), the shown run and the
 * flag time (`fa`) are the values the order was computed from; cards and the tape render from them. A reload
 * builds a new snapshot. (A server "as of" recompute is impossible: several production writes overwrite the
 * ordering columns with no history, so the past cannot be reconstructed.)
 */
/** `th` = the newest pending decision / review / draft the order was built from (the hold's "seen through"). */
/** `d` / `ds` = the draft the card showed at snapshot time and whether it was sendable from the card. */
export type SnapshotEntry = {
  id: string;
  at: string | null;
  r: number;
  run: string | null;
  fa: string | null;
  th: string | null;
  d?: string | null;
  ds?: boolean;
  /**
   * The frozen DISPLAY reason (index into reasons) when it differs from the flag reason `r`: the flag reason, else
   * the hold's run reason, computed once here. Tape and card show it; stale checks keep comparing `r`.
   */
  x?: number;
};
export type WaitingSnapshot = { reasons: string[]; entries: SnapshotEntry[] };

export function buildSnapshot(sorted: readonly OpenHold<RunWithSteps>[]): WaitingSnapshot {
  const reasons: string[] = [];
  const index = new Map<string, number>();
  const indexOf = (reason: string | null): number => {
    if (!reason) return -1;
    let k = index.get(reason);
    if (k === undefined) {
      k = reasons.length;
      reasons.push(reason);
      index.set(reason, k);
    }
    return k;
  };
  const entries = sorted.map((h): SnapshotEntry => {
    const r = indexOf(h.flag_reason ?? null);
    // Display reason, frozen now: the flag reason, else the run's own reason (an unflagged hold still reads right).
    const x = h.flag_reason ? r : indexOf(h.run?.reason ?? null);
    return {
      id: h.id,
      at: holdActivityAt(h),
      r,
      run: h.run?.id ?? null,
      fa: h.seen?.flagAt ?? null,
      th: h.seen?.through ?? null,
      // Omitted when there is no draft, to keep the list small.
      ...(h.draft ? { d: h.draft.id, ds: h.draft.sendable === true } : {}),
      ...(x !== r ? { x } : {}),
    };
  });
  return { reasons, entries };
}

/**
 * Run id -> frozen reason for EVERY snapshot run, for the tape. A null value is a "pinned null": present and
 * authoritative, so no later (live) reason may replace it. Each run has exactly one owning hold.
 */
export function snapshotFlagReasons(s: WaitingSnapshot): Array<[string, string | null]> {
  return s.entries.flatMap((e) => {
    const k = e.x ?? e.r;
    return e.run ? [[e.run, k >= 0 ? s.reasons[k] : null] as [string, string | null]] : [];
  });
}

/**
 * Run id -> the flag reason the TAPE may claim for that run, over the COMPLETE eligible list. One run can be the
 * shown run of several holds (a property-less run in a shared conversation). If they all agree, that reason; if
 * one of them owns the run's property, that hold's reason; otherwise no reason is claimed (the tape says it waits
 * for a person without guessing).
 */
export function effectiveFlagReasons(holds: readonly OpenHold<RunWithSteps>[]): Array<[string, string]> {
  const owners = new Map<string, OpenHold<RunWithSteps>[]>();
  for (const h of holds) if (h.run) owners.set(h.run.id, [...(owners.get(h.run.id) ?? []), h]);
  const out: Array<[string, string]> = [];
  for (const [runId, hs] of owners) {
    const reasons = uniq(hs.map((h) => h.flag_reason ?? null));
    if (reasons.length === 1) {
      if (reasons[0]) out.push([runId, reasons[0]]);
      continue;
    }
    const runProperty = hs[0].run?.property_id ?? null;
    const owner = runProperty ? hs.find((h) => h.id === runProperty) : undefined;
    if (owner?.flag_reason) out.push([runId, owner.flag_reason]);
  }
  return out;
}

/** Step 6 (returned page only): draft text, dead letters, alert status, fresh "seen". Failures are notes. */

/** Full steps (with detail), in seq order, for the runs a page shows. Null when any lookup fails. */
export async function loadShownSteps(
  supabase: LooseSupabase,
  orgId: string,
  runIds: readonly string[],
): Promise<Map<string, PipelineRunStep[]> | null> {
  const results = await Promise.all(
    chunks(uniq(runIds)).map((ids) =>
      fetchAllKeyset<PipelineRunStep>(() => supabase.from("pipeline_run_steps").select("*").eq("org_id", orgId).in("run_id", ids)),
    ),
  );
  if (results.some((r) => r.error)) return null;
  const steps = new Map<string, PipelineRunStep[]>();
  for (const st of results.flatMap((r) => r.rows)) steps.set(st.run_id, [...(steps.get(st.run_id) ?? []), st]);
  for (const list of steps.values()) list.sort((a, b) => a.seq - b.seq);
  return steps;
}

/** Null when the shown runs' full steps cannot be loaded (fail closed: a card never renders activity-only steps). */
export async function enrichPage(
  supabase: LooseSupabase,
  orgId: string,
  listed: OpenHold<RunWithSteps>[],
): Promise<{ holds: OpenHold<RunWithSteps>[]; contextErrors: string[]; deadLetterUnavailable: boolean } | null> {
  const contextErrors: string[] = [];
  const full = await loadShownSteps(supabase, orgId, listed.flatMap((h) => (h.run ? [h.run.id] : [])));
  if (!full) return null;
  const holds = listed.map((h) => (h.run ? { ...h, run: { ...h.run, steps: full.get(h.run.id) ?? [] } } : h));
  const draftIds = holds.flatMap((h) => (h.draft ? [h.draft.id] : []));
  const bodies = new Map<string, { body: string; edited_body: string | null; edited_at: string | null }>();
  for (const ids of chunks(draftIds)) {
    const res = await supabase.from("ai_reply_drafts").select("id, body, edited_body, edited_at").eq("org_id", orgId).in("id", ids);
    if (res.error) {
      if (!contextErrors.includes("draft text")) contextErrors.push("draft text");
      continue;
    }
    for (const r of (res.data ?? []) as Array<{ id: string; body: string; edited_body: string | null; edited_at: string | null }>) bodies.set(r.id, r);
  }
  const withBodies = holds.map((h) => {
    const b = h.draft ? bodies.get(h.draft.id) : undefined;
    return b && h.draft ? { ...h, draft: { ...h.draft, body: b.body, edited_body: b.edited_body, edited_at: b.edited_at } } : h;
  });
  const enriched = await enrichHoldCards(supabase, orgId, withBodies);
  // The fresh version check. On failure the cards keep their window seen but the column pauses their actions
  // ("Couldn't re-check") until a live re-check succeeds: never actionable without a successful version check.
  const pids = enriched.holds.flatMap((h) => (h.property_id ? [h.property_id] : []));
  let fresh: Map<string, HoldSeen> | null = null;
  try {
    fresh = pids.length ? await loadFreshSeen(supabase, orgId, pids) : new Map();
  } catch {
    fresh = null;
  }
  if (!fresh) contextErrors.push(SEEN_CHECK_FAILED);
  const seen = fresh
    ? enriched.holds.map((h) => {
        const f = h.property_id ? fresh!.get(h.property_id) : undefined;
        return f ? { ...h, seen: mergeSeen(h.seen, f) } : h;
      })
    : enriched.holds;
  return {
    holds: seen,
    contextErrors: [...contextErrors, ...enriched.contextErrors],
    deadLetterUnavailable: enriched.deadLetterUnavailable,
  };
}

/**
 * THE final check (one function, one contract), run on cards about to render:
 *
 *   For every returned hold, recompute (eligible, locked, resolved property, displayed draft id + property, all
 *   current draft links, flag reason, flag time, run id, pending-row version) from CURRENT data via the same
 *   resolvers the snapshot uses (loadEligibleHolds: every draft link path, org-verified, DNC lock filter), and
 *   compare each to the hold as it was built. Any difference -> `changed` (the card renders Updated, actions
 *   disabled). Not eligible / locked / unresolvable -> not in `open` (missing). The version returned is always the
 *   CURRENT one: an older value is never carried forward in place of a current one.
 *
 * `badDraft` = the displayed draft is no longer the hold's current draft: it is dropped from the card so Send/Edit
 * cannot act on it. `unsendable` = still the current draft but no longer sendable from the card: kept, Send disabled. Returns null when any lookup fails (fail closed).
 */
export async function recheckOpen(
  supabase: LooseSupabase,
  orgId: string,
  holds: readonly OpenHold<RunWithSteps>[],
): Promise<{
  open: Set<string>;
  badDraft: Set<string>;
  version: Map<string, HoldSeen>;
  changed: Set<string>;
  /** Same draft, but it can no longer be sent from the card: kept with Send disabled. */
  unsendable: Set<string>;
} | null> {
  const unsendable = new Set<string>();
  const open = new Set<string>();
  const badDraft = new Set<string>();
  const version = new Map<string, HoldSeen>();
  const changed = new Set<string>();
  if (!holds.length) return { open, badDraft, version, changed, unsendable };
  // Recomputed from CURRENT data for these holds only (not the whole list): cost follows the page, not the backlog.
  const list = await loadEligibleHolds(supabase, orgId, { propertyIds: holds.map((h) => h.id) });
  if (!list.ok) return null;
  const current = new Map(list.holds.map((h) => [h.id, h]));
  const pinsOf = (h: OpenHold<RunWithSteps>) => {
    const snap = buildSnapshot([h]);
    const e = snap.entries[0];
    return { ...e, reason: e.r >= 0 ? snap.reasons[e.r] : null, seenReason: h.seen?.flagReason ?? null };
  };
  for (const h of holds) {
    const cur = current.get(h.id);
    if (!cur) continue; // not eligible, DNC-locked or unresolvable now -> missing
    open.add(h.id);
    version.set(h.id, { through: cur.seen?.through ?? null, flagReason: cur.seen?.flagReason ?? null, flagAt: cur.seen?.flagAt ?? null });
    const was = pinsOf(h);
    const now = pinsOf(cur);
    const draftSame = (h.draft?.id ?? null) === (cur.draft?.id ?? null) && (h.draft?.sendable === true) === (cur.draft?.sendable === true);
    if (h.draft && (h.draft.id !== (cur.draft?.id ?? null))) badDraft.add(h.id);
    else if (h.draft && !draftSame && cur.draft?.sendable !== true) unsendable.add(h.id);
    if (
      !draftSame ||
      was.at !== now.at ||
      was.reason !== now.reason ||
      was.run !== now.run ||
      was.fa !== now.fa ||
      was.th !== now.th ||
      was.seenReason !== now.seenReason
    )
      changed.add(h.id);
  }
  return { open, badDraft, version, changed, unsendable };
}

/** What a rendered card is checked against while the page stays open (no migration: properties is not in realtime). */
export type HoldLiveState = {
  id: string;
  eligible: boolean;
  flagAt: string | null;
  flagReason: string | null;
  runId: string | null;
  activityAt: string | null;
  /** The newest pending decision / review / draft now (compared with the snapshot's `th`). */
  through: string | null;
  /** The newest pending draft the hold would show now, and the property it resolves to (null = none). */
  draftId: string | null;
  draftProperty: string | null;
  /** Whether that draft can be sent from the card now (tied directly to the property and its seller text). */
  draftSendable: boolean;
};

/** Current state of some ids, from the CURRENT eligible list (locked / resolved / unverifiable -> eligible false). */
export async function liveStateOf(supabase: LooseSupabase, orgId: string, ids: readonly string[]): Promise<HoldLiveState[] | null> {
  const list = ids.length ? await loadEligibleHolds(supabase, orgId, { propertyIds: ids }) : ({ ok: true, holds: [], unverified: 0 } as const);
  if (!list.ok) return null;
  const byId = new Map(list.holds.map((h) => [h.id, h]));
  return ids.map((id) => {
    const h = byId.get(id);
    return h
      ? {
          id,
          eligible: true,
          flagAt: h.seen?.flagAt ?? null,
          flagReason: h.flag_reason ?? null,
          runId: h.run?.id ?? null,
          activityAt: holdActivityAt(h),
          through: h.seen?.through ?? null,
          draftId: h.draft?.id ?? null,
          // Every draft in the eligible list resolved to exactly this hold's property.
          draftProperty: h.draft ? h.id : null,
          draftSendable: h.draft?.sendable === true,
        }
      : { id, eligible: false, flagAt: null, flagReason: null, runId: null, activityAt: null, through: null, draftId: null, draftProperty: null, draftSendable: false };
  });
}

/**
 * Send / Edit guard: the draft must still be pending and still resolve to exactly the property the clicker saw,
 * in this org, unlocked. "ok" | "stale" | null (lookup failed: refuse).
 */
export async function draftStillOn(
  supabase: LooseSupabase,
  orgId: string,
  draftId: string,
  propertyId: string,
): Promise<"ok" | "stale" | null> {
  const res = await fetchAllKeyset<HoldDraftRow>(() =>
    supabase.from("ai_reply_drafts").select(draftColumns(false)).eq("org_id", orgId).eq("status", "pending").in("id", [draftId]),
  );
  if (res.error) return null;
  if (res.rows.length !== 1) return "stale";
  const candidates = await resolveDraftProperties(supabase, orgId, res.rows);
  if (!candidates) return null;
  const c = [...(candidates.get(draftId) ?? [])];
  if (c.length !== 1 || c[0] !== propertyId) return "stale";
  const verified = await verifyProperties(supabase, orgId, [propertyId]);
  if (!verified) return null;
  return verified.unlocked.has(propertyId) ? "ok" : "stale";
}
