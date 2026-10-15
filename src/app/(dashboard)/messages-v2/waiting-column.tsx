"use client";

import { format } from "date-fns/format";
import { useState } from "react";

import { Button } from "@/components/ui/button";

import type { HoldActionsApi, LoadBacklog } from "./hold-action-types";
import { DisabledHoldActions, effectiveDraftBody, HoldActionControls } from "./hold-action-controls";
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

/** Newest first. A hold with no known start time sorts last, never first by accident. */
export function sortNewestFirst<T extends { id: string; since: string | null }>(holds: readonly T[]): T[] {
  const t = (h: T) => (h.since ? Date.parse(h.since) : Number.NEGATIVE_INFINITY);
  return [...holds].sort((a, b) => (t(a) === t(b) ? a.id.localeCompare(b.id) : t(b) - t(a)));
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
          {hold.since ? (
            <time suppressHydrationWarning dateTime={hold.since}>
              {format(new Date(hold.since), "MMM d, h:mm a")}
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

/**
 * "Waiting for a person": one list, newest first. DNC-locked properties are
 * filtered out on the server. "Show older" first reveals what is already
 * loaded, then pages in the pre-cutover backlog (same server action as before).
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
  const [older, setOlder] = useState<{
    forKey: unknown;
    holds: OpenHold<RunWithSteps>[];
    labels: Map<string, RunLabel>;
    nextOffset: number;
    hasMore: boolean;
    error: string | null;
  }>({ forKey: backlogRefreshKey, holds: [], labels: new Map(), nextOffset: 0, hasMore: (split?.backlogTotal ?? 0) > 0, error: null });
  const [busy, setBusy] = useState(false);

  // A server refresh makes already-loaded older pages stale: start them over.
  const stale = older.forKey !== backlogRefreshKey;
  const olderHolds = stale ? [] : older.holds;
  const hasMoreBacklog = stale ? (split?.backlogTotal ?? 0) > 0 : older.hasMore;
  const nextOffset = stale ? 0 : older.nextOffset;
  const olderLabels = stale ? new Map<string, RunLabel>() : older.labels;

  const seen = new Set(holds.map((h) => h.id));
  const all = sortNewestFirst([...holds, ...olderHolds.filter((h) => !seen.has(h.id))]);
  const shown = all.slice(0, visible);
  const hiddenLoaded = all.length - shown.length;
  const canLoadBacklog = !!loadBacklog && hasMoreBacklog;

  const showOlder = async () => {
    if (hiddenLoaded > 0) {
      setVisible((v) => v + PAGE);
      return;
    }
    if (!loadBacklog || busy) return;
    setBusy(true);
    try {
      const res = await loadBacklog({ offset: nextOffset, limit: BACKLOG_PAGE });
      if (res.ok) {
        setOlder({
          forKey: backlogRefreshKey,
          holds: [...olderHolds, ...res.data.holds],
          labels: new Map([...olderLabels, ...res.data.labels]),
          nextOffset: res.data.nextOffset,
          hasMore: res.data.hasMore,
          error: null,
        });
        setVisible((v) => v + PAGE);
      } else {
        setOlder((o) => ({ ...o, forKey: backlogRefreshKey, holds: olderHolds, labels: olderLabels, nextOffset, hasMore: hasMoreBacklog, error: res.error.message }));
      }
    } catch {
      setOlder((o) => ({ ...o, forKey: backlogRefreshKey, holds: olderHolds, labels: olderLabels, nextOffset, hasMore: hasMoreBacklog, error: "Older texts could not be loaded." }));
    } finally {
      setBusy(false);
    }
  };

  const failures = meta?.failed ?? [];
  const labelFor = (id: string) => labels.get(id) ?? olderLabels.get(id);
  return (
    <aside aria-label="Waiting for a person" data-testid="waiting-column" className="flex min-w-0 flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <h2 className="text-base font-semibold">Waiting for a person</h2>
        <span data-testid="waiting-count" className="rounded-full bg-secondary px-2 py-px text-xs font-medium text-muted-foreground">
          {all.length}
          {canLoadBacklog ? "+" : ""}
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
      {(hiddenLoaded > 0 || canLoadBacklog) && (
        <div className="flex justify-center">
          <Button type="button" variant="ghost" size="sm" data-testid="show-older" disabled={busy} onClick={showOlder}>
            {busy ? "Loading…" : "Show older"}
          </Button>
        </div>
      )}
    </aside>
  );
}
