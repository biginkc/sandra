"use client";

import { format } from "date-fns/format";
import { useState } from "react";

import { Button } from "@/components/ui/button";

import type { HoldActionsApi, LoadBacklog } from "./hold-action-types";
import { DisabledHoldActions, effectiveDraftBody, HoldActionControls } from "./hold-action-controls";
import { NEW_HOLD_CAP } from "./queries";
import { sellerWho } from "./tape-card";
import { holdReasonSentence } from "./tape";
import type { HoldSource, HoldsMeta, HoldsSplit, OpenHold, RunLabel, RunWithSteps } from "./types";

const PAGE = 20;
const BACKLOG_PAGE = 50;

const SOURCE_NAME: Record<HoldSource, string> = {
  needs_attention: "needs-attention",
  jev_decision: "decision",
  disposition_review: "review",
  pending_draft: "reply draft",
};

/**
 * When anything last happened on this hold: the newest of its start, its latest
 * run (the seller's latest text), that run's latest step, and the newest pending
 * item it shows. `since` alone is the OLDEST source timestamp, so a fresh seller
 * text on an old hold would otherwise be buried.
 */
export function holdActivityMs(hold: OpenHold<RunWithSteps>): number | null {
  const stamps = [
    hold.since,
    hold.run?.started_at,
    hold.run?.completed_at,
    ...(hold.run?.steps ?? []).map((st) => st.created_at),
    hold.seen?.through,
    hold.seen?.flagAt,
  ]
    .map((v) => (v ? Date.parse(v) : Number.NaN))
    .filter((n) => Number.isFinite(n));
  return stamps.length ? Math.max(...stamps) : null;
}

/** Newest activity first. A hold with no known time sorts last, never first by accident. */
export function sortNewestFirst(holds: readonly OpenHold<RunWithSteps>[]): OpenHold<RunWithSteps>[] {
  const t = (h: OpenHold<RunWithSteps>) => holdActivityMs(h) ?? Number.NEGATIVE_INFINITY;
  return [...holds].sort((a, b) => (t(a) === t(b) ? a.id.localeCompare(b.id) : t(b) - t(a)));
}

/** One short plain line when the text alert for this hold did not go out. */
function alertLine(alert: OpenHold["alert"]): string | null {
  if (!alert) return null;
  if (alert.status === "failed") return "Alert failed";
  if (alert.status === "skipped") return "Alert skipped";
  return null;
}

