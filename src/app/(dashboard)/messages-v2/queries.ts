import type {
  DeadLetterInfo,
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
export type HoldDraftRow = {
  id: string;
  property_id: string | null;
  conversation_id: string | null;
  inbound_message_id: string | null;
  run_id: string | null;
  created_at: string;
  /** Only present when the loader was asked for draft bodies (the page, never the alert cron). */
  body?: string;
  edited_body?: string | null;
  edited_at?: string | null;
};

/**
 * Orders two database timestamp strings by instant to the microsecond (Date
 * alone stops at the millisecond, and two rows can share one).
 */
export function compareInstants(a: string, b: string): number {
  const ms = Date.parse(a) - Date.parse(b);
  if (ms !== 0 && Number.isFinite(ms)) return ms;
  const micros = (v: string) => Number((/\.(\d+)/.exec(v)?.[1] ?? "").padEnd(6, "0").slice(0, 6) || 0);
  return micros(a) - micros(b);
}

/** Distinct-hold counting stops here; above it the total is "2,000+ (incomplete)". */
export const HOLDS_COUNT_CAP = 2000;

const SOURCE_LABEL: Record<HoldSource, string> = {
  needs_attention: "Needs attention",
  jev_decision: "Jev decision pending",
  disposition_review: "Disposition review pending",
  pending_draft: "Claude draft held",
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
  /** Pending ai_reply_drafts rows: a hold source of their own. Body is never read. */
  drafts?: readonly HoldDraftRow[];
  runs: readonly T[];
}): OpenHold<T>[] {
  type Acc = {
    sources: Set<HoldSource>;
    times: string[];
    conversations: Set<string>;
    messages: Set<string>;
    notes: string[];
    flagReason?: string | null;
    flagAt?: string | null;
    /** created_at of every pending decision / review / draft (raw strings, never re-parsed). */
    rowTimes: string[];
    noProperty?: boolean;
    draft?: HoldDraftRow;
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
        rowTimes: [],
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
    a.flagAt = p.last_ai_escalation_at;
    a.flagReason = p.last_ai_escalation_reason;
    if (p.last_ai_escalation_reason) {
      a.notes.push(p.last_ai_escalation_reason);
      a.flagReason = p.last_ai_escalation_reason;
    }
  }
  for (const d of input.decisions) {
    const a = acc(d.property_id);
    a.sources.add("jev_decision");
    a.times.push(d.created_at);
    a.rowTimes.push(d.created_at);
    a.conversations.add(d.conversation_id);
    a.messages.add(d.source_inbound_message_id);
  }
  for (const r of input.reviews) {
    const a = acc(r.property_id);
    a.sources.add("disposition_review");
    a.times.push(r.created_at);
    a.rowTimes.push(r.created_at);
    a.conversations.add(r.conversation_id);
    a.messages.add(r.source_inbound_message_id);
    a.notes.push(r.disposition);
  }

  const drafts = [...(input.drafts ?? [])].sort(
    (x, y) =>
      Date.parse(x.created_at) - Date.parse(y.created_at) ||
      x.id.localeCompare(y.id),
  );
  for (const d of drafts) {
    const ref =
      input.runs.find((r) => d.run_id !== null && r.id === d.run_id) ??
      input.runs.find(
        (r) =>
          d.inbound_message_id !== null &&
          r.inbound_message_id === d.inbound_message_id,
      );
    const propertyId = d.property_id ?? ref?.property_id ?? null;
    const a = acc(propertyId ?? `draft:${d.id}`);
    if (propertyId === null) a.noProperty = true;
    a.sources.add("pending_draft");
    a.times.push(d.created_at);
    a.rowTimes.push(d.created_at);
    // Sorted oldest first above, so the last assignment is the newest draft.
    a.draft = d;
    const conversation = d.conversation_id ?? ref?.conversation_id ?? null;
    if (conversation) a.conversations.add(conversation);
    if (d.inbound_message_id) a.messages.add(d.inbound_message_id);
  }

  const order: HoldSource[] = [
    "needs_attention",
    "jev_decision",
    "disposition_review",
    "pending_draft",
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
    const labels =
      sources
        .filter((s) => s !== "pending_draft")
        .map((s) => SOURCE_LABEL[s])
        .join(" · ") || "Reply draft pending";
    holds.push({
      id: propertyId,
      property_id: a.noProperty ? null : propertyId,
      draft_held: sources.includes("pending_draft"),
      ...(a.draft
        ? {
            draft: {
              id: a.draft.id,
              inbound_message_id: a.draft.inbound_message_id,
              ...(a.draft.body !== undefined ? { body: a.draft.body } : {}),
              ...(a.draft.edited_body !== undefined ? { edited_body: a.draft.edited_body } : {}),
              ...(a.draft.edited_at !== undefined ? { edited_at: a.draft.edited_at } : {}),
            },
          }
        : {}),
      seen: {
        // Chronological max by instant; the raw string is what goes back to the database.
        through: [...a.rowTimes].sort((x, y) => compareInstants(y, x))[0] ?? null,
        flagReason: a.sources.has("needs_attention") ? (a.flagReason ?? null) : null,
        flagAt: a.sources.has("needs_attention") ? (a.flagAt ?? null) : null,
      },
      message_ids: [...a.messages],
      conversation_id: [...a.conversations][0] ?? run?.conversation_id ?? null,
      sources,
      since,
      ...(a.flagReason ? { flag_reason: a.flagReason } : {}),
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
  /** Missing / null is shown as UNKNOWN, never assumed enabled. */
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
    // Never guess AUTO: a missing/null flag means we cannot tell if it is held.
    if (t.automation_enabled !== true)
      return { label: t.outcome, mode: "UNKNOWN" as const };
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
  /** Feed window query failed: render "Feed unavailable — <reason>", not an empty feed. */
  feedError: string | null;
  /** Step lookup failed: run cards are missing their steps. */
  stepsUnavailable: boolean;
  /** Config/threshold query failed: mode badges cannot be trusted. */
  badgesError: string | null;
  nowMs: number;
};

/**
 * Truncation/failure summary for the hold queries. `total` counts DISTINCT held
 * properties (holds dedupe by property), computed from each source's id list.
 * Above HOLDS_COUNT_CAP it is reported as capped (incomplete); if a count query
 * failed it is unavailable. Never below what is shown.
 */
export function buildHoldsMeta(input: {
  shown: number;
  contextErrors?: string[];
  deadLetterUnavailable?: boolean;
  sources: ReadonlyArray<{
    source: HoldSource;
    /** Held-property keys for the source; null when the count query failed. */
    ids: readonly string[] | null;
    failed: boolean;
    /** The id query returned more rows than the cap (fetch limit reached). */
    limited?: boolean;
  }>;
}): HoldsMeta {
  const failed = input.sources.filter((s) => s.failed).map((s) => s.source);
  const live = input.sources.filter((s) => !s.failed);
  // De-duplicate to distinct properties BEFORE applying the cap.
  const distinct = new Set(live.flatMap((s) => s.ids ?? []));
  const sourceLimited = live.some(
    (s) => s.limited || (s.ids?.length ?? 0) > HOLDS_COUNT_CAP,
  );
  const totalState: HoldsMeta["totalState"] =
    failed.length > 0 || live.some((s) => s.ids === null)
      ? "unavailable"
      : distinct.size > HOLDS_COUNT_CAP
        ? "capped"
        : sourceLimited
          ? "incomplete"
          : "exact";
  const total =
    totalState === "exact" || totalState === "incomplete"
      ? Math.max(input.shown, distinct.size)
      : totalState === "capped"
        ? Math.max(input.shown, HOLDS_COUNT_CAP)
        : input.shown;
  return {
    total,
    shown: input.shown,
    truncated:
      totalState === "capped" ||
      totalState === "incomplete" ||
      (totalState === "exact" && total > input.shown),
    totalState,
    failed,
    contextErrors: input.contextErrors ?? [],
    ...(input.deadLetterUnavailable ? { deadLetterUnavailable: true } : {}),
  };
}

/** Header wording for the hold total: never silent about incomplete counts. */
export function formatHoldsTotal(meta: HoldsMeta, openCount: number): string {
  if (meta.failed.some((f) => f !== "pending_draft"))
    return "holds unavailable";
  if (meta.failed.length > 0 || meta.totalState === "unavailable")
    return "holds count unavailable";
  if (meta.totalState === "incomplete")
    return `${meta.total.toLocaleString("en-US")}+ holds (incomplete)`;
  if (meta.totalState === "capped")
    return `${HOLDS_COUNT_CAP.toLocaleString("en-US")}+ holds (incomplete)`;
  return meta.truncated
    ? `${meta.total} holds (${meta.shown} shown)`
    : `${openCount} holds`;
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
  opts: {
    /**
     * Select the pending drafts' text so the hold card can show what Send
     * would send. The page asks; the alert cron never does (alert payloads
     * carry no message text).
     */
    includeDraftBody?: boolean;
  } = {},
): Promise<MessagesV2Data> {
  // Distinct-hold totals come from separate id-only queries (one per source),
  // capped at HOLDS_COUNT_CAP+1 rows and de-duplicated by property client-side.
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const idQuery = (table: string, columns: string, filter: (q: any) => any) =>
    filter(supabase.from(table).select(columns).eq("org_id", orgId)).limit(
      HOLDS_COUNT_CAP + 1,
    );
  const [
    [
      windowRes,
      flaggedRes,
      decisionRes,
      reviewRes,
      draftRes,
      configRes,
      thresholdRes,
    ],
    [flaggedIds, decisionIds, reviewIds, draftIds],
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
      // Pending Claude reply drafts are a hold source of their own. The body
      // is selected only when the caller needs to show it (hold actions).
      supabase
        .from("ai_reply_drafts")
        .select(
          opts.includeDraftBody
            ? "id, property_id, conversation_id, inbound_message_id, run_id, created_at, body, edited_body, edited_at"
            : "id, property_id, conversation_id, inbound_message_id, run_id, created_at",
        )
        .eq("org_id", orgId)
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
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
      idQuery("properties", "id", (q) => q.eq("needs_human_attention", true)),
      idQuery("jev_lead_decisions", "property_id", (q) =>
        q.eq("status", "pending"),
      ),
      idQuery("ai_disposition_reviews", "property_id", (q) =>
        q.eq("status", "pending"),
      ),
      idQuery("ai_reply_drafts", "id, property_id", (q) =>
        q.eq("status", "pending"),
      ),
    ]),
  ]);

  const errText = (e: unknown): string =>
    (e && typeof e === "object" && "message" in e
      ? String((e as { message: unknown }).message)
      : null) || "query failed";
  const feedError = windowRes.error
    ? `Feed unavailable — ${errText(windowRes.error)}`
    : null;
  const badgesError =
    configRes.error || thresholdRes.error
      ? `Mode badges unavailable — ${errText(configRes.error ?? thresholdRes.error)}`
      : null;

  const windowRuns = (
    windowRes.error ? [] : (windowRes.data ?? [])
  ) as PipelineRun[];
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
  const drafts = (
    draftRes.error ? [] : (draftRes.data ?? [])
  ) as HoldDraftRow[];

  // Runs for the hold cards: by property and by source inbound message, so a
  // hold older than the feed window still gets its context.
  const propertyIds = [
    ...new Set([
      ...properties.map((p) => p.id),
      ...decisions.map((d) => d.property_id),
      ...reviews.map((r) => r.property_id),
      ...drafts.flatMap((d) => (d.property_id ? [d.property_id] : [])),
    ]),
  ];
  const messageIds = [
    ...new Set([
      ...[...decisions, ...reviews].map((r) => r.source_inbound_message_id),
      ...drafts.flatMap((d) =>
        d.inbound_message_id ? [d.inbound_message_id] : [],
      ),
    ]),
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
    drafts,
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

  const keysOf = (
    res: { error?: unknown; data?: unknown },
    key: (row: Record<string, string | null>) => string | null,
  ): string[] | null =>
    res.error
      ? null
      : ((res.data ?? []) as Array<Record<string, string | null>>).flatMap(
          (row) => {
            const k = key(row);
            return k ? [k] : [];
          },
        );

  const isLimited = (res: { data?: unknown; error?: unknown }): boolean =>
    !res.error && Array.isArray(res.data) && res.data.length > HOLDS_COUNT_CAP;

  // Dead letters: ids and reason only (never the saved reply text). A missing table is
  // treated as "none"; any other error is surfaced as unavailable.
  const runIds = new Set<string>();
  const deadMessageIds = new Set<string>();
  for (const h of openHolds) {
    if (h.run) {
      runIds.add(h.run.id);
      deadMessageIds.add(h.run.inbound_message_id);
    }
    for (const m of h.message_ids ?? []) deadMessageIds.add(m);
  }
  const deadRunSet = new Set<string>();
  const deadMsgSet = new Set<string>();
  // sent_late = provider accepted the reply after the timeout (seller got it).
  const dlRows: Array<{
    run_id: string | null;
    inbound_message_id: string | null;
    late: boolean;
  }> = [];
  let deadLetterUnavailable = false;
  const deadQueries = [
    ...chunked([...runIds]).map((ids) => ["run_id", ids] as const),
    ...chunked([...deadMessageIds]).map(
      (ids) => ["inbound_message_id", ids] as const,
    ),
  ];
  const deadResults = await Promise.all(
    deadQueries.map(([col, ids]) =>
      supabase
        .from("ai_reply_dead_letters")
        .select("id, run_id, inbound_message_id, reason")
        .eq("org_id", orgId)
        .in(col, ids),
    ),
  );
  for (const res of deadResults) {
    if (res.error) {
      const e = res.error as { code?: string; message?: string };
      const missing =
        e.code === "42P01" ||
        e.code === "PGRST205" ||
        /does not exist|could not find the table/i.test(e.message ?? "");
      if (!missing) deadLetterUnavailable = true;
      continue;
    }
    for (const row of (res.data ?? []) as Array<{
      run_id: string | null;
      inbound_message_id: string | null;
      reason?: string | null;
    }>) {
      if (row.run_id) deadRunSet.add(row.run_id);
      if (row.inbound_message_id) deadMsgSet.add(row.inbound_message_id);
      dlRows.push({
        run_id: row.run_id,
        inbound_message_id: row.inbound_message_id,
        late: row.reason === "sent_late",
      });
    }
  }
  const matches = (
    h: OpenHold<PipelineRun>,
    runSet: Set<string>,
    msgSet: Set<string>,
  ): boolean =>
    (h.run
      ? runSet.has(h.run.id) || msgSet.has(h.run.inbound_message_id)
      : false) || (h.message_ids ?? []).some((m) => msgSet.has(m));
  const isDead = (h: OpenHold<PipelineRun>): boolean =>
    matches(h, deadRunSet, deadMsgSet);
  // Merge rows that share a run or inbound id into one dead-letter per
  // inbound/run (the original row + its sent_late follow-up are one). A group
  // is late if any of its rows is sent_late.
  const groups: DeadLetterInfo[] = [];
  for (const row of dlRows) {
    const hits = groups.filter(
      (g) =>
        (row.run_id && g.run_id === row.run_id) ||
        (row.inbound_message_id &&
          g.inbound_message_id === row.inbound_message_id),
    );
    const [first, ...rest] = hits;
    const target =
      first ??
      ({
        inbound_message_id: null,
        run_id: null,
        late: false,
      } as DeadLetterInfo);
    if (!first) groups.push(target);
    for (const g of rest) {
      target.run_id ??= g.run_id;
      target.inbound_message_id ??= g.inbound_message_id;
      target.late = target.late || g.late;
      groups.splice(groups.indexOf(g), 1);
    }
    target.run_id ??= row.run_id;
    target.inbound_message_id ??= row.inbound_message_id;
    target.late = target.late || row.late;
  }
  // Latest alert delivery per held property, so a failed or skipped alert is
  // visible on the card (PLAN 4.11: failures are surfaced, not swallowed).
  const alertByProperty = new Map<string, NonNullable<OpenHold["alert"]>>();
  const alertAtByProperty = new Map<string, string>();
  const alertPropertyIds = [
    ...new Set(openHolds.flatMap((h) => (h.property_id ? [h.property_id] : []))),
  ];
  const alertResults = await Promise.all(
    chunked(alertPropertyIds, PROPERTY_RPC_CHUNK).map((ids) =>
      supabase
        .from("hold_alert_deliveries")
        .select("property_id, status, last_error, created_at")
        .eq("org_id", orgId)
        .in("property_id", ids)
        .not("hold_key", "like", "%:closed:%")
        .order("created_at", { ascending: false })
        .limit(ids.length * 20),
    ),
  );
  for (const res of alertResults) {
    if (res.error) {
      if (!contextErrors.includes("alert status")) contextErrors.push("alert status");
      continue;
    }
    for (const row of (res.data ?? []) as Array<{
      property_id: string | null;
      status: NonNullable<OpenHold["alert"]>["status"];
      last_error: string | null;
      created_at: string;
    }>) {
      if (!row.property_id) continue;
      const prev = alertByProperty.get(row.property_id);
      const prevAt = prev ? alertAtByProperty.get(row.property_id)! : null;
      if (prevAt === null || compareInstants(row.created_at, prevAt) > 0) {
        alertByProperty.set(row.property_id, { status: row.status, reason: row.last_error });
        alertAtByProperty.set(row.property_id, row.created_at);
      }
    }
  }
  const deadLettersFor = (h: OpenHold<PipelineRun>): DeadLetterInfo[] =>
    groups
      .filter(
        (g) =>
          (g.run_id !== null && h.run?.id === g.run_id) ||
          (g.inbound_message_id !== null &&
            (h.run?.inbound_message_id === g.inbound_message_id ||
              (h.message_ids ?? []).includes(g.inbound_message_id))),
      )
      .map((g) => ({ ...g }));

  const holdsMeta = buildHoldsMeta({
    shown: openHolds.length,
    deadLetterUnavailable,
    contextErrors,
    sources: [
      {
        source: "needs_attention",
        ids: keysOf(flaggedIds, (r) => r.id),
        failed: !!flaggedRes.error,
        limited: isLimited(flaggedIds),
      },
      {
        source: "jev_decision",
        ids: keysOf(decisionIds, (r) => r.property_id),
        failed: !!decisionRes.error,
        limited: isLimited(decisionIds),
      },
      {
        source: "disposition_review",
        ids: keysOf(reviewIds, (r) => r.property_id),
        failed: !!reviewRes.error,
        limited: isLimited(reviewIds),
      },
      {
        source: "pending_draft",
        ids: keysOf(draftIds, (r) => r.property_id ?? `draft:${r.id}`),
        failed: !!draftRes.error,
        limited: isLimited(draftIds),
      },
    ],
  });

  const configRow = (configRes.error ? [] : (configRes.data ?? []))[0] ?? null;
  return {
    runs: windowRuns.map(withSteps),
    holds: openHolds.map((h) => {
      const dls = deadLettersFor(h);
      return {
        ...h,
        ...(isDead(h) ? { dead_letter: true } : {}),
        ...(dls.some((d) => d.late) ? { dead_letter_late: true } : {}),
        ...(dls.length ? { dead_letters: dls } : {}),
        ...(h.property_id && alertByProperty.has(h.property_id)
          ? { alert: alertByProperty.get(h.property_id) }
          : {}),
        run: h.run ? withSteps(h.run) : null,
      };
    }),
    holdsMeta,
    feedError,
    stepsUnavailable: contextErrors.includes("step lookup"),
    badgesError,
    badges: badgesError
      ? []
      : buildModeBadges(configRow, (thresholdRes.data ?? []) as ThresholdRow[]),
    nowMs,
  };
}
