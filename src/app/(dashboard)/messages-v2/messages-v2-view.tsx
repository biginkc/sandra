"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Result } from "@/lib/errors/result";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

import { useThrottledRefresh } from "../messages/use-throttled-refresh";
import { appendStep, upsertRun } from "./feed-state";
import { asWaitingSnapshot, type CompactSnapshot } from "./snapshot-codec";
import type { HoldActionsApi, LoadOlderHolds, RevalidateHolds, WaitingSnapshot } from "./hold-action-types";
import type { NurtureAutoDripState } from "./nurture-auto-drip-switch";
import { loadRunLabels } from "./labels";
import { compareInstants, describeCoverage, MAX_RUNS, type LooseSupabase } from "./queries";
import type { ReplyGeneration } from "./reply-generation";
import type { SetReplyGenerationAction } from "./reply-generation-toggle";
import { RulesPanel } from "./rules-panel";
import type { UndoControls } from "./run-card";
import type { ScorecardRow } from "./scorecard";
import { TapeCard } from "./tape-card";
import { chicagoDayKey, loadRunThreads, previousDayKey, type RunCursor, type RunThread } from "./tape-data";
import type { TapeDayPage } from "./tape-actions";
import { WaitingColumn } from "./waiting-column";
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
  /** Owner-only nurture auto-drip switch; absent = not shown. */
  nurtureAutoDrip?: NurtureAutoDripState | null;
  /** The org's "AI drafts" setting; null/absent hides the control. */
  replyGeneration?: { configId: string; replyGeneration: ReplyGeneration } | null;
  setReplyGeneration?: SetReplyGenerationAction;
  /** Undo a Jev-applied action (server actions); both omitted = no Undo button. */
  undoJevAction?: (undoId: string) => Promise<{ ok: true; data: unknown } | { ok: false; error: { message: string } }>;
  findJevUndo?: (inboundMessageId: string) => Promise<string | null>;
  /** Replay org only: newest replay batch id, shown to owners. */
  replayBatchId?: string | null;
  runs: RunWithSteps[];
  /** Open holds from the server (flag / pending decision / pending review). */
  holds: OpenHold<RunWithSteps>[];
  /** Inbound vs run counts for the last hour; null when unavailable. */
  coverage?: PipelineCoverage | null;
  /** The coverage query failed: show a degraded indicator, not nothing. */
  coverageUnavailable?: boolean;
  holdsMeta?: HoldsMeta;
  /** All waiting holds (DNC-locked excluded); `holds` is the newest-activity slice of them. */
  /** The frozen waiting-list order the column pages through (see hold-list.ts buildSnapshot). */
  holdsSnapshot?: WaitingSnapshot | CompactSnapshot;
  /** First-page snapshot ids the server dropped in its final check. */
  holdsMissing?: string[];
  /** 60-second / tab-focus re-check of rendered cards (properties is not in realtime). */
  revalidateHolds?: RevalidateHolds;
  /** [runId, reason] from the snapshot (the reason each card shows), for the tape. */
  flagReasons?: Array<[string, string | null]>;
  /** Runs whose thread text failed to load on the server: fetched again in the browser. */
  threadFailedRunIds?: string[];
  /** The hold lookup failed (reason): say so, never "nothing is waiting". */
  holdsError?: string | null;
  /** Waiting texts hidden because their property (and so its DNC lock) could not be determined. */
  holdsUnverified?: number;
  /** "Show older": the next slice of the same latest-activity order. */
  loadOlderHolds?: LoadOlderHolds;
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
  /** Server-resolved thread text (our last text, Sandra's reply), as [runId, thread] pairs. */
  threads?: Array<[string, RunThread]>;
  /** "Show yesterday's tape": loads the 24 hours before the given instant. */
  loadTapeDay?: (input: { day: string; before?: RunCursor | null }) => Promise<Result<TapeDayPage>>;
  nowMs: number;
  /** Hold actions (server actions). Absent = the buttons render disabled. */
  actions?: HoldActionsApi;
};

/** One header line from the 7-day scorecard: how many texts, and how often Sandra's own calls were confirmed. */
export function weekSummary(rows: ScorecardRow[] | null | undefined): { texts: number; rightPct: number | null } | null {
  if (!rows) return null;
  const texts = rows.reduce((n, r) => n + r.runs, 0);
  const settled = rows.reduce((n, r) => n + r.auto_settled, 0);
  const agreed = rows.reduce((n, r) => n + r.auto_agreed, 0);
  return { texts, rightPct: settled > 0 ? Math.round((agreed / settled) * 100) : null };
}

/** "Sandra is on" unless every rule is still watch-only. */
function sandraIsOn(badges: ModeBadge[]): boolean {
  return badges.length === 0 || badges.some((b) => b.mode === "AUTO" || b.mode === "HELD");
}