function WaitingCard({
  hold,
  label,
  actions,
  onReload,
}: {
  hold: OpenHold<RunWithSteps>;
  label: RunLabel | undefined;
  actions?: HoldActionsApi;
  onReload?: () => void;
}) {
  const run = hold.run;
  const who = sellerWho(label);
  const draft = effectiveDraftBody(hold);
  const activity = holdActivityMs(hold);
  const alertText = alertLine(hold.alert);
  const dls = hold.dead_letters;
  const hasLate = dls ? dls.some((d) => d.late) : !!hold.dead_letter_late;
  const hasOpenDead = dls ? dls.some((d) => !d.late) : !!hold.dead_letter && !hold.dead_letter_late;
  const informational =
    hold.flag_reason === "send_timeout_then_sent" && hold.sources.every((s) => s === "needs_attention") && !hasOpenDead;
  return (
    <article
      data-testid="waiting-card"
      {...(informational ? { "data-informational": "true" } : {})}
      className="flex flex-col gap-2.5 rounded-2xl border bg-card p-4 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        <span className="font-semibold text-foreground">{label?.name ?? "Unknown sender"}</span>
        {label?.address && <span>· {label.address}</span>}
        <span data-testid="waiting-time" className="ml-auto tabular-nums">
          {activity !== null ? (
            <time suppressHydrationWarning dateTime={new Date(activity).toISOString()}>
              {format(new Date(activity), "MMM d, h:mm a")}
            </time>
          ) : (
            "time unknown"
          )}
        </span>
      </div>
      {run?.inbound_preview && (
        <p className="self-stretch rounded-2xl rounded-bl-sm bg-status-new-bg px-3 py-2">{run.inbound_preview}</p>
      )}
      <p data-testid="waiting-reason">
        <b>Sandra:</b> {holdReasonSentence(run, hold.flag_reason, who)}
      </p>
      {draft !== null && (
        <p data-testid="draft-text" className="whitespace-pre-wrap rounded-2xl rounded-br-sm bg-secondary px-3 py-2 text-[13px] text-muted-foreground">
          {draft}
        </p>
      )}
      {alertText && (
        <p data-testid="hold-alert" data-status={hold.alert?.status} className="text-xs text-red-700">
          {alertText}
        </p>
      )}
      {informational && (
        <p data-testid="hold-informational" className="text-xs text-muted-foreground">
          Informational — accepted by provider late
        </p>
      )}
      {hasLate && (
        <p data-testid="dead-letter-late" className="text-xs text-muted-foreground">
          The reply went out late. Do not re-send.
        </p>
      )}
      {hasOpenDead && (
        <p data-testid="dead-letter" className="text-xs text-amber-700">
          The reply text was saved for review.
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

type OlderState = {
  /** The server data these pages were loaded against; a newer one starts them over. */
  forKey: unknown;
  holds: OpenHold<RunWithSteps>[];
  labels: Map<string, RunLabel>;
  newOffset: number;
  newHasMore: boolean;
  backlogOffset: number;
  backlogHasMore: boolean;
  error: string | null;
};

/** How many New holds the page itself loaded; anything past that is paged in by "Show older". */
const NEW_LOADED = NEW_HOLD_CAP;

function freshOlder(split: HoldsSplit | undefined, forKey: unknown): OlderState {
  return {
    forKey,
    holds: [],
    labels: new Map(),
    newOffset: NEW_LOADED,
    newHasMore: (split?.newTotal ?? 0) > NEW_LOADED,
    backlogOffset: 0,
    backlogHasMore: (split?.backlogTotal ?? 0) > 0,
    error: null,
  };
}

/**
 * "Waiting for a person": one list, newest activity first. DNC-locked
 * properties are filtered out on the server. "Show older" first reveals what is
 * already loaded, then pages in the remaining New holds the page did not load,
 * then the pre-cutover backlog (same server action as before), until every
 * actionable hold is reachable.
 */
export function WaitingColumn({
  holds,
  labels,
  meta,
  split,
  loadBacklog,
  backlogRefreshKey,
  actions,
  onReload,
}: {
  holds: readonly OpenHold<RunWithSteps>[];
  labels: ReadonlyMap<string, RunLabel>;
  meta?: HoldsMeta;
  split?: HoldsSplit;
  loadBacklog?: LoadBacklog;
  /** Changes when the server data refreshes (drops stale older pages). */
  backlogRefreshKey?: unknown;
  actions?: HoldActionsApi;
  onReload?: () => void;
}) {
  const [visible, setVisible] = useState(PAGE);
  const [stored, setOlder] = useState<OlderState>(() => freshOlder(split, backlogRefreshKey));
  const [busy, setBusy] = useState(false);

  const older = stored.forKey === backlogRefreshKey ? stored : freshOlder(split, backlogRefreshKey);

  const seen = new Set(holds.map((h) => h.id));
  const all = sortNewestFirst([...holds, ...older.holds.filter((h) => !seen.has(h.id))]);
  const shown = all.slice(0, visible);
  const hiddenLoaded = all.length - shown.length;
  const canLoadMore = !!loadBacklog && (older.newHasMore || older.backlogHasMore);
  const notLoadedYet =
    Math.max(0, (split?.newTotal ?? 0) - older.newOffset) * (older.newHasMore ? 1 : 0) +
    (older.backlogHasMore ? Math.max(0, (split?.backlogTotal ?? 0) - older.backlogOffset) : 0);

  const showOlder = async () => {
    if (hiddenLoaded > 0) {
      setVisible((v) => v + PAGE);
      return;
    }
    if (!loadBacklog || busy || !canLoadMore) return;
    const bucket = older.newHasMore ? "new" : "backlog";
    setBusy(true);
    try {
      const res = await loadBacklog({ offset: bucket === "new" ? older.newOffset : older.backlogOffset, limit: BACKLOG_PAGE, bucket });
      if (res.ok) {
        setOlder({
          ...older,
          holds: [...older.holds, ...res.data.holds],
          labels: new Map([...older.labels, ...res.data.labels]),
          ...(bucket === "new"
            ? { newOffset: res.data.nextOffset, newHasMore: res.data.hasMore }
            : { backlogOffset: res.data.nextOffset, backlogHasMore: res.data.hasMore }),
          error: null,
        });
        setVisible((v) => v + PAGE);
      } else {
        setOlder({ ...older, error: res.error.message });
      }
    } catch {
      setOlder({ ...older, error: "Older texts could not be loaded." });
    } finally {
      setBusy(false);
    }
  };

  const failures = meta?.failed ?? [];
  const labelFor = (id: string) => labels.get(id) ?? older.labels.get(id);
  return (
    <aside aria-label="Waiting for a person" data-testid="waiting-column" className="flex min-w-0 flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <h2 className="text-base font-semibold">Waiting for a person</h2>
        <span data-testid="waiting-count" className="rounded-full bg-secondary px-2 py-px text-xs font-medium text-muted-foreground">
          {all.length}
          {canLoadMore ? "+" : ""}
        </span>
      </div>
      <p className="text-[13px] text-muted-foreground">Not urgent. Check once a day.</p>
      {split?.error && (
        <p role="alert" data-testid="holds-split-unavailable" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          Waiting texts unavailable — {split.error}
        </p>
      )}
      {failures.length > 0 && (
        <p role="alert" data-testid="holds-unavailable" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          Some waiting texts could not be loaded ({failures.map((f) => SOURCE_NAME[f]).join(", ")}).
        </p>
      )}
      {meta && meta.contextErrors.length > 0 && (
        <p role="alert" data-testid="holds-context-errors" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          Some details could not be loaded, so a few cards may be missing context.
        </p>
      )}
      {meta?.deadLetterUnavailable && (
        <p role="alert" data-testid="dead-letter-unavailable" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          Saved-reply markers could not be loaded, so some cards may be missing them.
        </p>
      )}
      {older.error && (
        <p role="alert" data-testid="older-error" className="rounded-xl border border-red-300 bg-red-50 p-3 text-xs text-red-800">
          {older.error}
        </p>
      )}
      {shown.length === 0 ? (
        failures.length > 0 || split?.error ? null : (
          <p className="rounded-2xl border border-dashed p-4 text-sm text-muted-foreground">Nothing is waiting for you.</p>
        )
      ) : (
        shown.map((hold) => (
          <WaitingCard key={hold.id} hold={hold} label={labelFor(hold.id)} actions={actions} onReload={onReload} />
        ))
      )}
      {(hiddenLoaded > 0 || canLoadMore) && (
        <div className="flex flex-col items-center gap-1">
          <Button type="button" variant="ghost" size="sm" data-testid="show-older" disabled={busy} onClick={showOlder}>
            {busy ? "Loading…" : "Show older"}
          </Button>
          {notLoadedYet > 0 && (
            <p data-testid="not-loaded-count" className="text-xs text-muted-foreground">
              {notLoadedYet.toLocaleString("en-US")} more not shown yet
            </p>
          )}
        </div>
      )}
    </aside>
  );
}
