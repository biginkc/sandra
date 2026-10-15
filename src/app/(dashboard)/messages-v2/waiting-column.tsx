"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

import type { HoldActionsApi, LoadOlderHolds } from "./hold-action-types";
import { chicagoDateClock } from "./chicago-time";
import { holdActivityAt, holdCursor, sortNewestFirst } from "./hold-activity";
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
}: {
  hold: OpenHold<RunWithSteps>;
  label: RunLabel | undefined;
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
  /** Holds still to load after the last page, from the server; null until the first "Show older". */
  remaining: number | null;
  error: string | null;
};

/**
 * "Waiting for a person": ONE list in latest-activity order. The server sorts
 * every open hold (DNC-locked excluded) and sends the newest slice; "Show older"
 * first reveals what is already loaded, then asks the server for the next slice
 * of that same order, so page 1 really is the newest activity.
 */
export function WaitingColumn({
  holds,
  labels,
  meta,
  total,
  error,
  unverified,
  loadOlder,
  refreshKey,
  actions,
  onReload,
}: {
  holds: readonly OpenHold<RunWithSteps>[];
  labels: ReadonlyMap<string, RunLabel>;
  meta?: HoldsMeta;
  /** All waiting holds on the server. */
  total: number;
  error?: string | null;
  /** Texts hidden because their property could not be determined. */
  unverified?: number;
  loadOlder?: LoadOlderHolds;
  /** Changes when the server data refreshes (drops stale older slices). */
  refreshKey?: unknown;
  actions?: HoldActionsApi;
  onReload?: () => void;
}) {
  const [visible, setVisible] = useState(PAGE);
  const [stored, setOlder] = useState<OlderState>({ forKey: refreshKey, holds: [], labels: new Map(), remaining: null, error: null });
  const [busy, setBusy] = useState(false);

  const older: OlderState =
    stored.forKey === refreshKey ? stored : { forKey: refreshKey, holds: [], labels: new Map(), remaining: null, error: null };

  // Page 1 is the top of the server order (re-sorting it is a no-op unless a live step moved it); later slices
  // continue that order and are never re-sorted across the seam.
  const seen = new Set(holds.map((h) => h.id));
  const loaded = [...sortNewestFirst(holds), ...older.holds.filter((h) => !seen.has(h.id))];
  const shown = loaded.slice(0, visible);
  const hiddenLoaded = loaded.length - shown.length;
  // Before the first "Show older" the page's own total says how many are left; after it, the server's keyset answer does.
  const notLoadedYet = older.remaining ?? Math.max(0, total - loaded.length);
  const serverTotal = loaded.length + notLoadedYet;
  const canLoadMore = !!loadOlder && notLoadedYet > 0;

  const showOlder = async () => {
    if (hiddenLoaded > 0) {
      setVisible((v) => v + PAGE);
      return;
    }
    if (!loadOlder || busy || !canLoadMore) return;
    setBusy(true);
    try {
      const res = await loadOlder({ cursor: loaded.length ? holdCursor(loaded[loaded.length - 1]) : null, limit: OLDER_PAGE });
      if (res.ok) {
        setOlder({
          forKey: refreshKey,
          holds: [...older.holds, ...res.data.holds],
          labels: new Map([...older.labels, ...res.data.labels]),
          remaining: res.data.remaining,
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
      {!!unverified && unverified > 0 && (
        <p data-testid="holds-unverified" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          {unverified.toLocaleString("en-US")} waiting {unverified === 1 ? "text is" : "texts are"} hidden because {unverified === 1 ? "its" : "their"} property could not be determined.
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
