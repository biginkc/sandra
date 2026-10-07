import type {
  HeaderStats,
  HoldsMeta,
  HoldSource,
  ModeBadge,
  OpenHold,
  PipelineCoverage,
  PipelineRun,
  PipelineRunStep,
  RunWithSteps,
} from "./types";

export const MAX_RUNS = 200;
const HOUR_MS = 60 * 60 * 1000;

export type HoldPropertyRow = {
  id: string;
  last_ai_escalation_at: string | null;
  last_ai_escalation_reason: string | null;
  updated_at: string | null;
};
export type HoldDecisionRow = {
  property_id: string;
  conversation_id: string;
  source_inbound_message_id: string;
  created_at: string;
};
export type HoldReviewRow = HoldDecisionRow & { disposition: string };

const SOURCE_LABEL: Record<HoldSource, string> = {
  needs_attention: "Needs attention",
  jev_decision: "Jev decision pending",
  disposition_review: "Disposition review pending",
};

/**
 * Open holds, derived from the tables that actually own the hold state: a
 * flagged property (needs_human_attention), a pending Jev decision, or a
 * pending disposition review. A hold stays open until THAT flag/row clears,
 * regardless of what later pipeline runs say. Each is joined to its most
 * recent run (by property, conversation or source inbound message) for the
 * card; with no run the card is a fallback. One hold per property, oldest
 * first. Callers pass only flagged properties and pending rows.
 */
export function deriveOpenHolds<T extends PipelineRun>(input: {
  properties: readonly HoldPropertyRow[];
  decisions: readonly HoldDecisionRow[];
  reviews: readonly HoldReviewRow[];
  runs: readonly T[];
}): OpenHold<T>[] {
  type Acc = {
    sources: Set<HoldSource>;
    times: string[];
    conversations: Set<string>;
    messages: Set<string>;
    notes: string[];
  };
  const byProperty = new Map<string, Acc>();
  const acc = (id: string): Acc => {
    let a = byProperty.get(id);
    if (!a) {
      a = {
        sources: new Set(),
        times: [],
        conversations: new Set(),
        messages: new Set(),
        notes: [],
      };
      byProperty.set(id, a);
    }
    return a;
  };

  for (const p of input.properties) {
    const a = acc(p.id);
    a.sources.add("needs_attention");
    // updated_at is NOT a hold clock (any edit resets it): unknown stays unknown
    // unless a pending decision/review supplies an earlier-known time.
    if (p.last_ai_escalation_at) a.times.push(p.last_ai_escalation_at);
    if (p.last_ai_escalation_reason) a.notes.push(p.last_ai_escalation_reason);
  }
  for (const d of input.decisions) {
    const a = acc(d.property_id);
    a.sources.add("jev_decision");
    a.times.push(d.created_at);
    a.conversations.add(d.conversation_id);
    a.messages.add(d.source_inbound_message_id);
  }
  for (const r of input.reviews) {
    const a = acc(r.property_id);
    a.sources.add("disposition_review");
    a.times.push(r.created_at);
    a.conversations.add(r.conversation_id);
    a.messages.add(r.source_inbound_message_id);
    a.notes.push(r.disposition);
  }

  const order: HoldSource[] = [
    "needs_attention",
    "jev_decision",
    "disposition_review",
  ];
  const holds: OpenHold<T>[] = [];
  for (const [propertyId, a] of byProperty) {
    let run: T | null = null;
    for (const candidate of input.runs) {
      const matches =
        candidate.property_id === propertyId ||
        a.messages.has(candidate.inbound_message_id) ||
        (candidate.conversation_id !== null &&
          a.conversations.has(candidate.conversation_id));
      if (
        matches &&
        (!run || Date.parse(candidate.started_at) > Date.parse(run.started_at))
      ) {
        run = candidate;
      }
    }
    const since =
      [...a.times].sort((x, y) => Date.parse(x) - Date.parse(y))[0] ?? null;
    const sources = order.filter((s) => a.sources.has(s));
    const labels = sources.map((s) => SOURCE_LABEL[s]).join(" · ");
    holds.push({
      id: propertyId,
      property_id: propertyId,
      conversation_id: [...a.conversations][0] ?? run?.conversation_id ?? null,
      sources,
      since,
      reason:
        a.notes.length > 0
          ? `${labels} (${[...new Set(a.notes)].join(", ")})`
          : labels,
      run,
    });
  }
  const t = (h: OpenHold<T>) =>
    h.since ? Date.parse(h.since) : Number.POSITIVE_INFINITY;
  // Unknown-age holds sort last in the list (never first by accident).
  return holds.sort((x, y) =>
    t(x) === t(y) ? x.id.localeCompare(y.id) : t(x) - t(y),
  );
}

