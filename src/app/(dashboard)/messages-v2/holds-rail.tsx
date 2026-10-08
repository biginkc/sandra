"use client";

import { format } from "date-fns/format";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import type { HoldActionsApi, LoadBacklog } from "./hold-action-types";
import {
  DisabledHoldActions,
  effectiveDraftBody,
  HoldActionControls,
} from "./hold-action-controls";
import { holdReason } from "./step-format";
import type {
  HoldsMeta,
  HoldsSplit,
  HoldSource,
  OpenHold,
  RunLabel,
  RunWithSteps,
} from "./types";

const HOUR = 60 * 60 * 1000;

export type AgeTone = "neutral" | "amber" | "red";

export function ageTone(ageMs: number): AgeTone {
  if (ageMs > 4 * HOUR) return "red";
  if (ageMs > HOUR) return "amber";
  return "neutral";
}

function formatAge(ageMs: number): string {
  const mins = Math.max(0, Math.floor(ageMs / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

const TONE_CLASS: Record<AgeTone, string> = {
  neutral: "bg-secondary text-muted-foreground",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  red: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
};

/** Reason codes only for skips; a failure shows just "failed" (the stored error can be provider text). */
function alertText(alert: NonNullable<OpenHold["alert"]>): string {
  return alert.status === "skipped" && alert.reason
    ? `alert: skipped (${alert.reason})`
    : `alert: ${alert.status}`;
}

export function HoldCard({
  hold,
  label,
  nowMs,
  actions,
  onReload,
}: {
  hold: OpenHold<RunWithSteps>;
  label: RunLabel | undefined;
  nowMs: number;
  /** Re-fetch page data (a card the server found out of date). */
  onReload?: () => void;
  /** Server actions for the five hold actions; absent = shown disabled. */
  actions?: HoldActionsApi;
}) {
  const run = hold.run;
  const age = hold.since ? Math.max(0, nowMs - Date.parse(hold.since)) : null;
  const tone = age === null ? "neutral" : ageTone(age);
  const why = run ? holdReason(run.steps, run.reason) : null;
  // Already delivered (late) and nothing else needs a human: muted, not actionable.
  // Derive per-inbound dead-letter state; fall back to the booleans when no list.
  const dls = hold.dead_letters;
  const hasLate = dls ? dls.some((d) => d.late) : !!hold.dead_letter_late;
  const hasOpenDead = dls
    ? dls.some((d) => !d.late)
    : !!hold.dead_letter && !hold.dead_letter_late;
  const informational =
    hold.flag_reason === "send_timeout_then_sent" &&
    hold.sources.every((s) => s === "needs_attention") &&
    !hasOpenDead;
  return (
    <article
      data-testid="hold-card"
      {...(informational ? { "data-informational": "true" } : {})}
      className={cn(
        "rounded-xl bg-card p-4 text-sm ring-1 ring-foreground/10",
        informational && "opacity-70",
      )}
    >
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {hold.since ? (
          <time
            suppressHydrationWarning
            dateTime={hold.since}
            className="text-xs tabular-nums text-muted-foreground"
          >
            {format(new Date(hold.since), "h:mm a")}
          </time>
        ) : (
          <span className="text-xs text-muted-foreground">time unknown</span>
        )}
        <span className="font-semibold">{label?.name ?? "Unknown sender"}</span>
        {label?.address && (
          <span className="text-muted-foreground">· {label.address}</span>
        )}
        <span
          data-testid="hold-age"
          data-tone={tone}
          className={cn(
            "ml-auto rounded-full px-2 text-xs tabular-nums",
            TONE_CLASS[tone],
          )}
        >
          {age === null ? "age unknown" : formatAge(age)}
        </span>
      </header>
      {run?.inbound_preview && (
        <p className="mt-2 flex gap-2">
          <span aria-hidden className="text-muted-foreground">
            ◀
          </span>
          <span>{run.inbound_preview}</span>
        </p>
      )}
      <p className="mt-2 flex gap-2">
        <span aria-hidden className="text-sky-600">
          ●
        </span>
        <span>
          {hold.reason}
          {why ? ` · ${why}` : ""}
        </span>
      </p>
      {hold.draft_held && (
        <p data-testid="draft-held" className="mt-2 flex gap-2">
          <span aria-hidden className="text-violet-600">
            ●
          </span>
          <span>Claude draft held</span>
        </p>
      )}
      {effectiveDraftBody(hold) !== null && (
        <p
          data-testid="draft-text"
          className="mt-1 whitespace-pre-wrap rounded-lg bg-secondary/60 p-2"
        >
          {effectiveDraftBody(hold)}
        </p>
      )}
      {hold.alert && (
        <p
          data-testid="hold-alert"
          data-status={hold.alert.status}
          className={cn(
            "mt-2 text-xs",
            hold.alert.status === "failed"
              ? "text-red-700 dark:text-red-300"
              : hold.alert.status === "skipped"
                ? "text-amber-700 dark:text-amber-300"
                : "text-muted-foreground",
          )}
        >
          {alertText(hold.alert)}
        </p>
      )}
      {informational && (
        <p
          data-testid="hold-informational"
          className="mt-2 text-xs text-muted-foreground"
        >
          Informational — accepted by provider late
        </p>
      )}
      {hasLate && (
        <p
          data-testid="dead-letter-late"
          className="mt-2 flex gap-2 text-muted-foreground"
        >
          <span aria-hidden>●</span>
          <span>reply accepted by provider late — do not re-send</span>
        </p>
      )}
      {hasOpenDead && (
        <p data-testid="dead-letter" className="mt-2 flex gap-2">
          <span aria-hidden className="text-amber-600">
            ●
          </span>
          <span>reply text saved for review</span>
        </p>
      )}
      {!informational &&
        (actions ? (
          <HoldActionControls
            // A changed draft or hold remounts the controls, so no stale edit text or status survives a reload.
            key={`${hold.draft?.id ?? ""}|${hold.draft?.edited_at ?? ""}|${hold.draft?.body ?? ""}|${hold.seen?.through ?? ""}|${hold.seen?.flagAt ?? ""}`}
            hold={hold}
            actions={actions}
            onReload={onReload}
          />
        ) : (
          <DisabledHoldActions title="Actions unavailable" />
        ))}
    </article>
  );
}

const SOURCE_NAME: Record<HoldSource, string> = {
  needs_attention: "needs-attention",
  jev_decision: "Jev decision",
  disposition_review: "disposition review",
  pending_draft: "reply draft",
};

const BACKLOG_PAGE_SIZE = 200;
const fmt = (n: number) => n.toLocaleString("en-US");

type BacklogState = {
  holds: OpenHold<RunWithSteps>[];
  labels: Map<string, RunLabel>;
  total: number;
  hasMore: boolean;
  nextOffset: number;
  /** The server data these cards were loaded against; a newer one makes them stale. */
  forKey: unknown;
  error: string | null;
};

/**
 * Collapsed "Backlog" disclosure: holds flagged before Messages v2 went live.
 * Cards load only when it is opened (oldest first, 200 per page), and reload
 * when the server data refreshes so a dismissed hold does not linger.
 */
function BacklogSection({
  total,
  loadBacklog,
  refreshKey,
  nowMs,
  actions,
  onReload,
}: {
  total: number;
  loadBacklog?: LoadBacklog;
  refreshKey: unknown;
  nowMs: number;
  actions?: HoldActionsApi;
  onReload?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<BacklogState | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const loadedRef = useRef(0);
  const loadedCount = state?.nextOffset ?? 0;
  useEffect(() => {
    loadedRef.current = loadedCount;
  }, [loadedCount]);

  useEffect(() => {
    if (!expanded || !loadBacklog) return;
    let cancelled = false;
    // First open loads one page; a server refresh reloads what was already shown.
    const limit = Math.max(BACKLOG_PAGE_SIZE, loadedRef.current);
    loadBacklog({ offset: 0, limit }).then(
      (res) => {
        if (cancelled) return;
        setState(
          res.ok
            ? {
                holds: res.data.holds,
                labels: new Map(res.data.labels),
                total: res.data.backlogTotal,
                hasMore: res.data.hasMore,
                nextOffset: res.data.nextOffset,
                forKey: refreshKey,
                error: null,
              }
            : {
                holds: [],
                labels: new Map(),
                total,
                hasMore: false,
                nextOffset: 0,
                forKey: refreshKey,
                error: res.error.message,
              },
        );
      },
      () => {
        if (!cancelled)
          setState({
            holds: [],
            labels: new Map(),
            total,
            hasMore: false,
            nextOffset: 0,
            forKey: refreshKey,
            error: "Backlog holds could not be loaded.",
          });
      },
    );
    return () => {
      cancelled = true;
    };
    // `total` only labels an error state; reloading on it would refetch needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, loadBacklog, refreshKey]);

  const loadMore = () => {
    if (!loadBacklog || !state || moreBusy) return;
    setMoreBusy(true);
    loadBacklog({ offset: state.nextOffset, limit: BACKLOG_PAGE_SIZE })
      .then((res) => {
        setState((curr) => {
          if (!curr) return curr;
          if (!res.ok) return { ...curr, error: res.error.message };
          const seen = new Set(curr.holds.map((h) => h.id));
          return {
            ...curr,
            holds: [...curr.holds, ...res.data.holds.filter((h) => !seen.has(h.id))],
            labels: new Map([...curr.labels, ...res.data.labels]),
            total: res.data.backlogTotal,
            hasMore: res.data.hasMore,
            nextOffset: res.data.nextOffset,
            error: null,
          };
        });
      })
      .catch(() =>
        setState((curr) =>
          curr ? { ...curr, error: "Backlog holds could not be loaded." } : curr,
        ),
      )
      .finally(() => setMoreBusy(false));
  };

  const loading = expanded && (state === null || state.forKey !== refreshKey);
  return (
    <section aria-label="Backlog holds" data-testid="holds-backlog" className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="holds-backlog-list"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-sm font-semibold"
      >
        <span aria-hidden className="text-muted-foreground">
          {expanded ? "▾" : "▸"}
        </span>
        <span>
          Backlog <span className="text-muted-foreground">({fmt(total)})</span>
        </span>
      </button>
      <p className="-mt-2 pl-5 text-xs text-muted-foreground">
        Flagged before Messages v2 went live
      </p>
      {expanded && (
        <div id="holds-backlog-list" className="flex flex-col gap-3">
          {state?.error && (
            <p
              role="alert"
              data-testid="backlog-error"
              className="rounded-xl border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
            >
              {state.error}
            </p>
          )}
          {loading && !state?.error && (
            <p data-testid="backlog-loading" className="text-xs text-muted-foreground">
              Loading backlog…
            </p>
          )}
          {state?.holds.map((hold) => (
            <HoldCard
              key={hold.id}
              hold={hold}
              label={state.labels.get(hold.id)}
              nowMs={nowMs}
              actions={actions}
              onReload={onReload}
            />
          ))}
          {state && state.hasMore && (
            <button
              type="button"
              onClick={loadMore}
              disabled={moreBusy}
              className="self-start rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-foreground/20 hover:bg-secondary disabled:opacity-60"
            >
              {moreBusy ? "Loading…" : `Load more (${fmt(Math.max(0, state.total - state.holds.length))} left)`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function HoldsRail({
  holds,
  labels,
  nowMs,
  meta,
  split,
  loadBacklog,
  backlogRefreshKey,
  actions,
  onReload,
}: {
  meta?: HoldsMeta;
  /** New / Backlog split; absent = the single flat list (no sections). */
  split?: HoldsSplit;
  loadBacklog?: LoadBacklog;
  /** Changes when the server data refreshes (reloads an open Backlog). */
  backlogRefreshKey?: unknown;
  actions?: HoldActionsApi;
  onReload?: () => void;
  holds: readonly OpenHold<RunWithSteps>[];
  labels: ReadonlyMap<string, RunLabel>;
  nowMs: number;
}) {
  const holdFailures = meta?.failed ?? [];
  const count = split
    ? split.error
      ? "(count unavailable)"
      : `(${fmt(split.newTotal)} new · ${fmt(split.backlogTotal)} backlog)`
    : meta?.totalState === "unavailable"
      ? `(count unavailable, ${holds.length} shown)`
      : meta?.totalState === "capped"
        ? `(2,000+ holds (incomplete), ${meta.shown} shown)`
        : meta?.totalState === "incomplete"
          ? `(${meta.total}+ holds (incomplete), ${meta.shown} shown)`
          : meta?.truncated
            ? `(${meta.total}, ${meta.shown} shown)`
            : `(${holds.length})`;
  const cards = holds.map((hold) => (
    <HoldCard
      key={hold.id}
      hold={hold}
      label={labels.get(hold.id)}
      nowMs={nowMs}
      actions={actions}
      onReload={onReload}
    />
  ));
  return (
    <aside
      aria-label="Holds"
      data-testid="holds-scroll"
      className="flex flex-col gap-3 lg:min-h-0 lg:overflow-y-auto lg:pr-1"
    >
      <h2 className="lg:sticky lg:top-0 z-10 bg-background pb-1 text-sm font-semibold">
        Holds <span className="text-muted-foreground">{count}</span>
      </h2>
      {split?.error && (
        <p
          role="alert"
          data-testid="holds-split-unavailable"
          className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          Holds unavailable — {split.error}
        </p>
      )}
      {holdFailures.length > 0 && (
        <p
          role="alert"
          data-testid="holds-unavailable"
          className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          Holds unavailable —{" "}
          {holdFailures.map((f) => SOURCE_NAME[f]).join(", ")} query failed
        </p>
      )}
      {meta?.deadLetterUnavailable && (
        <p
          role="alert"
          data-testid="dead-letter-unavailable"
          className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          dead-letter status unavailable — saved-reply markers may be missing.
        </p>
      )}
      {meta && meta.contextErrors.length > 0 && (
        <p
          role="alert"
          data-testid="holds-context-errors"
          className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          Some hold details failed to load ({meta.contextErrors.join(", ")});
          cards may be missing run context.
        </p>
      )}
      {split ? (
        <>
          {!split.error && (
            <section aria-label="New holds" data-testid="holds-new" className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold">
                New <span className="text-muted-foreground">({fmt(split.newTotal)})</span>
              </h3>
              {split.newShown < split.newTotal && (
                <p data-testid="holds-new-capped" className="text-xs text-muted-foreground">
                  Showing {fmt(split.newShown)} of {fmt(split.newTotal)} new holds
                </p>
              )}
              {holds.length === 0 ? (
                holdFailures.length > 0 ? null : (
                  <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                    No new holds.
                  </p>
                )
              ) : (
                cards
              )}
            </section>
          )}
          {!split.error && split.backlogTotal > 0 && (
            <BacklogSection
              total={split.backlogTotal}
              loadBacklog={loadBacklog}
              refreshKey={backlogRefreshKey}
              nowMs={nowMs}
              actions={actions}
              onReload={onReload}
            />
          )}
        </>
      ) : holds.length === 0 ? (
        holdFailures.length > 0 ? null : (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
            No open holds.
          </p>
        )
      ) : (
        cards
      )}
    </aside>
  );
}
