import type {
  HeaderStats,
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
      a = { sources: new Set(), times: [], conversations: new Set(), messages: new Set(), notes: [] };
      byProperty.set(id, a);
    }
    return a;
  };

  for (const p of input.properties) {
    const a = acc(p.id);
    a.sources.add("needs_attention");
    const t = p.last_ai_escalation_at ?? p.updated_at;
    if (t) a.times.push(t);
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

  const order: HoldSource[] = ["needs_attention", "jev_decision", "disposition_review"];
  const holds: OpenHold<T>[] = [];
  for (const [propertyId, a] of byProperty) {
    let run: T | null = null;
    for (const candidate of input.runs) {
      const matches =
        candidate.property_id === propertyId ||
        a.messages.has(candidate.inbound_message_id) ||
        (candidate.conversation_id !== null && a.conversations.has(candidate.conversation_id));
      if (matches && (!run || Date.parse(candidate.started_at) > Date.parse(run.started_at))) {
        run = candidate;
      }
    }
    const since =
      [...a.times].sort((x, y) => Date.parse(x) - Date.parse(y))[0] ?? run?.started_at ?? new Date(0).toISOString();
    const sources = order.filter((s) => a.sources.has(s));
    const labels = sources.map((s) => SOURCE_LABEL[s]).join(" · ");
    holds.push({
      id: propertyId,
      property_id: propertyId,
      conversation_id: [...a.conversations][0] ?? run?.conversation_id ?? null,
      sources,
      since,
      reason: a.notes.length > 0 ? `${labels} (${[...new Set(a.notes)].join(", ")})` : labels,
      run,
    });
  }
  return holds.sort((x, y) => Date.parse(x.since) - Date.parse(y.since));
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
): { text: string; gap: boolean } | null {
  if (!coverage) return null;
  return {
    text: `${coverage.inboundMessages} inbound / ${coverage.runs} runs (last hour)`,
    gap: coverage.runs < coverage.inboundMessages,
  };
}

export function buildModeBadges(
  config: { classifier_provider: string; classifier_mode: string } | null,
  thresholds: ReadonlyArray<{ outcome: string }>,
): ModeBadge[] {
  const mode: ModeBadge["mode"] =
    config?.classifier_provider === "jev"
      ? config.classifier_mode === "automatic"
        ? "AUTO"
        : "SHADOW"
      : "LEGACY";
  return thresholds.map((t) => ({ label: t.outcome, mode }));
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
export type LooseSupabase = { from(table: string): any };
/* eslint-enable @typescript-eslint/no-explicit-any */

export type MessagesV2Data = {
  runs: RunWithSteps[];
  holds: OpenHold<RunWithSteps>[];
  badges: ModeBadge[];
  nowMs: number;
};

const STEP_CHUNK = 40;
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
  const [windowRes, flaggedRes, decisionRes, reviewRes, configRes, thresholdRes] = await Promise.all([
    supabase
      .from("pipeline_runs")
      .select("*")
      .eq("org_id", orgId)
      .order("started_at", { ascending: false })
      .limit(MAX_RUNS),
    supabase
      .from("properties")
      .select("id, last_ai_escalation_at, last_ai_escalation_reason, updated_at")
      .eq("org_id", orgId)
      .eq("needs_human_attention", true)
      .limit(HOLD_LIMIT),
    supabase
      .from("jev_lead_decisions")
      .select("property_id, conversation_id, source_inbound_message_id, created_at")
      .eq("org_id", orgId)
      .eq("status", "pending")
      .limit(HOLD_LIMIT),
    supabase
      .from("ai_disposition_reviews")
      .select("property_id, conversation_id, source_inbound_message_id, disposition, created_at")
      .eq("org_id", orgId)
      .eq("status", "pending")
      .limit(HOLD_LIMIT),
    supabase
      .from("ai_responder_configs")
      .select("classifier_provider, classifier_mode")
      .eq("org_id", orgId)
      .eq("active", true)
      .limit(1),
    supabase
      .from("jev_outcome_thresholds")
      .select("outcome")
      .eq("org_id", orgId)
      .order("outcome", { ascending: true }),
  ]);

  const windowRuns = (windowRes.data ?? []) as PipelineRun[];
  const properties = (flaggedRes.data ?? []) as HoldPropertyRow[];
  const decisions = (decisionRes.data ?? []) as HoldDecisionRow[];
  const reviews = (reviewRes.data ?? []) as HoldReviewRow[];

  // Runs for the hold cards: by property and by source inbound message, so a
  // hold older than the feed window still gets its context.
  const propertyIds = [
    ...new Set([...properties.map((p) => p.id), ...decisions.map((d) => d.property_id), ...reviews.map((r) => r.property_id)]),
  ];
  const messageIds = [...new Set([...decisions, ...reviews].map((r) => r.source_inbound_message_id))];
  const [byPropertyRes, byMessageRes] = await Promise.all([
    propertyIds.length === 0
      ? { data: [] }
      : supabase
          .from("pipeline_runs")
          .select("*")
          .eq("org_id", orgId)
          .in("property_id", propertyIds)
          .order("started_at", { ascending: false })
          .limit(HOLD_LIMIT * 3),
    messageIds.length === 0
      ? { data: [] }
      : supabase
          .from("pipeline_runs")
          .select("*")
          .eq("org_id", orgId)
          .in("inbound_message_id", messageIds),
  ]);
  const pool = new Map<string, PipelineRun>();
  for (const run of [
    ...windowRuns,
    ...((byPropertyRes.data ?? []) as PipelineRun[]),
    ...((byMessageRes.data ?? []) as PipelineRun[]),
  ]) {
    pool.set(run.id, run);
  }

  const openHolds = deriveOpenHolds({ properties, decisions, reviews, runs: [...pool.values()] });

  // Steps only for the runs that render: the feed window and the hold runs.
  const loadedRunIds = [
    ...new Set([...windowRuns.map((r) => r.id), ...openHolds.flatMap((h) => (h.run ? [h.run.id] : []))]),
  ];
  const stepChunks: string[][] = [];
  for (let i = 0; i < loadedRunIds.length; i += STEP_CHUNK) stepChunks.push(loadedRunIds.slice(i, i + STEP_CHUNK));
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
  const stepsByRun = groupStepsByRun(
    stepResults.flatMap((res) => (res.data ?? []) as PipelineRunStep[]),
  );
  const withSteps = (run: PipelineRun): RunWithSteps => ({
    ...run,
    steps: stepsByRun.get(run.id) ?? [],
  });

  const configRow = (configRes.data ?? [])[0] ?? null;
  return {
    runs: windowRuns.map(withSteps),
    holds: openHolds.map((h) => ({ ...h, run: h.run ? withSteps(h.run) : null })),
    badges: buildModeBadges(configRow, (thresholdRes.data ?? []) as Array<{ outcome: string }>),
    nowMs,
  };
}
