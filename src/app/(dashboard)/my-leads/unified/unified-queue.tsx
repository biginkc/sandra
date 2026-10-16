"use client";
/**
 * UnifiedQueue: the container of the unified My Leads work queue (design v8). MyLeadsClient renders it in place
 * of the sectioned queue when the unified_queue flag is on. It composes useWorkQueue (data, pagination, refresh),
 * WorkToolbar, WorkRow, WorkPagination and the banners, plus the KPI tiles.
 *
 * It owns no workflow: Call / Log attempt / Log offer / Dead / Archive ... are handed to `onAction`, which is
 * client.tsx's existing `action(kind, id)` (existing dialogs, softphone, Dialpad). After one of those commits,
 * client.tsx calls `handle.afterAction(id)` so the row is re-read. Everything server-side arrives through the
 * injected `actions` so tests and the synthetic browser harness can fake it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { AfterAttemptDripPicker } from "@/components/sequences/after-attempt-drip-picker";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { AcquisitionKpis, QueueRow } from "@/lib/my-leads/queries";
import { kpiTiles } from "../adapter";
import { MyLeadsMetrics } from "../_components/metrics";
import type { RepSmsComposerTarget } from "../rep-sms-composer";
import { StickyMyLeadsMetrics } from "../_components/sticky-metrics";
import type {
  MyLeadAction,
  MyLeadDetail,
  MyLeadDetailGroupName,
  MyLeadDetailPageResult,
  MyLeadDetailState,
  MyLeadRepOption,
} from "../_components/types";
import { AllTexts } from "./all-texts";
import { brokenTarget, messagesDeadLetterHref, normaReviewHref } from "./broken-target";
import { ConversationBox, type ConversationBoxState } from "./conversation-box";
import type {
  BrokenItem,
  LoadWorkFactsResult,
  LoadWorkPageResult,
  UnifiedActionFailure,
  UnifiedInitial,
  WorkChip,
  WorkFacts,
  WorkQuery,
  WorkStage,
  WorkTab,
} from "./contract";
import { ListUpdatedBanner, RowRemovedNotice } from "./list-updated-banner";
import { useWorkQueue, type QueryChangeOptions } from "./use-work-queue";
import { WorkPagination, totalPagesFor } from "./work-pagination";
import { WorkRow } from "./work-row";
import { WorkToolbar } from "./work-toolbar";

/** The server actions the container calls (unified-actions.ts in production). */
export type UnifiedQueueActions = {
  loadWorkPage: (input: { memberId: string; query: WorkQuery }) => Promise<LoadWorkPageResult>;
  loadWorkFacts: (input: { memberId: string; ids: string[] }) => Promise<LoadWorkFactsResult>;
  pinLead: (input: {
    memberId: string;
    propertyId: string;
    action: "pin" | "clear";
  }) => Promise<{ ok: true; pinnedAt: string | null } | UnifiedActionFailure>;
  dismissBroken: (input: { memberId: string; propertyId: string; sourceId: string }) => Promise<{ ok: true } | UnifiedActionFailure>;
  loadKpis?: (input: { memberId: string }) => Promise<{ ok: true; kpis: AcquisitionKpis } | UnifiedActionFailure>;
};

/** What client.tsx keeps to reach into the container (workflow commits, row lookups for `action()`). */
export type UnifiedQueueHandle = {
  /** Re-read one lead after a workflow committed (keeps or removes the row, refreshes counts). */
  afterAction: (propertyId: string) => Promise<void>;
  /** A background re-read of the displayed page (no specific lead known). */
  refreshNow: () => void;
  /** The queue row of a displayed (or deep-linked) lead; feeds the existing dialogs. */
  rowFor: (propertyId: string) => QueueRow | null;
  /** Browser Back/Forward: adopt the query parsed from the URL (loads it; does not write the URL). */
  syncQuery: (query: WorkQuery) => void;
};