// Fixed zone (America/Chicago) so the server render and the browser agree on which day a card belongs to.
const dayKey = chicagoDayKey;

function dayLabel(ms: number, nowMs: number): string {
  const key = dayKey(ms);
  if (key === dayKey(nowMs)) return "Today";
  if (key === previousDayKey(dayKey(nowMs))) return "Yesterday";
  return new Date(ms).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "America/Chicago" });
}

export function MessagesV2View(props: MessagesV2ViewProps) {
  const { badges, orgId, isOwner = false } = props;
  const router = useRouter();
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
  const [threads, setThreads] = useState(() => new Map(props.threads ?? []));
  // Earlier days loaded by "Show yesterday's tape"; independent of the live window.
  const [earlier, setEarlier] = useState<RunWithSteps[]>([]);
  const earlierRef = useRef<RunWithSteps[]>([]);
  useEffect(() => {
    earlierRef.current = earlier;
  }, [earlier]);
  const [cursor, setCursor] = useState<{ day: string; before: RunCursor | null } | null>(null);
  const [earlierBusy, setEarlierBusy] = useState(false);
  const [earlierNote, setEarlierNote] = useState<string | null>(null);
  const { undoJevAction, findJevUndo } = props;
  const undoControls = useMemo<UndoControls | undefined>(
    () =>
      undoJevAction && findJevUndo
        ? {
            find: findJevUndo,
            undo: async (id) => {
              const r = await undoJevAction(id);
              return r.ok ? { ok: true } : { ok: false, message: r.error.message };
            },
          }
        : undefined,
    [undoJevAction, findJevUndo],
  );
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

  // Waiting cards keep exactly the snapshot data the server ordered them by (run, time, reason). Realtime never
  // swaps it: a card whose property has newer activity only gets an "Updated" mark until the list is refreshed.
  const holds = props.holds;
  const updatedHoldIds = useMemo(() => {
    const out = new Set<string>();
    for (const h of props.holds) {
      if (!h.property_id) continue;
      const shown = h.run;
      const newer = runs.some(
        (r) =>
          r.property_id === h.property_id &&
          (!shown || r.id !== shown.id
            ? !shown || compareInstants(r.started_at, shown.started_at) > 0
            : r.steps.length > shown.steps.length),
      );
      if (newer) out.add(h.id);
    }
    return out;
  }, [runs, props.holds]);

  const meta = props.holdsMeta;
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
    // Not cancelled when `runs` changes again: the results are keyed by run id, so a late answer is still right.
    loadRunLabels(createClient() as unknown as LooseSupabase, missing)
      .then((fetched) => setLabels((curr) => new Map([...curr, ...fetched])))
      .catch(() => {
        for (const r of missing) requested.current.delete(r.id);
      });
  }, [runs]);

  // Fetch thread text (our last text, Sandra's reply) for runs that arrive over realtime, earlier days, and again
  // when a run gains its sent reply. A run whose text failed to load is NOT marked fetched: it is retried.
  const threadKey = (r: Pick<PipelineRun, "id" | "outbound_message_id">) => `${r.id}:${r.outbound_message_id ?? ""}`;
  const requestedThreads = useRef(
    new Set<string>(
      props.runs
        .filter((r) => (props.threads ?? []).some(([id]) => id === r.id) && !(props.threadFailedRunIds ?? []).includes(r.id))
        .map(threadKey),
    ),
  );
  const [threadFailures, setThreadFailures] = useState(() => (props.threadFailedRunIds ?? []).length);
  const [threadRetry, setThreadRetry] = useState(0);
  useEffect(() => {
    const pool = [...runs, ...earlier];
    const missing = pool.filter((r) => !requestedThreads.current.has(threadKey(r)));
    if (missing.length === 0) return;
    for (const r of missing) requestedThreads.current.add(threadKey(r));
    const retryLater = (ids: readonly string[]) => {
      for (const r of missing) if (ids.includes(r.id)) requestedThreads.current.delete(threadKey(r));
      setThreadFailures(ids.length);
      if (ids.length) window.setTimeout(() => setThreadRetry((n) => n + 1), 10_000);
    };
    // Versioned: each result is committed only if the run is still at the version it was fetched for (an older fetch
    // resolving late can never overwrite a newer sent reply).
    const versionAtRequest = new Map(missing.map((r) => [r.id, threadKey(r)]));
    loadRunThreads(createClient() as unknown as LooseSupabase, missing)
      .then(({ threads: fetched, failedRunIds }) => {
        const current = new Map([...earlierRef.current, ...runsRef.current].map((r) => [r.id, threadKey(r)]));
        const fresh = [...fetched].filter(([id]) => current.get(id) === versionAtRequest.get(id));
        setThreads((curr) => new Map([...curr, ...fresh]));
        retryLater(failedRunIds);
      })
      .catch(() => retryLater(missing.map((r) => r.id)));
    // threadRetry re-runs this after a failure.
  }, [runs, earlier, threadRetry]);

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

  const allRuns = useMemo(() => {
    const seen = new Set(runs.map((r) => r.id));
    return [...runs, ...earlier.filter((r) => !seen.has(r.id))].sort(
      (x, y) => compareInstants(y.started_at, x.started_at) || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0),
    );
  }, [runs, earlier]);

  const showEarlier = async () => {
    if (!props.loadTapeDay || earlierBusy) return;
    // Start at the Chicago day of the oldest run on screen, only the part older than that run; step back a whole
    // calendar day at a time, skipping empty days (up to a week) so one click always shows something or says why not.
    const oldestRun = allRuns[allRuns.length - 1];
    let next: { day: string; before: RunCursor | null } =
      cursor ??
      (oldestRun
        ? { day: chicagoDayKey(Date.parse(oldestRun.started_at)), before: { at: oldestRun.started_at, id: oldestRun.id } }
        : { day: chicagoDayKey(nowMs), before: null });
    setEarlierBusy(true);
    setEarlierNote(null);
    try {
      for (let attempt = 0; attempt < 7; attempt += 1) {
        const res = await props.loadTapeDay(next);
        if (!res.ok) {
          setEarlierNote(res.error.message);
          setCursor(next);
          return;
        }
        const got = res.data.runs;
        setEarlier((curr) => [...curr, ...got]);
        setLabels((curr) => new Map([...curr, ...res.data.labels]));
        setDayFlagReasons((curr) => [...curr, ...(res.data.flagReasons ?? [])]);
        // Same versioned commit as the browser fetch: a delayed day response never overwrites a newer reply.
        const dayVersion = new Map(got.map((r) => [r.id, threadKey(r)]));
        const current = new Map([...earlierRef.current, ...runsRef.current].map((r) => [r.id, threadKey(r)]));
        const freshDay = res.data.threads.filter(([id]) => (current.get(id) ?? dayVersion.get(id)) === dayVersion.get(id));
        setThreads((curr) => new Map([...curr, ...freshDay]));
        const failedIds = res.data.failedRunIds ?? [];
        for (const r of got) if (!failedIds.includes(r.id) && freshDay.some(([id]) => id === r.id)) requestedThreads.current.add(threadKey(r));
        // A full page means this day was cut off: continue the same day from the oldest run returned.
        // The page is ordered (started_at, id) descending, so its last row is the cursor: runs that share a timestamp are not skipped.
        const last = got[got.length - 1];
        next =
          got.length >= MAX_RUNS && last
            ? { day: next.day, before: { at: last.started_at, id: last.id } }
            : { day: previousDayKey(next.day), before: null };
        if (got.length > 0) {
          setCursor(next);
          return;
        }
      }
      setCursor(next);
      setEarlierNote("No texts came in during the week before that.");
    } catch {
      setEarlierNote("The earlier tape could not be loaded.");
    } finally {
      setEarlierBusy(false);
    }
  };

  // A hold's flag reason applies only to the run the hold is showing, so old runs are never relabelled by a later flag.
  // Built on the server from the COMPLETE eligible waiting list, so a hold on any "Show older" page, and runs on
  // earlier days, read the same effective reason on the tape and on the card.
  // Snapshot reasons win (the tape must match the cards); earlier days add reasons for runs the snapshot does not cover.
  const [dayFlagReasons, setDayFlagReasons] = useState<Array<[string, string]>>([]);
  // Snapshot entries (including pinned nulls) are applied last, so day data can never override them.
  const flagByRun = useMemo(
    () => new Map<string, string | null>([...dayFlagReasons, ...(props.flagReasons ?? [])]),
    [dayFlagReasons, props.flagReasons],
  );
  const holdsSnapshot = useMemo(() => asWaitingSnapshot(props.holdsSnapshot), [props.holdsSnapshot]);
  const snapshotRuns = useMemo(() => new Set((props.flagReasons ?? []).map(([runId]) => runId)), [props.flagReasons]);

  const week = weekSummary(props.scorecardRows);
  const on = sandraIsOn(badges);
  const statusText = props.badgesError
    ? "Sandra's status couldn't be checked"
    : badges.length === 0
      ? "Rules not loaded"
      : on
      ? "Sandra is on"
      : "Sandra is watching, not acting yet";

  // Day dividers: "Today", "Yesterday", then the date.
  const tapeItems: Array<{ kind: "day"; label: string } | { kind: "run"; run: RunWithSteps }> = [];
  let lastDay = "";
  for (const run of allRuns) {
    const label = dayLabel(Date.parse(run.started_at), nowMs);
    if (label !== lastDay) {
      tapeItems.push({ kind: "day", label });
      lastDay = label;
    }
    tapeItems.push({ kind: "run", run });
  }

  return (
    <div className="flex flex-col gap-5" data-testid="messages-v2">
      <header className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div>
          <h1 className="text-2xl font-semibold">Messages v2</h1>
          <p className="text-[13px] text-muted-foreground">Sandra is answering seller texts. You are watching her work.</p>
        </div>
        {isOwner && props.replayBatchId && (
          <Badge variant="outline" data-testid="replay-batch-badge" className="bg-amber-100 text-amber-800">
            Replay batch {props.replayBatchId}
          </Badge>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <p
            data-testid="header-status"
            className="inline-flex items-center gap-2 rounded-full border bg-card px-3.5 py-2 text-[13px]"
          >
            <span
              aria-hidden
              title={live ? "Live" : "Connecting"}
              className={cn("size-2 rounded-full", live && on && badges.length > 0 && !props.badgesError ? "bg-emerald-600" : "bg-muted-foreground")}
            />
            <span className="font-medium">{statusText}</span>
            {week && (
              <span className="text-muted-foreground">
                · {week.texts.toLocaleString("en-US")} texts this week
                {week.rightPct !== null ? ` · right ${week.rightPct}% of the time` : ""}
              </span>
            )}
          </p>
          <RulesPanel
            orgId={orgId}
            isOwner={isOwner}
            badges={badges}
            badgesError={props.badgesError}
            nurtureAutoDrip={props.nurtureAutoDrip}
            replyGeneration={props.replyGeneration}
            setReplyGeneration={props.setReplyGeneration}
          />
        </div>
        {coverage && (coverage.gap || coverage.degraded) && (
          <p
            data-testid="coverage"
            data-gap={coverage.gap ? "true" : "false"}
            data-degraded={coverage.degraded ? "true" : "false"}
            className="basis-full text-xs font-medium text-red-600"
            title="Fewer runs than inbound texts: some seller texts may not have reached Sandra"
          >
            {coverage.text}
          </p>
        )}
      </header>

      <div className="flex flex-wrap items-start gap-6">
        <section aria-label="Sandra's tape" className="flex min-w-0 flex-[999_1_560px] flex-col gap-3">
          <div className="flex items-baseline gap-3">
            <h2 className="text-base font-semibold">Sandra&apos;s tape</h2>
            <span className="text-[13px] text-muted-foreground">Newest on top</span>
          </div>
          {props.feedError && (
            <p role="alert" data-testid="feed-unavailable" className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800">
              {props.feedError}
            </p>
          )}
          {props.stepsUnavailable && (
            <p role="alert" data-testid="steps-unavailable" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
              Some details are unavailable, so a few cards may read as unfinished.
            </p>
          )}
          {allRuns.length === 0 ? (
            props.feedError ? null : (
              <p className="rounded-2xl border border-dashed p-4 text-sm text-muted-foreground">
                No seller texts yet. New ones will appear here as Sandra reads them.
              </p>
            )
          ) : (
            tapeItems.map((item) =>
              item.kind === "day" ? (
                <h3
                  key={`day-${item.label}`}
                  data-testid="tape-day"
                  className="pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
                >
                  {item.label}
                </h3>
              ) : (
                <TapeCard
                  key={item.run.id}
                  run={item.run}
                  label={labels.get(item.run.id)}
                  thread={threads.get(item.run.id)}
                  flagReason={flagByRun.get(item.run.id)}
                  flagPinned={snapshotRuns.has(item.run.id)}
                  undoControls={undoControls}
                />
              ),
            )
          )}
          {threadFailures > 0 && (
            <p data-testid="threads-retrying" className="text-center text-xs text-amber-700">
              Some texts couldn&apos;t load. Retrying…
            </p>
          )}
          {earlierNote && (
            <p data-testid="earlier-note" className="text-center text-xs text-muted-foreground">
              {earlierNote}
            </p>
          )}
          {props.loadTapeDay && (
            <div className="flex justify-center">
              <Button type="button" variant="ghost" size="sm" data-testid="show-earlier" disabled={earlierBusy} onClick={showEarlier}>
                {earlierBusy ? "Loading…" : cursor === null ? "Show yesterday's tape" : "Show the day before"}
              </Button>
            </div>
          )}
        </section>

        <div className="flex min-w-0 max-w-[420px] flex-[1_1_340px] flex-col">
          <WaitingColumn
            holds={holds}
            labels={labels}
            meta={meta}
            snapshot={holdsSnapshot}
            initialMissing={props.holdsMissing}
            revalidate={props.revalidateHolds}
            error={props.holdsError}
            unverified={props.holdsUnverified}
            loadOlder={props.loadOlderHolds}
            refreshKey={props.holds}
            updatedIds={updatedHoldIds}
            actions={props.actions}
            onReload={() => router.refresh()}
          />
        </div>
      </div>
    </div>
  );
}
