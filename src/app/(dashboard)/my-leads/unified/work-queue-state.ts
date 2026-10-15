/**
 * Pure state and transitions for the unified work queue's pagination/refresh contract
 * (design v8 section 6). No React, no I/O: use-work-queue.ts owns timing, sequencing and the loaders and
 * calls these to compute the next state.
 *
 * Counts rule: tabCounts, chipCounts and stageCounts are always taken together from ONE page response
 * (the newest accepted read) and never mixed across responses. The rows on screen can be older than the
 * counts only while the list is "retained" (listUpdated is set, or a row was removed after an action).
 */
import {
  WORK_TAB_LABELS,
  type WorkChip,
  type WorkFacts,
  type WorkPage,
  type WorkPlace,
  type WorkQuery,
  type WorkReason,
  type WorkStage,
  type WorkTab,
  type UnifiedInitial,
} from "./contract";

/** Facts reads are chunked so no call exceeds the server's 50-id limit. */
export const FACTS_CHUNK = 50;

export type ListUpdated = { total: number; counts: Record<WorkTab, number> };

export type WorkState = {
  /** The query the user asked for (drives the next read). */
  query: WorkQuery;
  /** Key of the query whose page is on screen; null before the first good read. May lag `query` after a failed load. */
  displayedKey: string | null;
  /** Displayed ids in order (the pinned lead is NOT included unless it is also on the page). */
  order: string[];
  facts: Record<string, WorkFacts>;
  /** Retained rows whose placement no longer matches tab/chip/stage; greyed until the user Refreshes. */
  leftView: string[];
  pinned: WorkFacts | null;
  /** Total and page size of the DISPLAYED page (drive the page numbers). */
  total: number;
  pageSize: number;
  tabCounts: Record<WorkTab, number>;
  chipCounts: Partial<Record<WorkReason, number>>;
  stageCounts: Partial<Record<WorkStage, number>>;
  /** Revision of the displayed list (null before the first good read). */
  revision: string | null;
  nextChangeAt: string | null;
  snapshotAt: string | null;
  /** Bumped by every accepted read so the clock timer re-arms even when nextChangeAt is unchanged. */
  readCount: number;
  loading: boolean;
  error: string | null;
  notice: string | null;
  listUpdated: ListUpdated | null;
};

export type DisplayRow = { facts: WorkFacts; leftView: boolean; pinned: boolean };

export const ZERO_TAB_COUNTS: Record<WorkTab, number> = { needs_attention: 0, waiting: 0, all: 0 };

export const DEFAULT_QUERY: WorkQuery = { tab: "needs_attention", chip: "all", stage: null, search: "", page: 1 };

export const queryKey = (q: WorkQuery) => JSON.stringify([q.tab, q.chip, q.stage, q.search, q.page]);

export function emptyState(query: WorkQuery): WorkState {
  return {
    query,
    displayedKey: null,
    order: [],
    facts: {},
    leftView: [],
    pinned: null,
    total: 0,
    pageSize: 25,
    tabCounts: { ...ZERO_TAB_COUNTS },
    chipCounts: {},
    stageCounts: {},
    revision: null,
    nextChangeAt: null,
    snapshotAt: null,
    readCount: 0,
    loading: false,
    error: null,
    notice: null,
    listUpdated: null,
  };
}

export function initialState(initial: UnifiedInitial): WorkState {
  const base = { ...emptyState(initial.query), pinned: initial.pinned, error: initial.error };
  return initial.page ? { ...swapIn(base, initial.page, initial.query), error: initial.error } : base;
}

export const tabForPlace = (place: WorkPlace): WorkTab =>
  place === "your_move" ? "needs_attention" : place === "their_move" ? "waiting" : "all";

/** Whether a lead's current placement belongs in the view the user is looking at. Search cannot be judged client-side. */
export function placementMatches(facts: WorkFacts, query: WorkQuery): boolean {
  if (query.tab === "needs_attention" && facts.place !== "your_move") return false;
  if (query.tab === "waiting" && facts.place !== "their_move") return false;
  if (query.chip !== "all" && facts.reason !== query.chip) return false;
  if (query.stage && facts.stage !== query.stage) return false;
  return true;
}

/** Keep or remove a row after the rep acts, with the one-line notice when it goes. */
export function afterActionDecision(
  facts: WorkFacts,
  query: WorkQuery,
): { keep: true } | { keep: false; notice: string } {
  if (placementMatches(facts, query)) return { keep: true };
  const dest = tabForPlace(facts.place);
  return {
    keep: false,
    notice: dest !== query.tab ? `Moved to ${WORK_TAB_LABELS[dest]}` : "Moved out of this view", // same tab, other chip/stage: the owner gave no line
  };
}