export type UnifiedQueueProps = {
  initial: UnifiedInitial;
  actions: UnifiedQueueActions;
  /** The queue being viewed (the rep). */
  memberId: string;
  /** True when the viewer is looking at their own queue; an owner viewing a rep gets a read-only list. */
  canAct: boolean;
  canSelectRep: boolean;
  repOptions: readonly MyLeadRepOption[];
  selectedRepLabel?: string | null;
  onRepChange: (memberId: string) => void;
  /** A workflow dialog or opening banner is open in the host: background refreshes wait. */
  paused?: boolean;
  /** The deep-linked lead (starts expanded and scrolled into view once per navigation). */
  deepLinkId?: string | null;
  deepLinkNonce?: number;
  /** The rep changed the view (tab, chip, stage, search, page, rep): the host drops the deep link. */
  onViewChange?: () => void;
  /** The host syncs the URL. options.replace = not a rep-made change (page clamp, rep switch): do not add a history entry. */
  onQueryChange?: (query: WorkQuery, options?: QueryChangeOptions) => void;
  /** Stage commands and Call/Log attempt: the existing workflows in client.tsx. */
  onAction: (kind: MyLeadAction, propertyId: string) => void;
  onLoadDetailPage: (propertyId: string, group: MyLeadDetailGroupName, cursor: string | null) => Promise<MyLeadDetailPageResult>;
  /** Lets the host call afterAction / rowFor. */
  registerHandle?: (handle: UnifiedQueueHandle | null) => void;
  searchDebounceMs?: number;
  refreshIntervalMs?: number;
};

const NOTICE_MS = 8000;
const MAX_CONCURRENT_DETAILS = 3;
const KPI_REFRESH_MS = 60_000;
const EMPTY_GROUP = { rows: [], hasMore: false, nextCursor: null } as const;

function detailFromMessages(messages: MyLeadDetail["messages"]): MyLeadDetail {
  return { messages, notes: EMPTY_GROUP, attempts: EMPTY_GROUP, appointments: EMPTY_GROUP, offers: EMPTY_GROUP, history: EMPTY_GROUP };
}

function conversationState(state: MyLeadDetailState | undefined): ConversationBoxState {
  if (!state || state.status === "loading") return { status: "loading" };
  if (state.status === "error") return { status: "error", message: state.message };
  return {
    status: "ready",
    messages: state.detail.messages.rows.map((m) => ({ direction: m.direction, body: m.body, at: m.createdAt, automation: m.automation ?? null })),
  };
}

function openLeadWindow(propertyId: string) {
  window.open(`/leads/${propertyId}`, "_blank", "popup,width=1200,height=900,noopener,noreferrer");
}
function openRelatedWindow(href: string) {
  window.open(href, "_blank", "popup,width=1200,height=900,noopener,noreferrer");
}

