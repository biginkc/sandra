"use client";
/**
 * useWorkQueue: pagination + refresh state machine for the unified My Leads queue (design v8 section 6).
 * Dependencies are injected, so it never touches Next or the router (the container syncs the URL via onQueryChange).
 *
 * Returns:
 *  - query            { tab, chip, stage, search, page } the view the user asked for.
 *  - rows             displayed rows in order: { facts, leftView, pinned }. The deep-linked lead is first (pinned) on
 *                     ITS tab only. leftView = the lead's placement no longer fits tab/chip/stage; it stays (grey it)
 *                     until the user Refreshes, the timer never removes it.
 *  - total, pageSize  of the DISPLAYED page (drive the page numbers).
 *  - tabCounts, chipCounts, stageCounts  live counts from the newest accepted read, taken together from one response,
 *                     even while the list is retained (rows can be older than counts only then).
 *  - loading          a page load (query change, Refresh, member change) is in flight.
 *  - error            banner text; the last good list stays. Cleared by the next successful read.
 *  - listUpdated      null | { total, counts }: the eligible list changed under the retained rows ("List updated · Refresh").
 *  - notice           one-line message ("Moved to Waiting on them"); dismissNotice() clears it.
 *  - snapshotAt       server time of the newest accepted read.
 *  Actions: setTab (also resets chip to "all"), setChip, setStage, setSearch (container debounces), setPage,
 *  syncQuery (adopt a URL query on Back/Forward; no onQueryChange),
 *  refresh() (swap in the new page, clears listUpdated), retryNow(), afterAction(propertyId), dismissNotice().
 *
 * Concurrency: ONE read clock stamps every read when it STARTS (navigation, background refresh, retained-row facts,
 * after-action facts and counts). A response writes a property's facts only if its stamp is newer than that
 * property's latest accepted stamp, and a background response writes list/counts only if newer than the view's latest
 * accepted stamp. Navigation additionally carries a sequence number; "navigation" loads (query change, Refresh, member change)
 * drop older responses, and background reads (timer, visibility, after-action counts) are dropped when a navigation
 * load or a row mutation started after them, or when a newer background read exists.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LoadWorkFactsResult,
  LoadWorkPageResult,
  UnifiedActionFailure,
  UnifiedInitial,
  WorkFacts,
  WorkPage,
  WorkChip,
  WorkQuery,
  WorkStage,
  WorkTab,
} from "./contract";
import {
  DEFAULT_QUERY,
  afterActionDecision,
  applyCountsOnly,
  applyFacts,
  chunk,
  emptyState,
  initialState,
  markChanged,
  queryKey,
  removeRows,
  replaceInPlace,
  swapIn,
  updateOne,
  visibleRows,
  withQuery,
  type DisplayRow,
  type ListUpdated,
  type WorkState,
} from "./work-queue-state";

export type QueryChangeOptions = { replace?: boolean };

export type UseWorkQueueOptions = {
  initial: UnifiedInitial;
  memberId: string;
  loadPage: (memberId: string, query: WorkQuery) => Promise<LoadWorkPageResult>;
  loadFacts: (memberId: string, ids: string[]) => Promise<LoadWorkFactsResult>;
  /** A composer or dialog is open: the timers do not refresh (a skipped refresh runs when this goes false). */
  paused: boolean;
  /**
   * The container syncs the URL; the hook never touches the router. A second argument { replace: true } marks a change the
   * rep did not make (the server clamped the page, the rep switched): rewrite the address, do not add a history entry.
   */
  onQueryChange?: (query: WorkQuery, options?: QueryChangeOptions) => void;
  refreshIntervalMs?: number;
  now?: () => number;
};