export function chunk<T>(items: T[], size = FACTS_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A user-driven query change: new query, pinned lead dropped, notice and leftover flags cleared, loading until the read lands. */
export function withQuery(state: WorkState, query: WorkQuery): WorkState {
  return { ...state, query, pinned: null, notice: null, loading: true };
}

/** Page-level fields that always come from one response, together. */
function pageLevel(state: WorkState, page: WorkPage): WorkState {
  return {
    ...state,
    tabCounts: page.tabCounts,
    chipCounts: page.chipCounts,
    stageCounts: page.stageCounts,
    nextChangeAt: page.nextChangeAt,
    snapshotAt: page.snapshotAt,
    readCount: state.readCount + 1,
    error: null,
  };
}

function factsById(rows: WorkFacts[]) {
  const map: Record<string, WorkFacts> = {};
  for (const r of rows) map[r.propertyId] = r;
  return map;
}

const refreshPinned = (pinned: WorkFacts | null, byId: Record<string, WorkFacts>) =>
  pinned && byId[pinned.propertyId] ? byId[pinned.propertyId] : pinned;

/**
 * Swap in a freshly read page as the displayed list (first load, query change, Refresh, member change).
 * Adopts the server's page when it clamped the request (total shrank) and clears listUpdated/leftView.
 */
export function swapIn(state: WorkState, page: WorkPage, requested: WorkQuery): WorkState {
  const query = page.page !== requested.page ? { ...requested, page: page.page } : requested;
  const byId = factsById(page.rows);
  return {
    ...pageLevel(state, page),
    query,
    displayedKey: queryKey(query),
    order: page.ids.filter((id) => byId[id]),
    facts: byId,
    leftView: [],
    pinned: refreshPinned(state.pinned, byId),
    total: page.total,
    pageSize: page.pageSize,
    revision: page.revision,
    listUpdated: null,
    loading: false,
  };
}

/** Same revision: only the facts changed, so replace them in place and keep the order. */
export function replaceInPlace(state: WorkState, page: WorkPage): WorkState {
  const byId = factsById(page.rows);
  const facts = { ...state.facts };
  for (const id of state.order) if (byId[id]) facts[id] = byId[id];
  return {
    ...pageLevel(state, page),
    facts,
    leftView: [],
    pinned: refreshPinned(state.pinned, byId),
    total: page.total,
    pageSize: page.pageSize,
    listUpdated: null,
  };
}

/** Revision changed: keep the displayed ids, take the new counts, and offer "List updated · Refresh". */
export function markChanged(state: WorkState, page: WorkPage): WorkState {
  return { ...pageLevel(state, page), listUpdated: { total: page.total, counts: page.tabCounts } };
}

/**
 * Counts-only application after a rep action. If the page read matches what is on screen the list is
 * in sync (adopt revision/total, no banner); otherwise offer "List updated" without reordering anything.
 */
export function applyCountsOnly(state: WorkState, page: WorkPage): WorkState {
  const same =
    page.page === state.query.page &&
    page.ids.length === state.order.length &&
    page.ids.every((id, i) => id === state.order[i]);
  if (!same) return markChanged(state, page);
  const byId = factsById(page.rows);
  const facts = { ...state.facts };
  for (const id of state.order) if (byId[id]) facts[id] = byId[id];
  return {
    ...pageLevel(state, page),
    facts,
    leftView: state.leftView,
    revision: page.revision,
    total: page.total,
    pageSize: page.pageSize,
    listUpdated: null,
  };
}

/** Remove a row from the displayed list (and the pinned slot), optionally setting a notice. */
export function removeRows(state: WorkState, ids: string[], notice: string | null): WorkState {
  if (!ids.length) return state;
  const gone = new Set(ids);
  const facts = { ...state.facts };
  for (const id of ids) delete facts[id];
  return {
    ...state,
    order: state.order.filter((id) => !gone.has(id)),
    facts,
    leftView: state.leftView.filter((id) => !gone.has(id)),
    pinned: state.pinned && gone.has(state.pinned.propertyId) ? null : state.pinned,
    notice: notice ?? state.notice,
  };
}

const NO_LONGER_IN_QUEUE = "No longer in your queue";
const missingNotice = () => NO_LONGER_IN_QUEUE;

/**
 * Apply facts for retained rows (and the pinned lead). Updated text/icons/buttons land in place; rows
 * whose placement left the view are flagged leftView (NOT removed); rows the server no longer knows are
 * removed with a notice; a pinned lead that left its tab or vanished is dropped.
 */
export function applyFacts(state: WorkState, rows: WorkFacts[], missing: string[]): WorkState {
  const byId = factsById(rows);
  const shown = new Set(state.order);
  const facts = { ...state.facts };
  for (const id of state.order) if (byId[id]) facts[id] = byId[id];
  const leftView = state.order.filter((id) => facts[id] && !placementMatches(facts[id], state.query));
  let pinned = refreshPinned(state.pinned, byId);
  if (pinned && tabForPlace(pinned.place) !== state.query.tab) pinned = null;
  const gone = missing.filter((id) => shown.has(id) || id === state.pinned?.propertyId);
  const next: WorkState = { ...state, facts, leftView, pinned };
  return removeRows(next, gone, gone.length ? missingNotice() : null);
}

/** One lead's new facts after a rep action (already decided keep/remove by the caller). */
export function updateOne(state: WorkState, facts: WorkFacts): WorkState {
  const id = facts.propertyId;
  const next: WorkState = { ...state };
  if (state.facts[id]) next.facts = { ...state.facts, [id]: facts };
  if (state.pinned?.propertyId === id) next.pinned = tabForPlace(facts.place) === state.query.tab ? facts : null;
  next.leftView = state.leftView.filter((x) => x !== id);
  return next;
}

/** What the page renders: the pinned lead first (once), then the page in order. */
export function visibleRows(state: WorkState): DisplayRow[] {
  const left = new Set(state.leftView);
  const out: DisplayRow[] = [];
  const pinned = state.pinned && tabForPlace(state.pinned.place) === state.query.tab ? state.pinned : null;
  if (pinned) out.push({ facts: pinned, leftView: false, pinned: true });
  for (const id of state.order) {
    if (pinned && id === pinned.propertyId) continue;
    const facts = state.facts[id];
    if (facts) out.push({ facts, leftView: left.has(id), pinned: false });
  }
  return out;
}

/** Re-exported for the container. */
export type { WorkChip };