export function UnifiedQueue({
  initial,
  actions,
  memberId,
  canAct,
  canSelectRep,
  repOptions,
  selectedRepLabel,
  onRepChange,
  paused = false,
  deepLinkId = null,
  deepLinkNonce = 0,
  onViewChange,
  onQueryChange,
  onAction,
  onLoadDetailPage,
  registerHandle,
  searchDebounceMs = 300,
  refreshIntervalMs,
}: UnifiedQueueProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(deepLinkId ? [deepLinkId] : []));
  const [textsOpen, setTextsOpen] = useState<ReadonlySet<string>>(new Set());
  // Rows whose all-texts thread was revealed by Reply / Send text: the composer starts open (and focused).
  const [composerOpen, setComposerOpen] = useState<ReadonlySet<string>>(new Set());
  // The Broken item whose record the composer was opened for (cleared by any other way of opening/closing the texts).
  const [composerTarget, setComposerTarget] = useState<Readonly<Record<string, RepSmsComposerTarget>>>({});
  const [dripFor, setDripFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState(initial.query.search);
  const [kpis, setKpis] = useState<AcquisitionKpis | null>(initial.kpis);
  const [details, setDetails] = useState<Readonly<Record<string, MyLeadDetailState>>>({});
  const [detailTick, setDetailTick] = useState(0);
  const [clock, setClock] = useState(() => Date.now());

  const loadPage = useCallback((member: string, query: WorkQuery) => actions.loadWorkPage({ memberId: member, query }), [actions]);
  const loadFacts = useCallback((member: string, ids: string[]) => actions.loadWorkFacts({ memberId: member, ids }), [actions]);

  const queue = useWorkQueue({
    initial,
    memberId,
    loadPage,
    loadFacts,
    paused: paused || textsOpen.size > 0 || dripFor !== null,
    onQueryChange,
    refreshIntervalMs,
  });
  const { rows, query } = queue;

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // Props that hosts pass as fresh closures: read through refs so effects and callbacks stay stable.
  const loadDetailPageRef = useRef(onLoadDetailPage);
  loadDetailPageRef.current = onLoadDetailPage;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // ---- clock: rows age together; a read also refreshes it.
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const { snapshotAt } = queue;
  useEffect(() => {
    if (snapshotAt) setClock(Date.now());
  }, [snapshotAt]);
  const now = useMemo(() => new Date(clock), [clock]);

  // ---- KPIs (the six activity tiles): reload for another rep, after a row action, and once a minute.
  const kpiSeq = useRef(0);
  const reloadKpis = useCallback(async () => {
    if (!actions.loadKpis) return;
    const seq = ++kpiSeq.current;
    try {
      const result = await actions.loadKpis({ memberId });
      if (seq === kpiSeq.current && mounted.current && result.ok) setKpis(result.kpis);
    } catch {
      /* the tiles keep their last values */
    }
  }, [actions, memberId]);
  const firstMember = useRef(memberId);
  useEffect(() => {
    if (firstMember.current === memberId) return;
    firstMember.current = memberId;
    setKpis(null);
    void reloadKpis();
  }, [memberId, reloadKpis]);
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) void reloadKpis();
    }, KPI_REFRESH_MS);
    return () => clearInterval(id);
  }, [reloadKpis]);
  const tiles = useMemo(() => (kpis ? kpiTiles(kpis) : null), [kpis]);
  const metricsRef = useRef<HTMLDivElement>(null);

  // ---- messages for expanded rows (at most three reads in flight)
  const requested = useRef(new Set<string>());
  const activeReads = useRef(0);
  const generation = useRef(0);
  const loadMessages = useCallback(
    async (propertyId: string) => {
      requested.current.add(propertyId);
      activeReads.current += 1;
      const gen = generation.current;
      setDetails((prev) => (prev[propertyId]?.status === "ready" ? prev : { ...prev, [propertyId]: { status: "loading" } }));
      try {
        const result = await loadDetailPageRef.current(propertyId, "messages", null);
        if (!mounted.current || gen !== generation.current) return;
        setDetails((prev) => ({
          ...prev,
          [propertyId]:
            result.ok && result.group === "messages"
              ? { status: "ready", detail: detailFromMessages(result.page) }
              : { status: "error", message: result.ok ? "Texts unavailable." : result.message },
        }));
      } catch (error) {
        if (!mounted.current || gen !== generation.current) return;
        setDetails((prev) => ({
          ...prev,
          [propertyId]: { status: "error", message: error instanceof Error ? error.message : "Unable to load texts." },
        }));
      } finally {
        activeReads.current -= 1;
        if (mounted.current) setDetailTick((t) => t + 1);
      }
    },
    [],
  );
  const shownIds = useMemo(() => rows.map((r) => r.facts.propertyId).join("|"), [rows]);
  useEffect(() => {
    const shown = new Set(shownIds ? shownIds.split("|") : []);
    for (const id of expanded) {
      if (activeReads.current >= MAX_CONCURRENT_DETAILS) break;
      if (shown.has(id) && !requested.current.has(id)) void loadMessages(id);
    }
  }, [expanded, shownIds, detailTick, loadMessages]);

  const reloadMessages = useCallback((propertyId: string) => {
    requested.current.delete(propertyId);
    setDetailTick((t) => t + 1);
  }, []);

  // Another rep: nothing of the old rep's texts may show.
  const firstDetailMember = useRef(memberId);
  useEffect(() => {
    if (firstDetailMember.current === memberId) return;
    firstDetailMember.current = memberId;
    generation.current += 1;
    requested.current.clear();
    setDetails({});
    setExpanded(new Set());
    setTextsOpen(new Set());
  }, [memberId]);

  // ---- the host's handle
  const { afterAction: hookAfterAction, retryNow, syncQuery: hookSyncQuery } = queue;
  const afterAction = useCallback(
    async (propertyId: string) => {
      reloadMessages(propertyId);
      void reloadKpis();
      await hookAfterAction(propertyId);
    },
    [hookAfterAction, reloadKpis, reloadMessages],
  );
  const syncQueryRef = useRef<(query: WorkQuery) => void>(() => {});
  const syncFromUrl = useCallback((next: WorkQuery) => syncQueryRef.current(next), []);
  useEffect(() => {
    if (!registerHandle) return;
    registerHandle({
      afterAction,
      refreshNow: retryNow,
      rowFor: (propertyId) => rowsRef.current.find((r) => r.facts.propertyId === propertyId)?.facts.row ?? null,
      syncQuery: syncFromUrl,
    });
    return () => registerHandle(null);
  }, [registerHandle, afterAction, retryNow, syncFromUrl]);

  // ---- notice timeout
  const { notice, dismissNotice } = queue;
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(dismissNotice, NOTICE_MS);
    return () => clearTimeout(id);
  }, [notice, dismissNotice]);

  // ---- deep link: starts expanded (initial state), re-expands on a new navigation, scrolls once.
  const handledLink = useRef(deepLinkId ? `${deepLinkId}:${deepLinkNonce}` : null);
  useEffect(() => {
    if (!deepLinkId) {
      handledLink.current = null;
      return;
    }
    const key = `${deepLinkId}:${deepLinkNonce}`;
    if (handledLink.current === key) return;
    handledLink.current = key;
    setExpanded((prev) => new Set(prev).add(deepLinkId));
  }, [deepLinkId, deepLinkNonce]);
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!deepLinkId) {
      scrolledFor.current = null;
      return;
    }
    const key = `${deepLinkId}:${deepLinkNonce}`;
    if (scrolledFor.current === key) return;
    const element = document.querySelector(`[data-lead-id="${CSS.escape(deepLinkId)}"]`);
    if (!element) return;
    scrolledFor.current = key;
    element.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [deepLinkId, deepLinkNonce, rows]);

  // ---- view changes
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    },
    [],
  );
  const viewChanged = useCallback(() => {
    onViewChange?.();
    setExpanded(new Set());
    setTextsOpen(new Set());
  }, [onViewChange]);
  // Back/Forward: the URL already holds this view, so the box, expanded rows and deep link follow it and nothing is written back.
  syncQueryRef.current = (next: WorkQuery) => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setSearchText(next.search);
    viewChanged();
    hookSyncQuery(next);
  };
  const changeTab = (tab: WorkTab) => {
    viewChanged();
    queue.setTab(tab);
  };
  const changeChip = (chip: WorkChip) => {
    viewChanged();
    queue.setChip(chip);
  };
  const changeStage = (stage: WorkStage | null) => {
    viewChanged();
    queue.setStage(stage);
  };
  const changePage = (page: number) => {
    viewChanged();
    queue.setPage(page);
  };
  const changeSearch = (value: string) => {
    setSearchText(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      viewChanged();
      queue.setSearch(value.trim());
    }, searchDebounceMs);
  };

  // ---- expand / collapse
  const allExpanded = rows.length > 0 && rows.every((r) => expanded.has(r.facts.propertyId));
  const toggleAll = () => setExpanded(allExpanded ? new Set() : new Set(rows.map((r) => r.facts.propertyId)));
  const toggleOne = (propertyId: string) => {
    const next = new Set(expanded);
    if (next.has(propertyId)) {
      next.delete(propertyId);
      closeTexts(propertyId);
    } else next.add(propertyId);
    setExpanded(next);
  };

  const setTarget = (propertyId: string, target: RepSmsComposerTarget | null) =>
    setComposerTarget((prev) => {
      if (!target && !(propertyId in prev)) return prev;
      const next = { ...prev };
      if (target) next[propertyId] = target;
      else delete next[propertyId];
      return next;
    });
  const openTexts = (propertyId: string, withComposer = false, target: RepSmsComposerTarget | null = null) => {
    setTarget(propertyId, target);
    if (withComposer) setComposerOpen((prev) => new Set(prev).add(propertyId));
    setExpanded((prev) => new Set(prev).add(propertyId));
    setTextsOpen((prev) => new Set(prev).add(propertyId));
  };
  const closeTexts = (propertyId: string) => {
    setTarget(propertyId, null);
    setComposerOpen((prev) => {
      if (!prev.has(propertyId)) return prev;
      const next = new Set(prev);
      next.delete(propertyId);
      return next;
    });
    setTextsOpen((prev) => {
      const next = new Set(prev);
      next.delete(propertyId);
      return next;
    });
  };

  // ---- actions on a row
  const withBusy = async (propertyId: string, work: () => Promise<void>) => {
    setBusy((prev) => new Set(prev).add(propertyId));
    setActionError(null);
    try {
      await work();
    } finally {
      if (mounted.current)
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(propertyId);
          return next;
        });
    }
  };
  const pin = (propertyId: string, action: "pin" | "clear") =>
    withBusy(propertyId, async () => {
      try {
        const result = await actions.pinLead({ memberId, propertyId, action });
        if (!result.ok) {
          setActionError(result.message);
          return;
        }
        await afterAction(propertyId);
      } catch {
        setActionError("The change could not be saved. Please retry.");
      }
    });
  const dismiss = (propertyId: string, sourceId: string) =>
    withBusy(propertyId, async () => {
      try {
        const result = await actions.dismissBroken({ memberId, propertyId, sourceId });
        if (!result.ok) {
          setActionError(result.message);
          return;
        }
        await afterAction(propertyId);
      } catch {
        setActionError("The change could not be saved. Please retry.");
      }
    });
  // Each fix routes to an existing workflow and carries the item's {sourceKind, refId}: the composer loads THAT ledger
  // receipt / obligation / message (a lead can have several failures) and resumes, resends (prefilled, new submission key)
  // or checks it. AI dead letters and Norma review open the surfaces that already handle them by id.
  const brokenAction = (item: BrokenItem, propertyId: string) => {
    switch (item.action) {
      case "send_text":
      case "resend":
      case "check_status":
        openTexts(propertyId, true, brokenTarget(item));
        break;
      case "review":
        if (item.kind === "ai_reply_failed") openRelatedWindow(messagesDeadLetterHref(item.refId, propertyId));
        else if (item.kind === "norma_needs_review") openRelatedWindow(normaReviewHref(item.refId, propertyId));
        else openTexts(propertyId, true, brokenTarget(item));
        break;
      case "fix_drip":
      case "open_campaign":
        // No in-page fixer exists; the lead page holds the drip and campaign controls.
        openLeadWindow(propertyId);
        break;
    }
  };

  // ---- detail paging inside the all-texts thread
  const loadTextsPage = async (propertyId: string, group: MyLeadDetailGroupName, cursor: string | null) => {
    const result = await loadDetailPageRef.current(propertyId, group, cursor);
    if (mounted.current && result.ok && result.group === "messages" && group === "messages") {
      setDetails((prev) => {
        const current = prev[propertyId];
        if (!current || current.status !== "ready") return prev;
        const page = result.page;
        const merged =
          cursor === null
            ? page
            : {
                rows: [...current.detail.messages.rows, ...page.rows.filter((m) => !current.detail.messages.rows.some((x) => x.id === m.id))],
                hasMore: page.hasMore,
                nextCursor: page.nextCursor,
              };
        return { ...prev, [propertyId]: { status: "ready", detail: { ...current.detail, messages: merged } } };
      });
    }
    return result;
  };

  const conversationFor = (facts: WorkFacts) => {
    const id = facts.propertyId;
    const state = details[id];
    return (
      <div className="space-y-3">
        <ConversationBox
          propertyId={id}
          state={conversationState(state)}
          now={now}
          unanswered={facts.latestInbound ? !facts.latestInbound.handled : undefined}
          onShowAll={() => openTexts(id)}
          onRetry={() => reloadMessages(id)}
        />
        {textsOpen.has(id) && (
          <div className="space-y-2">
            <AllTexts
              key={`${composerOpen.has(id) ? "composer-open" : "composer-closed"}:${composerTarget[id]?.sourceKind ?? ""}:${composerTarget[id]?.refId ?? ""}`}
              facts={facts}
              defaultOpen={composerOpen.has(id)}
              target={composerTarget[id]}
              canCompose={canAct}
              state={state ?? { status: "loading" }}
              onRetry={() => reloadMessages(id)}
              onLoadDetailPage={(group, cursor) => loadTextsPage(id, group, cursor)}
              onSent={() => void afterAction(id)}
            />
            <Button type="button" variant="ghost" size="xs" data-testid={`all-texts-hide-${id}`} onClick={() => closeTexts(id)}>
              Hide texts
            </Button>
          </div>
        )}
      </div>
    );
  };

  const totalPages = totalPagesFor(queue.total, queue.pageSize);
  // Empty states are the owner's strings; a filtered view with no search has none of its own, so it keeps a neutral line.
  const unfiltered = query.chip === "all" && !query.stage;
  const emptyText = query.search
    ? `No leads match \u201c${query.search}\u201d.`
    : !unfiltered
      ? "No leads here."
      : query.tab === "needs_attention"
        ? "Nothing needs you right now."
        : query.tab === "waiting"
          ? "Nothing is waiting on them."
          : "No leads in your queue.";
  const waitingCount = queue.tabCounts.waiting;
  const emptyHint =
    !query.search && unfiltered && query.tab === "needs_attention" && waitingCount > 0
      ? waitingCount === 1
        ? "1 lead is waiting on them."
        : `${waitingCount} leads are waiting on them.`
      : null;
  const showEmpty = !queue.loading && rows.length === 0 && !queue.error;

  return (
    <div className="flex w-full flex-col gap-8">
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "My Leads" }]}
        title="My Leads"
        description={`${selectedRepLabel || "Your queue"} · Acquisitions`}
        actions={
          <div className="flex max-w-full flex-wrap items-center gap-2.5">
            {canSelectRep && (
              <>
                <label className="sr-only" htmlFor="my-leads-rep">
                  Acquisitions member
                </label>
                <span className="relative inline-flex max-w-full min-w-0">
                  <select
                    id="my-leads-rep"
                    aria-label="Acquisitions member"
                    value={memberId}
                    onChange={(event) => onRepChange(event.target.value)}
                    className="h-9 max-w-full min-w-0 appearance-none rounded-[10px] border border-border bg-card py-2 pr-7 pl-3 text-[12.5px] font-semibold text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {repOptions.map((rep) => (
                      <option key={rep.id} value={rep.id}>
                        {rep.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                </span>
              </>
            )}
          </div>
        }
      />

      {tiles && (
        <>
          <div ref={metricsRef}>
            <MyLeadsMetrics kpis={tiles} repliedToDrip={0} hideAttention />
          </div>
          <StickyMyLeadsMetrics kpis={tiles} expandedRef={metricsRef} repLabel={selectedRepLabel} repliedToDrip={0} hideAttention />
        </>
      )}

      <div className="space-y-4">
        <WorkToolbar
          tab={query.tab}
          chip={query.chip}
          stage={query.stage}
          search={searchText}
          tabCounts={queue.tabCounts}
          chipCounts={queue.chipCounts}
          stageCounts={queue.stageCounts}
          allExpanded={allExpanded}
          onTabChange={changeTab}
          onChipChange={changeChip}
          onStageChange={changeStage}
          onSearchChange={changeSearch}
          onToggleAll={toggleAll}
        />

        {queue.error && (
          <div role="alert" data-testid="work-error" className="rounded border border-destructive p-3 text-sm text-destructive">
            {queue.error} Displayed counts may be out of date. Retrying automatically.{" "}
            <Button type="button" variant="outline" size="sm" onClick={queue.retryNow}>
              Retry now
            </Button>{" "}
            <Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>
              Reload and reconnect
            </Button>
          </div>
        )}
        {actionError && (
          <div role="alert" data-testid="work-action-error" className="flex items-center gap-2 rounded border border-destructive p-3 text-sm text-destructive">
            <span className="min-w-0 flex-1">{actionError}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => setActionError(null)}>
              Dismiss
            </Button>
          </div>
        )}
        {queue.listUpdated && <ListUpdatedBanner refreshing={queue.loading} onRefresh={queue.refresh} />}
        {queue.notice && <RowRemovedNotice message={queue.notice} onDismiss={queue.dismissNotice} />}

        {queue.loading && rows.length === 0 && (
          <p role="status" className="text-sm text-muted-foreground" data-testid="work-loading">
            Loading leads…
          </p>
        )}
        {showEmpty && (
          <p className="rounded-[10px] border border-dashed border-border p-5 text-center text-sm text-muted-foreground" data-testid="work-empty">
            {emptyText}
            {emptyHint && (
              <span className="mt-1 block" data-testid="work-empty-hint">
                {emptyHint}
              </span>
            )}
          </p>
        )}

        <div className="flex flex-col gap-3" aria-busy={queue.loading || undefined} data-loading={queue.loading || undefined}>
          {rows.map(({ facts, leftView, pinned }) => {
            const id = facts.propertyId;
            return (
              <div key={id} className={leftView || queue.loading || queue.stale ? "opacity-60 transition-opacity" : undefined} data-left-view={leftView || undefined}>
                <WorkRow
                  facts={facts}
                  now={now}
                  expanded={expanded.has(id)}
                  canAct={canAct}
                  busy={busy.has(id)}
                  openedFromLead={pinned}
                  conversation={conversationFor(facts)}
                  onToggle={() => toggleOne(id)}
                  onAction={onAction}
                  onOpenText={(leadId) => openTexts(leadId, true)}
                  onCallToday={(leadId) => void pin(leadId, "pin")}
                  onUndoCallToday={(leadId) => void pin(leadId, "clear")}
                  onSetDrip={setDripFor}
                  onBrokenAction={brokenAction}
                  onDismissBroken={(leadId, refId) => void dismiss(leadId, refId)}
                />
              </div>
            );
          })}
        </div>

        <WorkPagination page={query.page} totalPages={totalPages} loading={queue.loading} onPageChange={changePage} />
      </div>

      <Dialog open={dripFor !== null} onOpenChange={(open) => { if (!open) setDripFor(null); }}>
        <DialogContent>
          <DialogTitle>Set drip</DialogTitle>
          <DialogDescription>Choose the drip this lead should be in.</DialogDescription>
          {dripFor && (
            <AfterAttemptDripPicker
              key={dripFor}
              propertyId={dripFor}
              onDripChanged={() => void afterAction(dripFor)}
              onEnrolled={() => setDripFor(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
