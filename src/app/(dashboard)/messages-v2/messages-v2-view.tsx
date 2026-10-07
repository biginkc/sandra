"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

import { useThrottledRefresh } from "../messages/use-throttled-refresh";
import { appendStep, upsertRun } from "./feed-state";
import { HoldsRail } from "./holds-rail";
import { loadRunLabels } from "./labels";
import {
  computeHeaderStats,
  describeCoverage,
  formatHoldsTotal,
  formatModeBadge,
  type LooseSupabase,
} from "./queries";
import { RunCard } from "./run-card";
import { ScorecardCard } from "./scorecard-card";
import type { ScorecardRow } from "./scorecard";
import type {
  HoldsMeta,
  ModeBadge,
  OpenHold,
  PipelineCoverage,
  PipelineRun,
  PipelineRunStep,
  RunLabel,
  RunWithSteps,
} from "./types";

export type MessagesV2ViewProps = {
  orgId: string;
  /** Owners may open the legacy /messages inbox; Acquisitions callers may not. */
  isOwner?: boolean;
  runs: RunWithSteps[];
  /** Open holds from the server (flag / pending decision / pending review). */
  holds: OpenHold<RunWithSteps>[];
  /** Inbound vs run counts for the last hour; null when unavailable. */
  coverage?: PipelineCoverage | null;
  /** The coverage query failed: show a degraded indicator, not nothing. */
  coverageUnavailable?: boolean;
  holdsMeta?: HoldsMeta;
  /** Feed window query failed (reason text, already prefixed "Feed unavailable"). */
  feedError?: string | null;
  /** Step lookup failed: cards may lack steps. */
  stepsUnavailable?: boolean;
  /** Mode badge queries failed (reason text). */
  badgesError?: string | null;
  badges: ModeBadge[];
  /** Scorecard rows (7d) loaded on the server; null means the card loads them itself. */
  scorecardRows?: ScorecardRow[] | null;
  /** Server-resolved display labels, as [runId, label] pairs. */
  labels: Array<[string, RunLabel]>;
  nowMs: number;
};

const LEGEND = [
  ["◀", "inbound"],
  ["●", "judgment"],
  ["✔", "applied"],
  ["▶", "sent"],
  ["■", "gate"],
  ["○", "shadow"],
] as const;

const BADGE_CLASS: Record<ModeBadge["mode"], string> = {
  HELD: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  AUTO: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  SHADOW: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  LEGACY: "bg-secondary text-muted-foreground",
  UNKNOWN: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
};

