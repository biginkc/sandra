"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";

import { pageText } from "./page-text";
import type { HoldActionsApi, LoadOlderHolds, RevalidateHolds, WaitingSnapshot } from "./hold-action-types";
import { chicagoDateClock } from "./chicago-time";
import {
  actionsEnabled,
  applyResults,
  cardFlags,
  commitIfCurrent,
  isCurrent,
  loadedCard,
  type CardRecord,
  type CardTable,
  type CheckResult,
  type LiveView,
  type Now,
  type Pinned,
  type Stamp,
} from "./client-state";
import { SEEN_CHECK_FAILED } from "./snapshot-codec";
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
  paused,
  selected = false,
}: {
  hold: OpenHold<RunWithSteps>;
  label: RunLabel | undefined;
  /** The snapshot time this card was ordered by (shown instead of the live one). */
  at?: string | null;
  /** Newer activity arrived after this list was built: actions are locked until the list is refreshed. */
  updated?: boolean;
  /** The last live re-check failed: actions are paused until a check succeeds. */
  paused?: boolean;
  /** Opened from a link for this hold's failed reply: ring it and scroll it into view. */
  selected?: boolean;
  /** flag_reason is the snapshot's reason: it wins over the run's own reason and outcome (as on the tape). */
  pinned?: boolean;
  actions?: HoldActionsApi;
  onReload?: () => void;
}) {
  const run = hold.run;
  const who = sellerWho(label);
  // Snapshot holds: the snapshot reason (null included) is the only reason, exactly as on the tape.
  const effectiveRun = run ? (pinned ? { ...run, reason: hold.flag_reason ?? null } : withEffectiveReason(run, hold.flag_reason)) : null;
  const cardRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (selected) cardRef.current?.scrollIntoView?.({ block: "center" });
  }, [selected]);
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
      ref={cardRef}
      data-testid="waiting-card"
      {...(informational ? { "data-informational": "true" } : {})}
      {...(selected ? { "data-selected": "true" } : {})}
      className={cn("flex flex-col gap-2.5 rounded-2xl border bg-card p-4 text-sm", selected && "ring-2 ring-sky-500")}
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
      {!informational && (updated || paused) && (
        <div data-testid={updated ? "hold-changed" : "hold-paused"} className="flex flex-col gap-2">
          <p className="text-xs text-amber-800">
            {updated ? "Changed since this list loaded. Refresh to act." : "Couldn't re-check this list. Actions are paused until it can be checked."}
          </p>
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
        !paused &&
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
  focus,
  focusHold,
  focusHoldErrors,
}: {
  /** contextErrors from loading the pinned card (a failed version check pauses actions). */
  focusHoldErrors?: readonly string[];
  /** Opened with ?deadLetter=<id>: that failed reply's lead; its card is selected. */
  focus?: { deadLetterId: string; propertyId: string | null } | null;
  /**
   * The focused hold loaded by id when it is beyond the first page (null = no longer eligible; undefined = not
   * looked up because it was already in the first page or there is no focus).
   */
  focusHold?: OpenHold<RunWithSteps> | null;
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
  const entries =
    snapshot?.entries ??
    holds.map((h) => ({
      id: h.id,
      at: holdActivityAt(h),
      r: -1,
      run: h.run?.id ?? null,
      fa: h.seen?.flagAt ?? null,
      th: h.seen?.through ?? null,
      d: h.draft?.id ?? null,
      ds: h.draft?.sendable === true,
    }));
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

  // ---- Per-card records (client-state.ts): one record per card, every writer commits through commitIfCurrent.
  const refreshKeyRef = useRef<unknown>(refreshKey);
  const nowState = (): Now => ({ snapshotKey: refreshKeyRef.current });
  /** One counter for every check that can set a card's status (slice loads and live re-checks), in request order. */
  const cardCheckSeq = useRef(0);
  const entryById = new Map(entries.map((e) => [e.id, e] as const));
  const pinsOf = (id: string, h?: OpenHold<RunWithSteps>): Pinned | undefined => {
    const e = snapshot ? entryById.get(id) : undefined;
    if (e)
      return {
        pinnedDraft: e.d ?? null,
        pinnedDraftSendable: e.d ? e.ds === true : false,
        pinnedReason: reasonOf(e.r),
        pinnedFa: e.fa,
        pinnedRun: e.run,
        pinnedAt: e.at,
        seenVersion: e.th ?? null,
      };
    if (!h) return undefined;
    // No snapshot entry (tests without a snapshot, or a pinned card outside it): pinned to the card as it loaded.
    return {
      pinnedDraft: h.draft?.id ?? null,
      pinnedDraftSendable: h.draft?.sendable === true,
      pinnedReason: h.flag_reason ?? null,
      pinnedFa: h.seen?.flagAt ?? null,
      pinnedRun: h.run?.id ?? null,
      pinnedAt: holdActivityAt(h),
      seenVersion: h.seen?.through ?? null,
    };
  };
  const initialTable = (): CardTable => {
    const cards = new Map<string, CardRecord>();
    const firstOk = !meta?.contextErrors.includes(SEEN_CHECK_FAILED);
    for (const h of holds) cards.set(h.id, loadedCard(refreshKey, pinsOf(h.id, h)!, firstOk));
    if (focusHold) cards.set(focusHold.id, loadedCard(refreshKey, pinsOf(focusHold.id, focusHold)!, !focusHoldErrors?.includes(SEEN_CHECK_FAILED)));
    return { snapshotKey: refreshKey, cards };
  };
  const [storedTable, setTable] = useState<CardTable>(initialTable);
  const table = storedTable.snapshotKey === refreshKey ? storedTable : initialTable();
  /** Functional update against the CURRENT snapshot's table (a stored table for an older snapshot is replaced). */
  const updateTable = (fn: (t: CardTable) => CardTable) =>
    setTable((prev) => fn(prev.snapshotKey === refreshKeyRef.current ? prev : initialTable()));
  const missingIds = new Set([...older.missing, ...[...table.cards].filter(([, c]) => c.status === "missing").map(([id]) => id)]);
  const present = entries.filter((e) => !missingIds.has(e.id));
  const loadedEntries = present.filter((e) => live.has(e.id));
  const shown = loadedEntries.slice(0, visible);
  const hiddenLoaded = loadedEntries.length - shown.length;
  const unrequested = entries.slice(older.nextPos).filter((e) => !live.has(e.id) && !missingIds.has(e.id));
  const notLoadedYet = unrequested.length;
  const focusInShown = !!focus?.propertyId && shown.some((e) => live.get(e.id)?.property_id === focus.propertyId);
  // Beyond the first page: the server loaded it by id; pinned on top until it appears in place.
  const focusPinned =
    !focusInShown && focusHold && !missingIds.has(focusHold.id) ? focusHold : null;
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
      const requestedFrom = older.nextPos;
      const requestKey = refreshKey;
      const sliceSeq = ++cardCheckSeq.current;
      const stamp: Stamp = { snapshotKey: requestKey, seq: sliceSeq };
      const res = await loadOlder({ ids });
      if (res.ok) {
        // Functional and monotonic: merge into the LATEST state (a re-check may have removed cards meanwhile);
        // `missing` only grows within a snapshot, so a removed card is never brought back by a later slice.
        commitIfCurrent<OlderState>(stamp, nowState, setOlder, (prev) => {
          const cur = prev.forKey === requestKey ? prev : fresh();
          const missing = new Set([...cur.missing, ...res.data.missing]);
          return {
            ...cur,
            cards: new Map([...cur.cards, ...res.data.holds.filter((h) => !missing.has(h.id)).map((h) => [h.id, h] as const)]),
            labels: new Map([...cur.labels, ...res.data.labels]),
            missing,
            nextPos: Math.max(cur.nextPos, requestedFrom + ids.length),
            unverified: res.data.unverified,
            error: res.data.contextErrors.length ? "Some details on the older texts could not be loaded." : null,
          };
        });
        // Each loaded card's own check: its load ran the fresh version check (ok) or not (paused).
        const outcome: CheckResult = res.data.contextErrors.includes(SEEN_CHECK_FAILED) ? "failed" : "ok";
        const byId = new Map(res.data.holds.map((h) => [h.id, h] as const));
        commitIfCurrent<CardTable>(stamp, nowState, updateTable, (t) =>
          applyResults(
            t,
            stamp,
            [...res.data.holds.map((h) => [h.id, outcome] as const), ...res.data.missing.map((id) => [id, "gone"] as const)],
            (id) => pinsOf(id, byId.get(id)),
          ),
        );
        if (isCurrent(stamp, nowState())) setVisible((v) => v + PAGE);
      } else {
        // Position kept: the same ids are asked for again on retry.
        const message = res.error.message;
        commitIfCurrent<OlderState>(stamp, nowState, setOlder, (prev) => ({ ...(prev.forKey === requestKey ? prev : fresh()), error: message }));
      }
    } catch {
      commitIfCurrent<OlderState>({ snapshotKey: refreshKey }, nowState, setOlder, (prev) => ({
        ...(prev.forKey === refreshKey ? prev : fresh()),
        error: "Older texts could not be loaded.",
      }));
    } finally {
      setBusy(false);
    }
  };

  // Live re-check of rendered cards: properties (flag, DNC lock) is not in the realtime publication, so every
  // 60 seconds and on tab focus the rendered ids are checked against the CURRENT list. No longer eligible ->
  // missing (removed); any snapshot field differs -> Updated (actions locked).
  const shownIdsRef = useRef<string[]>([]);
  const entriesRef = useRef(entries);
  const olderRef = useRef(older);
  const liveRef = useRef(new Map<string, OpenHold<RunWithSteps>>());
  useEffect(() => {
    liveRef.current = live;
    // The pinned My Leads card is always re-checked too, whether or not it is in the snapshot.
    shownIdsRef.current = [...shown.map((e) => e.id), ...(focusPinned ? [focusPinned.id] : [])];
    entriesRef.current = entries;
    olderRef.current = older;
    refreshKeyRef.current = refreshKey;
  });
  useEffect(() => {
    if (!revalidate || !snapshot) return;
    let alive = true;
    const check = async () => {
      const key = refreshKeyRef.current;
      const stamp: Stamp = { snapshotKey: key, seq: ++cardCheckSeq.current };
      const ids = shownIdsRef.current;
      if (!ids.length) return;
      const byId = new Map(entriesRef.current.map((e) => [e.id, e]));
      const results: Array<readonly [string, CheckResult]> = [];
      const fail = () => {
        if (alive) commitIfCurrent<CardTable>(stamp, nowState, updateTable, (t) => applyResults(t, stamp, ids.map((id) => [id, "failed"] as const)));
      };
      for (let i = 0; i < ids.length; i += 100) {
        let res;
        try {
          res = await revalidate({ ids: ids.slice(i, i + 100) });
        } catch {
          fail();
          return;
        }
        if (!alive) return;
        if (!res.ok) {
          fail();
          return;
        }
        for (const st of res.data) {
          if (!st.eligible) {
            results.push([st.id, "gone"]);
            continue;
          }
          const e = byId.get(st.id);
          if (!e) {
            results.push([st.id, "ok"]); // a pinned card outside the snapshot: eligibility only
            continue;
          }
          // Compared against the SNAPSHOT's draft (id, property, sendable), never the already-updated card.
          const snapDraft = e.d ?? null;
          const draftMoved = st.draftId !== snapDraft || (snapDraft !== null && (st.draftProperty !== st.id || st.draftSendable !== (e.ds === true)));
          const changed =
            draftMoved || st.through !== (e.th ?? null) || st.flagAt !== e.fa || st.flagReason !== reasonOf(e.r) || st.runId !== e.run || st.activityAt !== e.at;
          results.push([st.id, changed ? "updated" : "ok"]);
        }
      }
      if (!alive) return;
      // Per card: facts (gone / updated) always apply; ok only when newer than that card's last check (R-A, R-B).
      commitIfCurrent<CardTable>(stamp, nowState, updateTable, (t) => applyResults(t, stamp, results));
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
  /** The card as frozen by the snapshot: its reason and flag time, so an action on a changed hold comes back STALE. */
  const asSnapshot = (e: (typeof entries)[number], h: OpenHold<RunWithSteps> = live.get(e.id)!): OpenHold<RunWithSteps> => {
    if (!snapshot) return h;
    const reason = reasonOf(e.r);
    return {
      ...h,
      ...(reason ? { flag_reason: reason } : { flag_reason: null }),
      // Always the SNAPSHOT versions (reason, flag time, pending-row version), never the live ones: the server
      // compares them and refuses a changed hold.
      seen: { through: e.th ?? null, flagReason: reason, flagAt: e.fa },
    };
  };
  /** The live values the card shows now, for the one actions rule. */
  const liveViewOf = (h: OpenHold<RunWithSteps>): LiveView => ({
    draftId: h.draft?.id ?? null,
    draftSendable: h.draft?.sendable === true,
    flagReason: h.flag_reason ?? null,
    seenFlagReason: h.seen ? (h.seen.flagReason ?? null) : undefined,
    seenFlagAt: h.seen?.flagAt ?? null,
    seenThrough: h.seen?.through ?? null,
    activityAt: holdActivityAt(h),
    runId: h.run?.id ?? null,
  });
  /** updated / paused for a card, from its record and live view only (actionsEnabled is the single rule). */
  const cardState = (id: string, h: OpenHold<RunWithSteps>) => {
    const rec = table.cards.get(id);
    const extra = !!updatedIds?.has(id);
    const view = liveViewOf(h);
    const enabled = actionsEnabled(rec, view, extra);
    const flags = cardFlags(rec, view, extra);
    return { updated: flags.updated, paused: !enabled && !flags.updated };
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
          <p>{pageText(error)}</p>
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
      {[...shown.map((e) => e.id), ...(focusPinned ? [focusPinned.id] : [])].some((id) => table.cards.get(id)?.status === "paused") && (
        <p role="alert" data-testid="holds-recheck-failed" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          Couldn&apos;t re-check this list. Actions are paused until it can be checked.
        </p>
      )}
      {focusPinned ? (
        <div data-testid="focus-pinned" className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-sky-700">Opened from My Leads</p>
          {(() => {
            const e = entries.find((x) => x.id === focusPinned.id);
            const hold = e ? asSnapshot(e, focusPinned) : focusPinned;
            const st = cardState(focusPinned.id, focusPinned);
            return (
              <WaitingCard
                hold={hold}
                at={snapshot && e ? e.at : undefined}
                label={labelFor(focusPinned.id)}
                actions={actions}
                onReload={onReload}
                updated={st.updated}
                pinned={!!snapshot && !!e}
                paused={st.paused}
                selected
              />
            );
          })()}
        </div>
      ) : (
        focus &&
        !focusInShown && (
          <p role="status" data-testid="dead-letter-focus-missing" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
            {focus.propertyId
              ? focusHold === undefined
                ? "The failed reply you opened is not among the texts shown. Try Show older, or it may already be resolved."
                : "This item was handled or is no longer available."
              : "The failed reply you opened could not be found. It may already be resolved."}
          </p>
        )
      )}
      {missingIds.size > 0 && (
        <p data-testid="holds-missing" className="rounded-xl border bg-secondary p-3 text-xs text-muted-foreground">
          {missingIds.size.toLocaleString("en-US")} {missingIds.size === 1 ? "was" : "were"} handled or {missingIds.size === 1 ? "is" : "are"} no longer available since this list loaded.
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
          {pageText(older.error)}
        </p>
      )}
      {shown.length === 0 ? (
        failures.length > 0 || error ? null : (
          <p className="rounded-2xl border border-dashed p-4 text-sm text-muted-foreground">Nothing is waiting for you.</p>
        )
      ) : (
        shown.map((e) => {
          const hold = asSnapshot(e);
          const st = cardState(e.id, live.get(e.id)!);
          return (
            <WaitingCard
              key={e.id}
              hold={hold}
              at={snapshot ? e.at : undefined}
              label={labelFor(e.id)}
              actions={actions}
              onReload={onReload}
              updated={st.updated}
              pinned={!!snapshot}
              paused={st.paused}
              selected={!!focus?.propertyId && live.get(e.id)?.property_id === focus.propertyId}
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