export type UseWorkQueueResult = {
  query: WorkQuery;
  rows: DisplayRow[];
  total: number;
  pageSize: number;
  tabCounts: WorkState["tabCounts"];
  chipCounts: WorkState["chipCounts"];
  stageCounts: WorkState["stageCounts"];
  loading: boolean;
  /** The last navigation read failed: the displayed rows are from an earlier view (grey them) until a retry succeeds. */
  stale: boolean;
  error: string | null;
  listUpdated: ListUpdated | null;
  notice: string | null;
  snapshotAt: string | null;
  setTab: (tab: WorkTab) => void;
  setChip: (chip: WorkChip) => void;
  setStage: (stage: WorkStage | null) => void;
  setSearch: (search: string) => void;
  setPage: (page: number) => void;
  /** Adopt a whole query from outside (browser Back/Forward). Loads it; does not call onQueryChange. */
  syncQuery: (query: WorkQuery) => void;
  refresh: () => void;
  retryNow: () => void;
  afterAction: (propertyId: string) => Promise<void>;
  dismissNotice: () => void;
};

const MAX_TIMEOUT_MS = 2_147_483_647;
const MIN_BOUNDARY_MS = 1000;
// Today's page says this when a refresh throws; the banner appends "Displayed counts may be out of date...".
const READ_FAILED = "My Leads could not refresh.";
const ACTION_READ_FAILED = READ_FAILED;

const fail = (message: string): UnifiedActionFailure => ({
  ok: false,
  message,
});

type FactsRead =
  { ok: true; rows: WorkFacts[]; missing: string[] } | UnifiedActionFailure;

