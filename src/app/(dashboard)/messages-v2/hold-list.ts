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
import { lockedPropertyIds } from "./dnc-locked";
import { holdActivityAt, sortNewestFirst } from "./hold-activity";
import { withFreshSeen } from "./hold-seen";
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
import type { OpenHold, PipelineRun, PipelineRunStep, RunWithSteps } from "./types";

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

export type HoldSources = {
  properties: HoldPropertyRow[];
  decisions: Array<HoldDecisionRow & { id: string }>;
  reviews: Array<HoldReviewRow & { id: string }>;
  drafts: HoldDraftRow[];
};

/** Step 1. Null when any source fails. */
export async function loadHoldSources(supabase: LooseSupabase, orgId: string): Promise<HoldSources | null> {
  const [properties, decisions, reviews, drafts] = await Promise.all([
    fetchAllKeyset<HoldPropertyRow>(() =>
      supabase
        .from("properties")
        .select(PROPERTY_COLUMNS)
        .eq("org_id", orgId)
        .eq("needs_human_attention", true)
        .eq("is_dnc_locked", false),
    ),
    fetchAllKeyset<HoldDecisionRow & { id: string }>(() =>
      supabase.from("jev_lead_decisions").select(`id, ${DECISION_COLUMNS}`).eq("org_id", orgId).eq("status", "pending"),
    ),
    fetchAllKeyset<HoldReviewRow & { id: string }>(() =>
      supabase.from("ai_disposition_reviews").select(`id, ${REVIEW_COLUMNS}`).eq("org_id", orgId).eq("status", "pending"),
    ),
    fetchAllKeyset<HoldDraftRow>(() =>
      supabase.from("ai_reply_drafts").select(draftColumns(false)).eq("org_id", orgId).eq("status", "pending"),
    ),
  ]);
  if (properties.error || decisions.error || reviews.error || drafts.error) return null;
  return { properties: properties.rows, decisions: decisions.rows, reviews: reviews.rows, drafts: drafts.rows };
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

  const out = new Map<string, Set<string>>();
  for (const d of drafts) {
    const c = new Set<string>();
    if (d.property_id) c.add(d.property_id);
    const viaRun = d.run_id ? runProperty.get(d.run_id) : null;
    if (viaRun) c.add(viaRun);
    const viaMsg = d.inbound_message_id ? msgProperty.get(d.inbound_message_id) : null;
    if (viaMsg) c.add(viaMsg);
    for (const p of d.conversation_id ? (convProperties.get(d.conversation_id) ?? []) : []) c.add(p);
    out.set(d.id, c);
  }
  return out;
}

/** The newest run, by microsecond then id. */
const newerRun = <R extends PipelineRun>(a: R | null, b: R): R =>
  !a || compareInstants(b.started_at, a.started_at) > 0 || (compareInstants(b.started_at, a.started_at) === 0 && b.id > a.id) ? b : a;

