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
 * Concurrency: every page load carries a sequence number; "navigation" loads (query change, Refresh, member change)
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

const fail = (message: string): UnifiedActionFailure => ({ ok: false, message });

type FactsRead = { ok: true; rows: WorkFacts[]; missing: string[] } | UnifiedActionFailure;

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
  // Per-property facts sequence: a facts response only lands for a property if no newer facts read for it has started.
  const factsSeq = useRef(new Map<string, number>());

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

  const loadPageSafe = useCallback(async (member: string, query: WorkQuery): Promise<LoadWorkPageResult> => {
    try {
      return await optsRef.current.loadPage(member, query);
    } catch {
      return fail(READ_FAILED);
    }
  }, []);

  const loadFactsAll = useCallback(async (member: string, ids: string[]): Promise<FactsRead> => {
    try {
      const results = await Promise.all(chunk(ids).map((c) => optsRef.current.loadFacts(member, c)));
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
  }, []);

  const claimFacts = useCallback((ids: string[]) => {
    const claim = new Map<string, number>();
    for (const id of ids) {
      const n = (factsSeq.current.get(id) ?? 0) + 1;
      factsSeq.current.set(id, n);
      claim.set(id, n);
    }
    return claim;
  }, []);
  const stillCurrent = (claim: Map<string, number>, id: string) => factsSeq.current.get(id) === claim.get(id);

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
      const res = await loadPageSafe(memberRef.current, query);
      if (seq !== navSeq.current) return;
      navInFlight.current = false;
      if (!res.ok) {
        commit((s) => ({ ...s, loading: false, stale: s.order.length > 0 || s.pinned !== null, error: res.message }));
        return;
      }
      commit((s) => swapIn(s, res.page, query));
      if (res.page.page !== query.page) notify({ ...query, page: res.page.page }, true);
    },
    [commit, loadPageSafe, notify],
  );

  /** Background read: re-run the page read with the current query and fold it into the displayed list. */
  const runRead = useCallback(async () => {
    if (navInFlight.current) return;
    const nav0 = navSeq.current;
    const mut0 = mutEpoch.current;
    const my = ++bgSeq.current;
    const member = memberRef.current;
    const query = stateRef.current.query;
    const stale = () => nav0 !== navSeq.current || mut0 !== mutEpoch.current || my !== bgSeq.current;
    const res = await loadPageSafe(member, query);
    if (stale()) return;
    if (!res.ok) {
      commit((s) => ({ ...s, error: res.message }));
      return;
    }
    const page = res.page;
    const s = stateRef.current;
    const clamped = page.page !== query.page;
    if (s.displayedKey !== queryKey(query) || s.revision === null) {
      // Nothing (or a different query) is on screen: this read IS the list.
      commit((cur) => swapIn(cur, page, query));
      if (clamped) notify({ ...query, page: page.page }, true);
      return;
    }
    if (!clamped && page.revision === s.revision) {
      commit((cur) => replaceInPlace(cur, page));
      return;
    }
    // Revision changed: keep what is on screen, take the counts, refresh the retained rows' facts.
    commit((cur) => markChanged(cur, page));
    const ids = [...s.order];
    if (s.pinned && !ids.includes(s.pinned.propertyId)) ids.push(s.pinned.propertyId);
    if (!ids.length) return;
    const claim = claimFacts(ids);
    const facts = await loadFactsAll(member, ids);
    if (stale()) return;
    commit((cur) =>
      facts.ok
        ? applyFacts(
            cur,
            facts.rows.filter((r) => stillCurrent(claim, r.propertyId)),
            facts.missing.filter((id) => stillCurrent(claim, id)),
          )
        : { ...cur, error: facts.message },
    );
  }, [claimFacts, commit, loadFactsAll, loadPageSafe, notify]);

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
    const delay = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_BOUNDARY_MS, Date.parse(nextChangeAt) - now()));
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
        const claim = claimFacts([propertyId]);
        const facts = await loadFactsAll(member, [propertyId]);
        if (nav0 !== navSeq.current) return;
        // A newer facts read for this lead started while this one was in flight: it owns the row.
        if (!stillCurrent(claim, propertyId)) return;
        if (!facts.ok) {
          commit((s) => ({ ...s, error: ACTION_READ_FAILED }));
          return;
        }
        const row = facts.rows.find((r) => r.propertyId === propertyId);
        commit((s) => {
          const shown = s.order.includes(propertyId) || s.pinned?.propertyId === propertyId;
          if (!shown) return s;
          if (!row) return removeRows(s, [propertyId], "No longer in your queue");
          const decision = afterActionDecision(row, s.query);
          return decision.keep
            ? updateOne(s, row)
            : removeRows(updateOne(s, row), [propertyId], decision.notice);
        });
        // Counts only: the displayed list is never reordered by this read.
        const query = stateRef.current.query;
        const my = ++bgSeq.current;
        const res = await loadPageSafe(member, query);
        if (nav0 !== navSeq.current || my !== bgSeq.current) return;
        if (res.ok) commit((s) => applyCountsOnly(s, res.page));
        else commit((s) => ({ ...s, error: res.message }));
      } finally {
        mutEpoch.current++;
      }
    },
    [claimFacts, commit, loadFactsAll, loadPageSafe],
  );

  const refresh = useCallback(() => void runNav(stateRef.current.query), [runNav]);

  const retryNow = useCallback(() => {
    const s = stateRef.current;
    if (s.displayedKey !== queryKey(s.query) || s.revision === null) void runNav(s.query);
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
    setTab: useCallback((tab: WorkTab) => changeQuery({ tab, chip: "all" }), [changeQuery]),
    setChip: useCallback((chip: WorkChip) => changeQuery({ chip }), [changeQuery]),
    setStage: useCallback((stage: WorkStage | null) => changeQuery({ stage }), [changeQuery]),
    setSearch: useCallback((search: string) => changeQuery({ search }), [changeQuery]),
    setPage: useCallback((page: number) => changeQuery({ page }), [changeQuery]),
    syncQuery,
    refresh,
    retryNow,
    afterAction,
    dismissNotice: useCallback(() => commit((s) => ({ ...s, notice: null })), [commit]),
  };
}