export function computeHeaderStats(
  runs: readonly PipelineRun[],
  nowMs: number,
  openHolds: number,
): HeaderStats {
  const cutoff = nowMs - HOUR_MS;
  return {
    runsLastHour: runs.filter((r) => Date.parse(r.started_at) >= cutoff).length,
    openHolds,
  };
}

/** Seam-health line: every inbound should have a run. `gap` when runs < inbound. */
export function describeCoverage(
  coverage: PipelineCoverage | null | undefined,
  unavailable = false,
): { text: string; gap: boolean; degraded?: boolean } | null {
  if (unavailable) {
    return { text: "coverage unavailable", gap: true, degraded: true };
  }
  if (!coverage) return null;
  return {
    text: `${coverage.inboundMessages} inbound / ${coverage.runs} runs (last hour)`,
    gap: coverage.runs < coverage.inboundMessages,
  };
}

export type ThresholdRow = {
  outcome: string;
  min_confidence?: number | string | null;
  /** Missing column / null is treated as enabled. */
  automation_enabled?: boolean | null;
};

export function buildModeBadges(
  config: { classifier_provider: string; classifier_mode: string } | null,
  thresholds: readonly ThresholdRow[],
): ModeBadge[] {
  return thresholds.map((t) => {
    if (config?.classifier_provider !== "jev")
      return { label: t.outcome, mode: "LEGACY" as const };
    if (config.classifier_mode !== "automatic")
      return { label: t.outcome, mode: "SHADOW" as const };
    if (t.automation_enabled === false)
      return { label: t.outcome, mode: "HELD" as const };
    const min = t.min_confidence == null ? NaN : Number(t.min_confidence);
    return {
      label: t.outcome,
      mode: "AUTO" as const,
      minConfidence: Number.isFinite(min) ? min : null,
    };
  });
}

/** "AUTO ≥0.95", "HELD", "SHADOW", "LEGACY". */
export function formatModeBadge(b: ModeBadge): string {
  if (b.mode === "AUTO" && b.minConfidence != null)
    return `AUTO ≥${b.minConfidence.toFixed(2)}`;
  return b.mode;
}

export function groupStepsByRun(
  steps: readonly PipelineRunStep[],
): Map<string, PipelineRunStep[]> {
  const grouped = new Map<string, PipelineRunStep[]>();
  for (const step of steps) {
    const list = grouped.get(step.run_id) ?? [];
    list.push(step);
    grouped.set(step.run_id, list);
  }
  for (const list of grouped.values()) list.sort((a, b) => a.seq - b.seq);
  return grouped;
}

// pipeline_runs is not in the generated Database type yet; a loose client keeps
// this page independent of types.ts.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type LooseSupabase = {
  from(table: string): any;
  rpc(fn: string, args: Record<string, unknown>): any;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export type MessagesV2Data = {
  runs: RunWithSteps[];
  holds: OpenHold<RunWithSteps>[];
  holdsMeta: HoldsMeta;
  badges: ModeBadge[];
  nowMs: number;
};

/**
 * Truncation/failure summary for the hold queries. `total` is the largest
 * per-source exact count (a lower bound on distinct holds when truncated) and
 * never below what is shown.
 */
export function buildHoldsMeta(input: {
  shown: number;
  contextErrors?: string[];
  sources: ReadonlyArray<{
    source: HoldSource;
    count: number | null;
    returned: number;
    failed: boolean;
  }>;
}): HoldsMeta {
  const failed = input.sources.filter((s) => s.failed).map((s) => s.source);
  const truncated = input.sources.some(
    (s) => !s.failed && s.count !== null && s.count > s.returned,
  );
  const largest = Math.max(
    0,
    ...input.sources.map((s) => (s.failed ? 0 : (s.count ?? s.returned))),
  );
  return {
    total: Math.max(input.shown, largest),
    shown: input.shown,
    truncated,
    failed,
    contextErrors: input.contextErrors ?? [],
  };
}

const STEP_CHUNK = 40;
const PROPERTY_RPC_CHUNK = 200;

function chunked<T>(items: readonly T[], size = STEP_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}
const HOLD_LIMIT = 200;