export function useWorkQueue(options: UseWorkQueueOptions): UseWorkQueueResult {
  const { initial, memberId, paused } = options;
  const [state, setState] = useState<WorkState>(() => initialState(initial));
  const stateRef = useRef(state);
  const optsRef = useRef(options);
  const memberRef = useRef(memberId);
  const pausedRef = useRef(paused);
  const navSeq = useRef(0);
  const bgSeq = useRef(0);
  const mutEpoch = useRef(0);
  const navInFlight = useRef(false);
  const missedWhilePaused = useRef(false);
  // One monotonic read clock. Every read is stamped when it starts; accepted stamps are tracked per property and per view.
  const clock = useRef(0);
  const propAccepted = useRef(new Map<string, number>());
  const viewAccepted = useRef(0);
  const runReadRef = useRef<() => Promise<void>>(async () => {});

  // Refs mirror props for the stable callbacks below. Effects run in order, so this one comes first.
  useEffect(() => {
    optsRef.current = options;
    pausedRef.current = paused;
  });

  const commit = useCallback((next: (s: WorkState) => WorkState) => {
    const value = next(stateRef.current);
    stateRef.current = value;
    setState(value);
  }, []);

  const loadPageSafe = useCallback(
    async (member: string, query: WorkQuery): Promise<LoadWorkPageResult> => {
      try {
        return await optsRef.current.loadPage(member, query);
      } catch {
        return fail(READ_FAILED);
      }
    },
    [],
  );

  const loadFactsAll = useCallback(
    async (member: string, ids: string[]): Promise<FactsRead> => {
      try {
        const results = await Promise.all(
          chunk(ids).map((c) => optsRef.current.loadFacts(member, c)),
        );
        const rows: WorkFacts[] = [];
        const missing: string[] = [];
        for (const r of results) {
          if (!r.ok) return r;
          rows.push(...r.facts.rows);
          missing.push(...r.facts.missing);
        }
        return { ok: true, rows, missing };
      } catch {
        return fail(ACTION_READ_FAILED);
      }
    },
    [],
  );

  const fresh = useCallback(
    (id: string, stamp: number) => stamp > (propAccepted.current.get(id) ?? 0),
    [],
  );
  const record = useCallback(
    (ids: Iterable<string>, stamp: number) => {
      for (const id of ids)
        if (fresh(id, stamp)) propAccepted.current.set(id, stamp);
    },
    [fresh],
  );
  /**
   * A page read may carry rows older than facts another read already landed for the same property. Those rows keep the
   * facts on screen (or are dropped if the property has since left the list).
   */
  const reconcilePage = useCallback(
    (page: WorkPage, stamp: number, s: WorkState): WorkPage => {
      const held = new Set(
        page.rows
          .filter((r) => !fresh(r.propertyId, stamp))
          .map((r) => r.propertyId),
      );
      if (!held.size) return page;
      const current = (id: string) =>
        s.facts[id] ?? (s.pinned?.propertyId === id ? s.pinned : undefined);
      const rows = page.rows.flatMap((r) =>
        !held.has(r.propertyId)
          ? [r]
          : current(r.propertyId)
            ? [current(r.propertyId)!]
            : [],
      );
      return {
        ...page,
        rows,
        ids: page.ids.filter((id) => !held.has(id) || current(id)),
      };
    },
    [fresh],
  );
  /** Mark a page's rows as written at `stamp` (call with the reconciled page, after committing). */
  const recordPage = useCallback(
    (page: WorkPage, stamp: number) => {
      record(
        page.rows.map((r) => r.propertyId),
        stamp,
      );
      if (stamp > viewAccepted.current) viewAccepted.current = stamp;
    },
    [record],
  );

  const notify = useCallback((query: WorkQuery, replace = false) => {
    if (replace) optsRef.current.onQueryChange?.(query, { replace: true });
    else optsRef.current.onQueryChange?.(query);
  }, []);

  /** Navigation load: the response becomes the displayed list. */
  const runNav = useCallback(
    async (query: WorkQuery) => {
      const seq = ++navSeq.current;
      navInFlight.current = true;
      commit((s) => ({ ...s, loading: true }));
      const stamp = ++clock.current;
      const res = await loadPageSafe(memberRef.current, query);
      if (seq !== navSeq.current) return;
      navInFlight.current = false;
      if (!res.ok) {
        commit((s) => ({
          ...s,
          loading: false,
          stale: s.order.length > 0 || s.pinned !== null,
          error: res.message,
        }));
        return;
      }
      const page = reconcilePage(res.page, stamp, stateRef.current);
      // A newer read (after-action counts) may have been accepted while this navigation was in flight: its counts and
      // clock fields stay, and a fresh read follows so the older rows are re-checked against the newest view.
      const older = stamp < viewAccepted.current;
      commit((s) => {
        const next = swapIn(s, page, query);
        return older
          ? {
              ...next,
              tabCounts: s.tabCounts,
              chipCounts: s.chipCounts,
              stageCounts: s.stageCounts,
              nextChangeAt: s.nextChangeAt,
              snapshotAt: s.snapshotAt,
            }
          : next;
      });
      recordPage(page, stamp);
      if (res.page.page !== query.page)
        notify({ ...query, page: res.page.page }, true);
      if (older) void runReadRef.current();
    },
    [commit, loadPageSafe, notify, reconcilePage, recordPage],
  );

  /** Background read: re-run the page read with the current query and fold it into the displayed list. */
  const runRead = useCallback(async () => {
    if (navInFlight.current) return;
    const nav0 = navSeq.current;
    const mut0 = mutEpoch.current;
    const my = ++bgSeq.current;
    const member = memberRef.current;
    const query = stateRef.current.query;
    const stamp = ++clock.current;
    const stale = () =>
      nav0 !== navSeq.current ||
      mut0 !== mutEpoch.current ||
      my !== bgSeq.current ||
      stamp < viewAccepted.current;
    const res = await loadPageSafe(member, query);
    if (stale()) return;
    if (!res.ok) {
      commit((s) => ({ ...s, error: res.message }));
      return;
    }
    const s = stateRef.current;
    const page = reconcilePage(res.page, stamp, s);
    const clamped = page.page !== query.page;
    if (s.displayedKey !== queryKey(query) || s.revision === null) {
      // Nothing (or a different query) is on screen: this read IS the list.
      commit((cur) => swapIn(cur, page, query));
      recordPage(page, stamp);
      if (clamped) notify({ ...query, page: page.page }, true);
      return;
    }
    // Facts for retained rows and the off-page pinned lead are re-read under the same clock.
    const refreshFacts = async (ids: string[]) => {
      if (!ids.length) return;
      const factsStamp = ++clock.current;
      const facts = await loadFactsAll(member, ids);
      if (stale()) return;
      commit((cur) =>
        facts.ok
          ? applyFacts(
              cur,
              facts.rows.filter((r) => fresh(r.propertyId, factsStamp)),
              facts.missing.filter((id) => fresh(id, factsStamp)),
            )
          : { ...cur, error: facts.message },
      );
      if (facts.ok) {
        record(
          facts.rows.map((r) => r.propertyId),
          factsStamp,
        );
        record(facts.missing, factsStamp);
      }
    };
    if (!clamped && page.revision === s.revision) {
      commit((cur) => replaceInPlace(cur, page));
      recordPage(page, stamp);
      if (s.pinned && !s.order.includes(s.pinned.propertyId))
        await refreshFacts([s.pinned.propertyId]);
      return;
    }
    // Revision changed: keep what is on screen, take the counts, refresh the retained rows' facts.
    commit((cur) => markChanged(cur, page));
    if (stamp > viewAccepted.current) viewAccepted.current = stamp;
    const ids = [...s.order];
    if (s.pinned && !ids.includes(s.pinned.propertyId))
      ids.push(s.pinned.propertyId);
    await refreshFacts(ids);
  }, [
    commit,
    fresh,
    loadFactsAll,
    loadPageSafe,
    notify,
    reconcilePage,
    record,
    recordPage,
  ]);

  useEffect(() => {
    runReadRef.current = runRead;
  }, [runRead]);

  /** Timer / visibility entry point: respects hidden tab and paused composers. */
  const tick = useCallback(() => {
    if (document.hidden || pausedRef.current) {
      missedWhilePaused.current = true;
      return;
    }
    missedWhilePaused.current = false;
    void runRead();
  }, [runRead]);

  // Scope change: reset everything and reload. Keeps the committed search (the container owns it).
  const prevMember = useRef(memberId);
  useEffect(() => {
    if (prevMember.current === memberId) return;
    prevMember.current = memberId;
    memberRef.current = memberId;
    mutEpoch.current++;
    const query = { ...DEFAULT_QUERY, search: stateRef.current.query.search };
    stateRef.current = emptyState(query);
    setState(stateRef.current);
    notify(query, true);
    void runNav(query);
  }, [memberId, notify, runNav]);

  // 30 s tick plus visibility/focus return.
  const intervalMs = options.refreshIntervalMs ?? 30_000;
  useEffect(() => {
    const id = setInterval(tick, intervalMs);
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [intervalMs, tick]);

  // Clock-only transitions: re-armed after every accepted read.
  const { nextChangeAt, readCount } = state;
  useEffect(() => {
    if (!nextChangeAt) return;
    const now = optsRef.current.now ?? Date.now;
    const delay = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(MIN_BOUNDARY_MS, Date.parse(nextChangeAt) - now()),
    );
    const id = setTimeout(tick, delay);
    return () => clearTimeout(id);
  }, [nextChangeAt, readCount, tick]);

  // A refresh skipped while a composer was open runs once it closes.
  useEffect(() => {
    if (!paused && missedWhilePaused.current) tick();
  }, [paused, tick]);

  const changeQuery = useCallback(
    (patch: Partial<WorkQuery>) => {
      const s = stateRef.current;
      const query: WorkQuery = { ...s.query, ...patch, page: patch.page ?? 1 };
      if (queryKey(query) === queryKey(s.query)) return;
      commit((cur) => withQuery(cur, query));
      notify(query);
      void runNav(query);
    },
    [commit, notify, runNav],
  );

  const syncQuery = useCallback(
    (query: WorkQuery) => {
      if (queryKey(query) === queryKey(stateRef.current.query)) return;
      commit((cur) => withQuery(cur, query));
      void runNav(query);
    },
    [commit, runNav],
  );

  const afterAction = useCallback(
    async (propertyId: string) => {
      const nav0 = navSeq.current;
      const member = memberRef.current;
      mutEpoch.current++;
      try {
        const factsStamp = ++clock.current;
        const facts = await loadFactsAll(member, [propertyId]);
        if (nav0 !== navSeq.current) return;
        // A read that started later already landed facts for this lead: it owns the row.
        if (!fresh(propertyId, factsStamp)) return;
        if (!facts.ok) {
          commit((s) => ({ ...s, error: ACTION_READ_FAILED }));
          return;
        }
        const row = facts.rows.find((r) => r.propertyId === propertyId);
        propAccepted.current.set(propertyId, factsStamp);
        commit((s) => {
          const shown =
            s.order.includes(propertyId) || s.pinned?.propertyId === propertyId;
          if (!shown) return s;
          if (!row)
            return removeRows(s, [propertyId], "No longer in your queue");
          const decision = afterActionDecision(row, s.query);
          return decision.keep
            ? updateOne(s, row)
            : removeRows(updateOne(s, row), [propertyId], decision.notice);
        });
        // Counts only: the displayed list is never reordered by this read.
        const query = stateRef.current.query;
        const my = ++bgSeq.current;
        const stamp = ++clock.current;
        const res = await loadPageSafe(member, query);
        if (
          nav0 !== navSeq.current ||
          my !== bgSeq.current ||
          stamp < viewAccepted.current
        )
          return;
        if (res.ok) {
          const page = reconcilePage(res.page, stamp, stateRef.current);
          const cur = stateRef.current;
          const same =
            page.page === cur.query.page &&
            page.ids.length === cur.order.length &&
            page.ids.every((id, i) => id === cur.order[i]);
          commit((s) => applyCountsOnly(s, page));
          if (same) recordPage(page, stamp);
          else if (stamp > viewAccepted.current) viewAccepted.current = stamp;
        } else commit((s) => ({ ...s, error: res.message }));
      } finally {
        mutEpoch.current++;
      }
    },
    [commit, fresh, loadFactsAll, loadPageSafe, reconcilePage, recordPage],
  );

  const refresh = useCallback(
    () => void runNav(stateRef.current.query),
    [runNav],
  );

  const retryNow = useCallback(() => {
    const s = stateRef.current;
    if (s.displayedKey !== queryKey(s.query) || s.revision === null)
      void runNav(s.query);
    else void runRead();
  }, [runNav, runRead]);

  const rows = useMemo(() => visibleRows(state), [state]);

  return {
    query: state.query,
    rows,
    total: state.total,
    pageSize: state.pageSize,
    tabCounts: state.tabCounts,
    chipCounts: state.chipCounts,
    stageCounts: state.stageCounts,
    loading: state.loading,
    stale: state.stale,
    error: state.error,
    listUpdated: state.listUpdated,
    notice: state.notice,
    snapshotAt: state.snapshotAt,
    setTab: useCallback(
      (tab: WorkTab) => changeQuery({ tab, chip: "all" }),
      [changeQuery],
    ),
    setChip: useCallback(
      (chip: WorkChip) => changeQuery({ chip }),
      [changeQuery],
    ),
    setStage: useCallback(
      (stage: WorkStage | null) => changeQuery({ stage }),
      [changeQuery],
    ),
    setSearch: useCallback(
      (search: string) => changeQuery({ search }),
      [changeQuery],
    ),
    setPage: useCallback(
      (page: number) => changeQuery({ page }),
      [changeQuery],
    ),
    syncQuery,
    refresh,
    retryNow,
    afterAction,
    dismissNotice: useCallback(
      () => commit((s) => ({ ...s, notice: null })),
      [commit],
    ),
  };
}
