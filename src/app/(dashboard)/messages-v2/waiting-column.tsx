"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

import type { HoldActionsApi, LoadOlderHolds } from "./hold-action-types";
import { chicagoDateClock } from "./chicago-time";
import { holdActivityAt, sortNewestFirst } from "./hold-activity";
import { DisabledHoldActions, effectiveDraftBody, HoldActionControls } from "./hold-action-controls";
import { sellerWho } from "./tape-card";
import { holdReasonSentence, withEffectiveReason } from "./tape";
import type { HoldSource, HoldsMeta, OpenHold, RunLabel, RunWithSteps } from "./types";

const PAGE = 20;
const OLDER_PAGE = 50;

const SOURCE_NAME: Record<HoldSource, string> = {
  needs_attention: "needs-attention",
  jev_decision: "decision",
  disposition_review: "review",
  pending_draft: "reply draft",
};

export { holdActivityAt, sortNewestFirst };

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
  updated,
}: {
  hold: OpenHold<RunWithSteps>;
  label: RunLabel | undefined;
  /** Newer activity arrived after this list was built. */
  updated?: boolean;
  actions?: HoldActionsApi;
  onReload?: () => void;
}) {
  const run = hold.run;
  const who = sellerWho(label);
  const effectiveRun = run ? withEffectiveReason(run, hold.flag_reason) : null;
  const draft = effectiveDraftBody(hold);
  const activity = holdActivityAt(hold);
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
        {updated && (
          <span data-testid="hold-updated" className="rounded-full bg-status-new-bg px-2 py-px text-xs font-medium text-status-new-fg">
            Updated · refresh to reorder
          </span>
        )}
        <span data-testid="waiting-time" className="ml-auto tabular-nums">
          {activity !== null ? (
            <time dateTime={activity}>{chicagoDateClock(activity)}</time>
          ) : (
            "time unknown"
          )}
        </span>
      </div>
      {run?.inbound_preview && (
        <p className="self-stretch rounded-2xl rounded-bl-sm bg-status-new-bg px-3 py-2">{run.inbound_preview}</p>
      )}
      <p data-testid="waiting-reason">
        <b>Sandra:</b> {holdReasonSentence(effectiveRun, effectiveRun?.reason ?? hold.flag_reason, who)}
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
  /** The server data these slices were loaded against; a newer one starts them over. */
  forKey: unknown;
  holds: OpenHold<RunWithSteps>[];
  labels: Map<string, RunLabel>;
  /** The server's cursor for the next page (echoed verbatim; the client never builds or re-sorts). */
  cursor: HoldCursorInput | null;
  remaining: number;
  total: number | null;
  unverified: number | null;
  error: string | null;
};

type HoldCursorInput = { at: string | null; id: string; snapshotAt: string };

/**
 * "Waiting for a person": ONE list, in the order the server built over every eligible hold. The client shows
 * what it has, then "Show older" echoes the server's cursor for the next page. It never re-sorts and never
 * computes a cursor itself, so pages cannot overlap or skip.
 */
export function WaitingColumn({
  holds,
  labels,
  meta,
  total,
  remaining,
  nextCursor,
  error,
  unverified,
  loadOlder,
  refreshKey,
  updatedIds,
  actions,
  onReload,
}: {
  holds: readonly OpenHold<RunWithSteps>[];
  labels: ReadonlyMap<string, RunLabel>;
  meta?: HoldsMeta;
  /** All eligible holds on the server (locked and unverifiable excluded). */
  total: number;
  /** Holds after the first page. */
  remaining: number;
  /** The server's cursor for the page after the first. */
  nextCursor: HoldCursorInput | null;
  error?: string | null;
  /** Texts hidden because their property could not be determined. */
  unverified?: number;
  loadOlder?: LoadOlderHolds;
  /** Changes when the server data refreshes (drops stale older slices). */
  refreshKey?: unknown;
  /** Holds with activity newer than the snapshot they were ordered at (shown as "Updated", not reordered). */
  updatedIds?: ReadonlySet<string>;
  actions?: HoldActionsApi;
  onReload?: () => void;
}) {
  const fresh = (): OlderState => ({
    forKey: refreshKey,
    holds: [],
    labels: new Map(),
    cursor: nextCursor,
    remaining,
    total: null,
    unverified: null,
    error: null,
  });
  const [visible, setVisible] = useState(PAGE);
  const [stored, setOlder] = useState<OlderState>(fresh);
  const [busy, setBusy] = useState(false);
  const older: OlderState = stored.forKey === refreshKey ? stored : fresh();

  const seen = new Set(holds.map((h) => h.id));
  const loaded = [...holds, ...older.holds.filter((h) => !seen.has(h.id))];
  const shown = loaded.slice(0, visible);
  const hiddenLoaded = loaded.length - shown.length;
  const notLoadedYet = older.cursor ? older.remaining : 0;
  const serverTotal = older.total ?? total;
  const hiddenUnverified = older.unverified ?? unverified ?? 0;
  const canLoadMore = !!loadOlder && !!older.cursor && notLoadedYet > 0;

  const showOlder = async () => {
    if (hiddenLoaded > 0) {
      setVisible((v) => v + PAGE);
      return;
    }
    if (!loadOlder || busy || !canLoadMore) return;
    setBusy(true);
    try {
      const res = await loadOlder({ cursor: older.cursor, limit: OLDER_PAGE });
      if (res.ok) {
        setOlder({
          forKey: refreshKey,
          holds: [...older.holds, ...res.data.holds],
          labels: new Map([...older.labels, ...res.data.labels]),
          cursor: res.data.nextCursor,
          remaining: res.data.remaining,
          total: res.data.total,
          unverified: res.data.unverified,
          error: res.data.contextErrors.length ? "Some details on the older texts could not be loaded." : null,
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
          {serverTotal}
        </span>
      </div>
      <p className="text-[13px] text-muted-foreground">Not urgent. Check once a day.</p>
      {error && (
        <div role="alert" data-testid="holds-split-unavailable" className="flex flex-col items-start gap-2 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          <p>{error}</p>
          {onReload && (
            <Button type="button" size="xs" variant="outline" data-testid="holds-retry" onClick={onReload}>
              Retry
            </Button>
          )}
        </div>
      )}
      {hiddenUnverified > 0 && (
        <p data-testid="holds-unverified" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          {hiddenUnverified.toLocaleString("en-US")} waiting {hiddenUnverified === 1 ? "text" : "texts"} could not be verified (no single property found), so {hiddenUnverified === 1 ? "it is" : "they are"} hidden.
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
        failures.length > 0 || error ? null : (
          <p className="rounded-2xl border border-dashed p-4 text-sm text-muted-foreground">Nothing is waiting for you.</p>
        )
      ) : (
        shown.map((hold) => (
          <WaitingCard key={hold.id} hold={hold} label={labelFor(hold.id)} actions={actions} onReload={onReload} updated={updatedIds?.has(hold.id)} />
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