/**
 * Server loader. Every query is org-scoped explicitly (RLS also applies).
 * Holds come from properties.needs_human_attention plus pending Jev
 * decisions and pending disposition reviews, each joined to its most recent
 * run. Steps are fetched for exactly the runs that are rendered.
 */
export async function loadMessagesV2Data(
  supabase: LooseSupabase,
  orgId: string,
  nowMs: number = Date.now(),
): Promise<MessagesV2Data> {
  // Exact totals come from separate head-only queries, never the capped lists.
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const headCount = (table: string, filter: (q: any) => any) =>
    filter(
      supabase
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId),
    );
  const [
    [windowRes, flaggedRes, decisionRes, reviewRes, configRes, thresholdRes],
    [flaggedCount, decisionCount, reviewCount],
  ] = await Promise.all([
    Promise.all([
      supabase
        .from("pipeline_runs")
        .select("*")
        .eq("org_id", orgId)
        .order("started_at", { ascending: false })
        .limit(MAX_RUNS),
      // Oldest first BEFORE the limit, so truncation drops the newest holds,
      // never the ones that have waited longest. id is the deterministic tiebreak.
      supabase
        .from("properties")
        .select(
          "id, last_ai_escalation_at, last_ai_escalation_reason, updated_at",
        )
        .eq("org_id", orgId)
        .eq("needs_human_attention", true)
        .order("last_ai_escalation_at", { ascending: true, nullsFirst: true })
        .order("id", { ascending: true })
        .limit(HOLD_LIMIT),
      supabase
        .from("jev_lead_decisions")
        .select(
          "property_id, conversation_id, source_inbound_message_id, created_at",
        )
        .eq("org_id", orgId)
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .order("source_inbound_message_id", { ascending: true })
        .limit(HOLD_LIMIT),
      supabase
        .from("ai_disposition_reviews")
        .select(
          "property_id, conversation_id, source_inbound_message_id, disposition, created_at",
        )
        .eq("org_id", orgId)
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .order("source_inbound_message_id", { ascending: true })
        .limit(HOLD_LIMIT),
      supabase
        .from("ai_responder_configs")
        .select("classifier_provider, classifier_mode")
        .eq("org_id", orgId)
        .eq("active", true)
        .limit(1),
      supabase
        .from("jev_outcome_thresholds")
        .select("outcome, min_confidence, automation_enabled")
        .eq("org_id", orgId)
        .order("outcome", { ascending: true }),
    ]),
    Promise.all([
      headCount("properties", (q) => q.eq("needs_human_attention", true)),
      headCount("jev_lead_decisions", (q) => q.eq("status", "pending")),
      headCount("ai_disposition_reviews", (q) => q.eq("status", "pending")),
    ]),
  ]);

  // automation_enabled may not exist yet: retry without it (treated as enabled).
  let thresholdRows = thresholdRes;
  if (thresholdRes.error) {
    thresholdRows = await supabase
      .from("jev_outcome_thresholds")
      .select("outcome, min_confidence")
      .eq("org_id", orgId)
      .order("outcome", { ascending: true });
  }

  const windowRuns = (windowRes.data ?? []) as PipelineRun[];
  // A failed query is reported as failed, never silently as "no holds".
  const properties = (
    flaggedRes.error ? [] : (flaggedRes.data ?? [])
  ) as HoldPropertyRow[];
  const decisions = (
    decisionRes.error ? [] : (decisionRes.data ?? [])
  ) as HoldDecisionRow[];
  const reviews = (
    reviewRes.error ? [] : (reviewRes.data ?? [])
  ) as HoldReviewRow[];

  // Runs for the hold cards: by property and by source inbound message, so a
  // hold older than the feed window still gets its context.
  const propertyIds = [
    ...new Set([
      ...properties.map((p) => p.id),
      ...decisions.map((d) => d.property_id),
      ...reviews.map((r) => r.property_id),
    ]),
  ];
  const messageIds = [
    ...new Set(
      [...decisions, ...reviews].map((r) => r.source_inbound_message_id),
    ),
  ];
  const contextErrors: string[] = [];
  // Latest run PER property via the RLS-respecting RPC, 200 ids per call.
  const byProperty: PipelineRun[] = [];
  const propertyResults = await Promise.all(
    chunked(propertyIds, PROPERTY_RPC_CHUNK).map((ids) =>
      supabase.rpc("pipeline_runs_latest_for_properties", {
        p_org_id: orgId,
        p_property_ids: ids,
      }),
    ),
  );
  for (const res of propertyResults) {
    if (res.error) {
      if (!contextErrors.includes("run lookup by property"))
        contextErrors.push("run lookup by property");
    } else byProperty.push(...((res.data ?? []) as PipelineRun[]));
  }
  const byMessage: PipelineRun[] = [];
  const messageResults = await Promise.all(
    chunked(messageIds).map((ids) =>
      supabase
        .from("pipeline_runs")
        .select("*")
        .eq("org_id", orgId)
        .in("inbound_message_id", ids),
    ),
  );
  for (const res of messageResults) {
    if (res.error) {
      if (!contextErrors.includes("run lookup by message"))
        contextErrors.push("run lookup by message");
    } else byMessage.push(...((res.data ?? []) as PipelineRun[]));
  }
  const pool = new Map<string, PipelineRun>();
  for (const run of [...windowRuns, ...byProperty, ...byMessage]) {
    pool.set(run.id, run);
  }

  const openHolds = deriveOpenHolds({
    properties,
    decisions,
    reviews,
    runs: [...pool.values()],
  });

  // Steps only for the runs that render: the feed window and the hold runs.
  const loadedRunIds = [
    ...new Set([
      ...windowRuns.map((r) => r.id),
      ...openHolds.flatMap((h) => (h.run ? [h.run.id] : [])),
    ]),
  ];
  const stepChunks: string[][] = [];
  for (let i = 0; i < loadedRunIds.length; i += STEP_CHUNK)
    stepChunks.push(loadedRunIds.slice(i, i + STEP_CHUNK));
  const stepResults = await Promise.all(
    stepChunks.map((ids) =>
      supabase
        .from("pipeline_run_steps")
        .select("*")
        .eq("org_id", orgId)
        .in("run_id", ids)
        .order("seq", { ascending: true }),
    ),
  );
  if (stepResults.some((res) => res.error)) contextErrors.push("step lookup");
  const stepsByRun = groupStepsByRun(
    stepResults.flatMap(
      (res) => (res.error ? [] : (res.data ?? [])) as PipelineRunStep[],
    ),
  );
  const withSteps = (run: PipelineRun): RunWithSteps => ({
    ...run,
    steps: stepsByRun.get(run.id) ?? [],
  });

  // Pending Claude reply drafts (ai_reply_drafts) for hold runs. The table may
  // not exist yet; any failure just means no "draft held" marker. Body is not read.
  const holdRunIds = [
    ...new Set(openHolds.flatMap((h) => (h.run ? [h.run.id] : []))),
  ];
  const draftRunIds = new Set<string>();
  for (const ids of chunked(holdRunIds)) {
    try {
      const draftRes = await supabase
        .from("ai_reply_drafts")
        .select("run_id")
        .eq("org_id", orgId)
        .eq("status", "pending")
        .in("run_id", ids);
      if (!draftRes?.error) {
        for (const row of (draftRes?.data ?? []) as Array<{ run_id: string }>)
          draftRunIds.add(row.run_id);
      }
      // An error here (e.g. table not created yet) only means no marker.
    } catch {
      // table absent: no marker
    }
  }

  const shown = openHolds.length;
  const holdsMeta = buildHoldsMeta({
    shown,
    contextErrors,
    sources: [
      {
        source: "needs_attention",
        count: flaggedCount.error ? null : (flaggedCount.count ?? null),
        returned: properties.length,
        failed: !!flaggedRes.error,
      },
      {
        source: "jev_decision",
        count: decisionCount.error ? null : (decisionCount.count ?? null),
        returned: decisions.length,
        failed: !!decisionRes.error,
      },
      {
        source: "disposition_review",
        count: reviewCount.error ? null : (reviewCount.count ?? null),
        returned: reviews.length,
        failed: !!reviewRes.error,
      },
    ],
  });

  const configRow = (configRes.data ?? [])[0] ?? null;
  return {
    runs: windowRuns.map(withSteps),
    holds: openHolds.map((h) => ({
      ...h,
      run: h.run ? withSteps(h.run) : null,
      draft_held: h.run ? draftRunIds.has(h.run.id) : false,
    })),
    holdsMeta,
    badges: buildModeBadges(
      configRow,
      (thresholdRows.data ?? []) as ThresholdRow[],
    ),
    nowMs,
  };
}
