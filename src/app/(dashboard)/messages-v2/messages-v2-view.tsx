"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

import { useThrottledRefresh } from "../messages/use-throttled-refresh";
import { appendStep, upsertRun } from "./feed-state";
import { HoldsRail } from "./holds-rail";
import { loadRunLabels } from "./labels";
import { computeHeaderStats, deriveOpenHolds, type LooseSupabase } from "./queries";
import { RunCard } from "./run-card";
import type {
  ModeBadge,
  PipelineRun,
  PipelineRunStep,
  RunLabel,
  RunWithSteps,
} from "./types";

export type MessagesV2ViewProps = {
  runs: RunWithSteps[];
  /** Open holds from the server (may include runs older than the feed window). */
  holds: RunWithSteps[];
  badges: ModeBadge[];
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
  AUTO: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  SHADOW: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  LEGACY: "bg-secondary text-muted-foreground",
};

export function MessagesV2View(props: MessagesV2ViewProps) {
  const { badges } = props;
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
    setRuns(props.runs);
    setLabels((curr) => new Map([...curr, ...props.labels]));
  }

  // Server holds older than the feed window have no live card to update, so
  // they ride along as static rows.
  const holds = useMemo(() => {
    const inFeed = new Set(runs.map((r) => r.id));
    const extras = props.holds.filter((h) => !inFeed.has(h.id));
    return deriveOpenHolds([...runs, ...extras]);
  }, [runs, props.holds]);

  const stats = useMemo(
    () => ({ runsLastHour: computeHeaderStats(runs, nowMs).runsLastHour, openHolds: holds.length }),
    [runs, holds, nowMs],
  );

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

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
          { event: "INSERT", schema: "public", table: "pipeline_runs" } as never,
          ((payload: { new: PipelineRun }) => {
            setRuns(upsertRun(runsRef.current, payload.new));
          }) as never,
        )
        .on(
          "postgres_changes" as never,
          { event: "UPDATE", schema: "public", table: "pipeline_runs" } as never,
          ((payload: { new: PipelineRun }) => {
            setRuns(upsertRun(runsRef.current, payload.new));
          }) as never,
        )
        .on(
          "postgres_changes" as never,
          { event: "INSERT", schema: "public", table: "pipeline_run_steps" } as never,
          ((payload: { new: PipelineRunStep }) => {
            const res = appendStep(runsRef.current, payload.new);
            setRuns(res.runs);
            if (res.unknownRun) requestRefresh();
          }) as never,
        )
        .subscribe(((status: string) => {
          if (!mounted) return;
          if (status === "SUBSCRIBED") {
            setLive(true);
            // After a drop, rows may have been missed: backfill from the server.
            if (wasDown) requestRefresh();
            wasDown = false;
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            setLive(false);
            wasDown = true;
          }
        }) as never);
    })();

    return () => {
      mounted = false;
      if (channel) supabase.removeChannel(channel);
    };
  }, [requestRefresh, setRuns]);

  // Keep the newest card in view when the operator is already at the top.
  const feedRef = useRef<HTMLDivElement>(null);
  const newestId = runs[0]?.id;
  useEffect(() => {
    const el = feedRef.current;
    if (el && el.scrollTop < 48 && typeof el.scrollTo === "function") el.scrollTo({ top: 0 });
  }, [newestId]);

  return (
    <div className="flex flex-col gap-4" data-testid="messages-v2">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold">Messages v2</h1>
        <div className="flex flex-wrap gap-1.5" aria-label="Classifier modes">
          {badges.map((b) => (
            <Badge key={b.label} variant="outline" className={cn("gap-1", BADGE_CLASS[b.mode])}>
              {b.label} [{b.mode}]
            </Badge>
          ))}
        </div>
        <p className="ml-auto text-sm text-muted-foreground" data-testid="header-status">
          <span aria-hidden className={live ? "text-emerald-600" : "text-muted-foreground"}>●</span>{" "}
          {live ? "live" : "connecting"} · {stats.runsLastHour} runs last hour · {stats.openHolds} holds
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section aria-label="Live feed" className="flex min-w-0 flex-col gap-3">
          <h2 className="text-sm font-semibold">Live feed</h2>
          <div ref={feedRef} className="flex max-h-[calc(100vh-14rem)] flex-col gap-3 overflow-y-auto pr-1">
            {runs.length === 0 ? (
              <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                No pipeline runs yet. New inbound texts will appear here as they are processed.
              </p>
            ) : (
              runs.map((run) => <RunCard key={run.id} run={run} label={labels.get(run.id)} />)
            )}
          </div>
        </section>
        <HoldsRail holds={holds} labels={labels} nowMs={nowMs} />
      </div>

      <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
        {LEGEND.map(([glyph, text]) => (
          <li key={text}>
            <span aria-hidden>{glyph}</span> {text}
          </li>
        ))}
      </ul>
    </div>
  );
}
