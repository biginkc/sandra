"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

import type { HoldActionsApi, LoadOlderHolds, RevalidateHolds, WaitingSnapshot } from "./hold-action-types";
import { chicagoDateClock } from "./chicago-time";
import { holdActivityAt } from "./hold-activity";
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

export { holdActivityAt };

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
  at,
  pinned,
}: {
  hold: OpenHold<RunWithSteps>;
  label: RunLabel | undefined;
  /** The snapshot time this card was ordered by (shown instead of the live one). */
  at?: string | null;
  /** Newer activity arrived after this list was built: actions are locked until the list is refreshed. */
  updated?: boolean;
  /** flag_reason is the snapshot's reason: it wins over the run's own reason and outcome (as on the tape). */
  pinned?: boolean;
  actions?: HoldActionsApi;
  onReload?: () => void;
}) {
  const run = hold.run;
  const who = sellerWho(label);
  // Snapshot holds: the snapshot reason (null included) is the only reason, exactly as on the tape.
  const effectiveRun = run ? (pinned ? { ...run, reason: hold.flag_reason ?? null } : withEffectiveReason(run, hold.flag_reason)) : null;
  const draft = effectiveDraftBody(hold);
  const activity = at !== undefined ? at : holdActivityAt(hold);
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
        <b>Sandra:</b> {pinned ? holdReasonSentence(effectiveRun, hold.flag_reason ?? null, who, true) : holdReasonSentence(effectiveRun, effectiveRun?.reason ?? hold.flag_reason, who)}
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
      {!informational && updated && (
        <div data-testid="hold-changed" className="flex flex-col gap-2">
          <p className="text-xs text-amber-800">Changed since this list loaded. Refresh to act.</p>
          <div className="flex flex-wrap items-center gap-2">
            <DisabledHoldActions title="Changed since this list loaded. Refresh to act." />
            {onReload && (
              <Button type="button" size="xs" variant="outline" data-testid="hold-refresh" onClick={onReload}>
                Refresh
              </Button>
            )}
          </div>
        </div>
      )}
      {!informational &&
        !updated &&
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
  /** The snapshot these cards were loaded against; a new snapshot starts them over. */
  forKey: unknown;
  cards: Map<string, OpenHold<RunWithSteps>>;
  labels: Map<string, RunLabel>;
  /** Snapshot ids that are no longer waiting (resolved, locked, unverifiable since the snapshot). */
  missing: Set<string>;
  /** Next snapshot position to request. */
  nextPos: number;
  unverified: number | null;
  error: string | null;
};

/**
 * "Waiting for a person": rendered in SNAPSHOT order. The server froze the order (with each hold's time, reason,
 * shown run and flag time) when the page loaded; "Show older" asks for the next snapshot ids and gets their
 * CURRENT details. The order, time and reason always come from the snapshot (the tape uses the same reasons);
 * a card whose live data differs is marked "Updated", and ids that are no longer waiting are dropped with a note.
 */
export function WaitingColumn({
  holds,
  labels,
  meta,
  snapshot,
  error,
  unverified,
  loadOlder,
  refreshKey,
  updatedIds,
  initialMissing,
  revalidate,
  actions,
  onReload,
}: {
  holds: readonly OpenHold<RunWithSteps>[];
  /** First-page snapshot ids the server dropped in its final check. */
  initialMissing?: readonly string[];
  /** Re-checks rendered cards every 60 seconds and on tab focus. */
  revalidate?: RevalidateHolds;
  labels: ReadonlyMap<string, RunLabel>;
  meta?: HoldsMeta;
  /** The frozen order. Holds not in it (for example in tests) are shown after it, in the order given. */
  snapshot?: WaitingSnapshot;
  error?: string | null;
  /** Texts hidden because their property could not be determined. */
  unverified?: number;
  loadOlder?: LoadOlderHolds;
  /** Changes with every new snapshot (drops older cards loaded against the previous one). */
  refreshKey?: unknown;
  /** Holds with realtime activity newer than the snapshot. */
  updatedIds?: ReadonlySet<string>;
  actions?: HoldActionsApi;
  onReload?: () => void;
}) {
  const entries = snapshot?.entries ?? holds.map((h) => ({ id: h.id, at: holdActivityAt(h), r: -1, run: h.run?.id ?? null, fa: h.seen?.flagAt ?? null }));
  const reasonOf = (r: number) => (snapshot && r >= 0 ? snapshot.reasons[r] : null);
  const fresh = (): OlderState => ({
    forKey: refreshKey,
    cards: new Map(),
    labels: new Map(),
    missing: new Set(initialMissing ?? []),
    nextPos: holds.length + (initialMissing?.length ?? 0),
    unverified: null,
    error: null,
  });
  const [visible, setVisible] = useState(PAGE);
  const [stored, setOlder] = useState<OlderState>(fresh);
  const [busy, setBusy] = useState(false);
  const older: OlderState = stored.forKey === refreshKey ? stored : fresh();

  const live = new Map<string, OpenHold<RunWithSteps>>([...older.cards, ...holds.map((h) => [h.id, h] as const)]);
  const present = entries.filter((e) => !older.missing.has(e.id));
  const loadedEntries = present.filter((e) => live.has(e.id));
  const shown = loadedEntries.slice(0, visible);
  const hiddenLoaded = loadedEntries.length - shown.length;
  const unrequested = entries.slice(older.nextPos).filter((e) => !live.has(e.id) && !older.missing.has(e.id));
  const notLoadedYet = unrequested.length;
  const serverTotal = present.length;
  const hiddenUnverified = older.unverified ?? unverified ?? 0;
  const canLoadMore = !!loadOlder && notLoadedYet > 0;

  const showOlder = async () => {
    if (hiddenLoaded > 0) {
      setVisible((v) => v + PAGE);
      return;
    }
    if (!loadOlder || busy || !canLoadMore) return;
    const ids = entries.slice(older.nextPos, older.nextPos + OLDER_PAGE).map((e) => e.id);
    setBusy(true);
    try {
      const res = await loadOlder({ ids });
      if (res.ok) {
        setOlder({
          forKey: refreshKey,
          cards: new Map([...older.cards, ...res.data.holds.map((h) => [h.id, h] as const)]),
          labels: new Map([...older.labels, ...res.data.labels]),
          missing: new Set([...older.missing, ...res.data.missing]),
          nextPos: older.nextPos + ids.length,
          unverified: res.data.unverified,
          error: res.data.contextErrors.length ? "Some details on the older texts could not be loaded." : null,
        });
        setVisible((v) => v + PAGE);
      } else {
        // Position kept: the same ids are asked for again on retry.
        setOlder({ ...older, error: res.error.message });
      }
    } catch {
      setOlder({ ...older, error: "Older texts could not be loaded." });
    } finally {
      setBusy(false);
    }
  };

  // Live re-check of rendered cards: properties (flag, DNC lock) is not in the realtime publication, so every
  // 60 seconds and on tab focus the rendered ids are checked against the CURRENT list. No longer eligible ->
  // missing (removed); any snapshot field differs -> Updated (actions locked).
  const [stale, setStale] = useState<{ forKey: unknown; ids: Set<string> }>({ forKey: refreshKey, ids: new Set() });
  const staleIds = stale.forKey === refreshKey ? stale.ids : new Set<string>();
  const shownIdsRef = useRef<string[]>([]);
  const entriesRef = useRef(entries);
  const olderRef = useRef(older);
  useEffect(() => {
    shownIdsRef.current = shown.map((e) => e.id);
    entriesRef.current = entries;
    olderRef.current = older;
  });
  useEffect(() => {
    if (!revalidate || !snapshot) return;
    let alive = true;
    const check = async () => {
      const ids = shownIdsRef.current;
      if (!ids.length) return;
      const byId = new Map(entriesRef.current.map((e) => [e.id, e]));
      const gone: string[] = [];
      const changedIds: string[] = [];
      for (let i = 0; i < ids.length; i += 100) {
        let res;
        try {
          res = await revalidate({ ids: ids.slice(i, i + 100) });
        } catch {
          return;
        }
        if (!alive || !res.ok) return;
        for (const st of res.data) {
          const e = byId.get(st.id);
          if (!e) continue;
          if (!st.eligible) gone.push(st.id);
          else if (st.flagAt !== e.fa || st.flagReason !== reasonOf(e.r) || st.runId !== e.run || st.activityAt !== e.at) changedIds.push(st.id);
        }
      }
      if (!alive) return;
      if (gone.length) setOlder({ ...olderRef.current, forKey: refreshKey, missing: new Set([...olderRef.current.missing, ...gone]) });
      setStale({ forKey: refreshKey, ids: new Set(changedIds) });
    };
    const id = window.setInterval(check, 60_000);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
    // reasonOf reads the snapshot, which changes only with refreshKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revalidate, snapshot, refreshKey]);

  /** The card as frozen by the snapshot: its reason and flag time, so an action on a changed hold comes back STALE. */
  const asSnapshot = (e: (typeof entries)[number]): { hold: OpenHold<RunWithSteps>; changed: boolean } => {
    const h = live.get(e.id)!;
    if (!snapshot) return { hold: h, changed: false };
    const reason = reasonOf(e.r);
    // Updated = ANY snapshot field differs from live: reason, flag time, activity time or the shown run.
    const changed =
      (h.flag_reason ?? null) !== reason ||
      (h.seen?.flagAt ?? null) !== e.fa ||
      holdActivityAt(h) !== e.at ||
      (h.run?.id ?? null) !== e.run;
    return {
      hold: {
        ...h,
        ...(reason ? { flag_reason: reason } : { flag_reason: null }),
        // Always the SNAPSHOT flag version, never the live one (the server compares it and refuses a changed hold).
        seen: { through: h.seen?.through ?? null, flagReason: e.fa ? reason : null, flagAt: e.fa },
      },
      changed,
    };
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
      {older.missing.size > 0 && (
        <p data-testid="holds-missing" className="rounded-xl border bg-secondary p-3 text-xs text-muted-foreground">
          {older.missing.size.toLocaleString("en-US")} {older.missing.size === 1 ? "was" : "were"} handled or {older.missing.size === 1 ? "is" : "are"} no longer available since this list loaded.
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
        shown.map((e) => {
          const { hold, changed } = asSnapshot(e);
          return (
            <WaitingCard
              key={e.id}
              hold={hold}
              at={snapshot ? e.at : undefined}
              label={labelFor(e.id)}
              actions={actions}
              onReload={onReload}
              updated={changed || updatedIds?.has(e.id) || staleIds.has(e.id)}
              pinned={!!snapshot}
            />
          );
        })
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