/** Step 4. Attaches each hold's newest related run (with ALL its steps). Null when any lookup fails. */
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
  const candidates = new Map<string, string[]>();
  for (const h of holds) {
    const msgs = new Set(h.message_ids ?? []);
    const draftRuns = links.draftRunsByProperty.get(h.id) ?? new Set<string>();
    const convs = links.convsByProperty.get(h.id) ?? new Set<string>();
    for (const r of all) {
      const linked =
        r.property_id === h.id ||
        msgs.has(r.inbound_message_id) ||
        draftRuns.has(r.id) ||
        (r.property_id === null && r.conversation_id !== null && convs.has(r.conversation_id));
      if (linked) candidates.set(r.id, [...(candidates.get(r.id) ?? []), h.id]);
    }
  }

  const stepRunIds = [...candidates.keys()];
  const steps = new Map<string, PipelineRunStep[]>();
  const stepResults = await Promise.all(
    chunks(stepRunIds).map((ids) =>
      fetchAllKeyset<PipelineRunStep>(() => supabase.from("pipeline_run_steps").select("*").eq("org_id", orgId).in("run_id", ids)),
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

export type EligibleHolds =
  | { ok: true; holds: OpenHold<RunWithSteps>[]; unverified: number }
  | { ok: false; error: string };

/** Steps 1-5: the COMPLETE eligible list, sorted newest activity first. */
/** Steps 1-5: the COMPLETE eligible list from CURRENT sources, sorted newest activity first. */
export async function loadEligibleHolds(supabase: LooseSupabase, orgId: string): Promise<EligibleHolds> {
  const fail = { ok: false as const, error: HOLDS_LOAD_ERROR };
  const sources = await loadHoldSources(supabase, orgId);
  if (!sources) return fail;
  const candidates = await resolveDraftProperties(supabase, orgId, sources.drafts);
  if (!candidates) return fail;

  const every = uniq([
    ...sources.properties.map((p) => p.id),
    ...sources.decisions.map((d) => d.property_id),
    ...sources.reviews.map((r) => r.property_id),
    ...[...candidates.values()].flatMap((s) => [...s]),
  ]);
  const locked = every.length ? await lockedPropertyIds(supabase, orgId, every) : new Set<string>();
  if (!locked) return fail;

  let unverified = 0;
  const drafts: HoldDraftRow[] = [];
  for (const d of sources.drafts) {
    const c = [...(candidates.get(d.id) ?? [])];
    if (c.some((p) => locked.has(p))) continue; // locked: never shown, not "unverified"
    if (c.length !== 1) {
      unverified += 1; // no property, or more than one: cannot be verified
      continue;
    }
    drafts.push({ ...d, property_id: c[0] });
  }
  const decisions = sources.decisions.filter((d) => !locked.has(d.property_id));
  const reviews = sources.reviews.filter((r) => !locked.has(r.property_id));
  const properties = sources.properties.filter((p) => !locked.has(p.id));

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

  const base = deriveOpenHolds({ properties, decisions, reviews, drafts, runs: [] });
  const withRuns = await loadHoldActivity(supabase, orgId, base, { convsByProperty, draftRunsByProperty });
  if (!withRuns) return fail;
  return { ok: true, holds: sortNewestFirst(withRuns), unverified };
}

/**
 * The client-held snapshot of the waiting list. Order is computed ONCE from current sources and frozen here; pages
 * are positions in `entries`. Time (`at`), reason (`r`, index into `reasons`, -1 = none), the shown run and the
 * flag time (`fa`) are the values the order was computed from; cards and the tape render from them. A reload
 * builds a new snapshot. (A server "as of" recompute is impossible: several production writes overwrite the
 * ordering columns with no history, so the past cannot be reconstructed.)
 */
export type SnapshotEntry = { id: string; at: string | null; r: number; run: string | null; fa: string | null };
export type WaitingSnapshot = { reasons: string[]; entries: SnapshotEntry[] };

export function buildSnapshot(sorted: readonly OpenHold<RunWithSteps>[]): WaitingSnapshot {
  const reasons: string[] = [];
  const index = new Map<string, number>();
  const entries = sorted.map((h): SnapshotEntry => {
    const reason = h.flag_reason ?? null;
    let r = -1;
    if (reason) {
      r = index.get(reason) ?? reasons.length;
      if (r === reasons.length) {
        reasons.push(reason);
        index.set(reason, r);
      }
    }
    return { id: h.id, at: holdActivityAt(h), r, run: h.run?.id ?? null, fa: h.seen?.flagAt ?? null };
  });
  return { reasons, entries };
}

/**
 * Run id -> frozen reason for EVERY snapshot run, for the tape. A null value is a "pinned null": present and
 * authoritative, so no later (live) reason may replace it. Each run has exactly one owning hold.
 */
export function snapshotFlagReasons(s: WaitingSnapshot): Array<[string, string | null]> {
  return s.entries.flatMap((e) => (e.run ? [[e.run, e.r >= 0 ? s.reasons[e.r] : null] as [string, string | null]] : []));
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
export async function enrichPage(
  supabase: LooseSupabase,
  orgId: string,
  holds: OpenHold<RunWithSteps>[],
): Promise<{ holds: OpenHold<RunWithSteps>[]; contextErrors: string[]; deadLetterUnavailable: boolean }> {
  const contextErrors: string[] = [];
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
  const seen = await withFreshSeen(supabase, orgId, enriched.holds);
  return {
    holds: seen,
    contextErrors: [...contextErrors, ...enriched.contextErrors],
    deadLetterUnavailable: enriched.deadLetterUnavailable,
  };
}

/**
 * Final eligibility check for cards about to render (after enrichment): the property is not DNC-locked and the
 * hold still has an open source (flag on, or a pending decision / review / draft). Returns the ids that pass, or
 * null when any lookup fails (fail closed).
 */
export async function recheckOpen(
  supabase: LooseSupabase,
  orgId: string,
  holds: readonly OpenHold<RunWithSteps>[],
): Promise<Set<string> | null> {
  const ids = holds.map((h) => h.id);
  if (!ids.length) return new Set();
  const draftIds = holds.flatMap((h) => (h.draft ? [h.draft.id] : []));
  const open = new Set<string>();
  const locked = new Set<string>();
  let failed = false;
  await Promise.all([
    ...chunks(ids).map(async (c) => {
      const res = await fetchAllKeyset<{ id: string; needs_human_attention: boolean; is_dnc_locked: boolean }>(() =>
        supabase.from("properties").select("id, needs_human_attention, is_dnc_locked").eq("org_id", orgId).in("id", c),
      );
      if (res.error) failed = true;
      else
        for (const p of res.rows) {
          if (p.is_dnc_locked) locked.add(p.id);
          else if (p.needs_human_attention) open.add(p.id);
        }
    }),
    ...(["jev_lead_decisions", "ai_disposition_reviews", "ai_reply_drafts"] as const).flatMap((table) =>
      chunks(ids).map(async (c) => {
        const res = await fetchAllKeyset<{ property_id: string | null }>(() =>
          supabase.from(table).select("id, property_id").eq("org_id", orgId).eq("status", "pending").in("property_id", c),
        );
        if (res.error) failed = true;
        else for (const r of res.rows) if (r.property_id) open.add(r.property_id);
      }),
    ),
    // A draft resolved to its property through a run or message has no property_id of its own: check it by id.
    ...chunks(draftIds).map(async (c) => {
      const res = await fetchAllKeyset<{ id: string }>(() =>
        supabase.from("ai_reply_drafts").select("id").eq("org_id", orgId).eq("status", "pending").in("id", c),
      );
      if (res.error) failed = true;
      else {
        const pending = new Set(res.rows.map((r) => r.id));
        for (const h of holds) if (h.draft && pending.has(h.draft.id)) open.add(h.id);
      }
    }),
  ]);
  if (failed) return null;
  return new Set(ids.filter((id) => open.has(id) && !locked.has(id)));
}

/** What a rendered card is checked against while the page stays open (no migration: properties is not in realtime). */
export type HoldLiveState = {
  id: string;
  eligible: boolean;
  flagAt: string | null;
  flagReason: string | null;
  runId: string | null;
  activityAt: string | null;
};

/** Current state of some ids, from the CURRENT eligible list (locked / resolved / unverifiable -> eligible false). */
export async function liveStateOf(supabase: LooseSupabase, orgId: string, ids: readonly string[]): Promise<HoldLiveState[] | null> {
  const list = await loadEligibleHolds(supabase, orgId);
  if (!list.ok) return null;
  const byId = new Map(list.holds.map((h) => [h.id, h]));
  return ids.map((id) => {
    const h = byId.get(id);
    return h
      ? { id, eligible: true, flagAt: h.seen?.flagAt ?? null, flagReason: h.flag_reason ?? null, runId: h.run?.id ?? null, activityAt: holdActivityAt(h) }
      : { id, eligible: false, flagAt: null, flagReason: null, runId: null, activityAt: null };
  });
}