export function MessagesV2View(props: MessagesV2ViewProps) {
  const { badges, orgId, isOwner = false } = props;
  const requestRefresh = useThrottledRefresh();

  const [lastInitial, setLastInitial] = useState(props);
  const [runs, setRunsState] = useState(props.runs);
  // Mirror of `runs` so realtime handlers can read-then-write synchronously
  // (the unknown-run check must not depend on when React runs an updater).
  const runsRef = useRef(props.runs);
  const setRuns = useCallback((next: RunWithSteps[]) => {
    runsRef.current = next;
    setRunsState(next);
  }, []);
  const [labels, setLabels] = useState(() => new Map(props.labels));
  const [nowMs, setNowMs] = useState(props.nowMs);
  const [live, setLive] = useState(false);
  if (lastInitial.runs !== props.runs || lastInitial.holds !== props.holds) {
    setLastInitial(props);
    // Render-phase sync must not write the ref (react-hooks/refs); the
    // effect below mirrors committed state into it.
    setRunsState(props.runs);
    setLabels((curr) => new Map([...curr, ...props.labels]));
  }
  useEffect(() => {
    runsRef.current = runs;
  }, [runs]);

  // Holds are server-derived from the flag / pending rows; a hold's run card
  // is swapped for the live copy when the feed has it (streamed steps).
  const holds = useMemo(() => {
    const live = new Map(runs.map((r) => [r.id, r]));
    return props.holds.map((h) =>
      h.run ? { ...h, run: live.get(h.run.id) ?? h.run } : h,
    );
  }, [runs, props.holds]);

  const stats = useMemo(
    () => computeHeaderStats(runs, nowMs, holds.length),
    [runs, holds, nowMs],
  );
  const meta = props.holdsMeta;
  const holdsLabel = meta
    ? formatHoldsTotal(meta, stats.openHolds)
    : `${stats.openHolds} holds`;
  const coverage = describeCoverage(props.coverage, props.coverageUnavailable);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // properties (the needs_human_attention flag) is not in the realtime
  // publication, so a cleared flag is only seen via the published tables below
  // or this slow poll. The refresh is throttled and skipped while hidden.
  useEffect(() => {
    const id = window.setInterval(requestRefresh, 60_000);
    return () => window.clearInterval(id);
  }, [requestRefresh]);

  // Fetch display labels for runs that arrive over realtime.
  const requested = useRef(new Set<string>(props.labels.map(([id]) => id)));
  useEffect(() => {
    const missing = runs.filter((r) => !requested.current.has(r.id));
    if (missing.length === 0) return;
    for (const r of missing) requested.current.add(r.id);
    let cancelled = false;
    loadRunLabels(createClient() as unknown as LooseSupabase, missing)
      .then((fetched) => {
        if (!cancelled) setLabels((curr) => new Map([...curr, ...fetched]));
      })
      .catch(() => {
        for (const r of missing) requested.current.delete(r.id);
      });
    return () => {
      cancelled = true;
    };
  }, [runs]);

  useEffect(() => {
    const supabase = createClient();
    const orgFilter = `org_id=eq.${orgId}`;
    let mounted = true;
    let wasDown = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? null;
      if (token) supabase.realtime.setAuth(token);
      if (!mounted) return;

      channel = supabase
        .channel("messages-v2:feed")
        .on(
          // pipeline_* tables are not in the generated Database type yet.
          "postgres_changes" as never,
          {
            event: "INSERT",
            schema: "public",
            table: "pipeline_runs",
            filter: orgFilter,
          } as never,
          ((payload: { new: PipelineRun }) => {
            setRuns(upsertRun(runsRef.current, payload.new));
          }) as never,
        )
        .on(
          "postgres_changes" as never,
          {
            event: "UPDATE",
            schema: "public",
            table: "pipeline_runs",
            filter: orgFilter,
          } as never,
          ((payload: { new: PipelineRun }) => {
            setRuns(upsertRun(runsRef.current, payload.new));
          }) as never,
        )
        .on(
          "postgres_changes" as never,
          {
            event: "INSERT",
            schema: "public",
            table: "pipeline_run_steps",
            filter: orgFilter,
          } as never,
          ((payload: { new: PipelineRunStep }) => {
            const res = appendStep(runsRef.current, payload.new);
            setRuns(res.runs);
            if (res.unknownRun) requestRefresh();
          }) as never,
        )
        // Hold sources: a pending/resolved disposition review or a new lead
        // event (human action) means the hold set may have changed.
        .on(
          "postgres_changes" as never,
          {
            event: "*",
            schema: "public",
            table: "ai_disposition_reviews",
            filter: orgFilter,
          } as never,
          (() => requestRefresh()) as never,
        )
        .on(
          "postgres_changes" as never,
          {
            event: "INSERT",
            schema: "public",
            table: "lead_events",
            filter: orgFilter,
          } as never,
          (() => requestRefresh()) as never,
        )
        .subscribe(((status: string) => {
          if (!mounted) return;
          if (status === "SUBSCRIBED") {
            setLive(true);
            // After a drop, rows may have been missed: backfill from the server.
            if (wasDown) requestRefresh();
            wasDown = false;
          } else if (
            status === "CHANNEL_ERROR" ||
            status === "TIMED_OUT" ||
            status === "CLOSED"
          ) {
            setLive(false);
            wasDown = true;
          }
        }) as never);
    })();

    return () => {
      mounted = false;
      if (channel) supabase.removeChannel(channel);
    };
  }, [requestRefresh, setRuns, orgId]);

  // Keep the newest card in view when the operator is already at the top.
  const feedRef = useRef<HTMLDivElement>(null);
  const newestId = runs[0]?.id;
  useEffect(() => {
    const el = feedRef.current;
    if (el && el.scrollTop < 48 && typeof el.scrollTo === "function")
      el.scrollTo({ top: 0 });
  }, [newestId]);

  return (
    <div className="flex flex-col gap-4" data-testid="messages-v2">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold">Messages v2</h1>
        <div className="flex flex-wrap gap-1.5" aria-label="Classifier modes">
          {props.badgesError && (
            <span
              role="alert"
              data-testid="badges-unavailable"
              className="text-xs text-red-700 dark:text-red-300"
            >
              {props.badgesError}
            </span>
          )}
          {badges.map((b) => (
            <Badge
              key={b.label}
              variant="outline"
              className={cn("gap-1", BADGE_CLASS[b.mode])}
            >
              {b.label} [{formatModeBadge(b)}]
            </Badge>
          ))}
        </div>
        <p
          className="ml-auto text-sm text-muted-foreground"
          data-testid="header-status"
        >
          <span
            aria-hidden
            className={live ? "text-emerald-600" : "text-muted-foreground"}
          >
            ●
          </span>{" "}
          {live ? "live" : "connecting"} · {stats.runsLastHour} runs last hour ·{" "}
          {holdsLabel}
          {coverage && (
            <>
              {" "}
              ·{" "}
              <span
                data-testid="coverage"
                data-gap={coverage.gap ? "true" : "false"}
                data-degraded={coverage.degraded ? "true" : "false"}
                className={cn(
                  coverage.gap && "font-medium text-red-600 dark:text-red-400",
                )}
                title={
                  coverage.gap
                    ? "Fewer runs than inbound texts: the pipeline seam may be failing silently"
                    : undefined
                }
              >
                {coverage.text}
              </span>
            </>
          )}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section aria-label="Live feed" className="flex min-w-0 flex-col gap-3">
          <h2 className="text-sm font-semibold">Live feed</h2>
          <div
            ref={feedRef}
            className="flex max-h-[calc(100vh-14rem)] flex-col gap-3 overflow-y-auto pr-1"
          >
            {props.feedError && (
              <p
                role="alert"
                data-testid="feed-unavailable"
                className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
              >
                {props.feedError}
              </p>
            )}
            {props.stepsUnavailable && (
              <p
                role="alert"
                data-testid="steps-unavailable"
                className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
              >
                Step details unavailable — run cards may be missing steps.
              </p>
            )}
            {runs.length === 0 ? (
              props.feedError ? null : (
                <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                  No pipeline runs yet. New inbound texts will appear here as
                  they are processed.
                </p>
              )
            ) : (
              runs.map((run) => (
                <RunCard
                  key={run.id}
                  run={run}
                  label={labels.get(run.id)}
                  isOwner={isOwner}
                />
              ))
            )}
          </div>
        </section>
        <HoldsRail holds={holds} labels={labels} nowMs={nowMs} meta={meta} />
      </div>

      <ScorecardCard orgId={orgId} initialRows={props.scorecardRows ?? null} />

      <ul
        aria-label="Legend"
        className="flex flex-wrap gap-x-4 gap-y-1 border-t pt-3 text-xs text-muted-foreground"
      >
        {LEGEND.map(([glyph, text]) => (
          <li key={text}>
            <span aria-hidden>{glyph}</span> {text}
          </li>
        ))}
      </ul>
    </div>
  );
}
