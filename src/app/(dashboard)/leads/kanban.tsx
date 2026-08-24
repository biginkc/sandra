"use client";

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CalendarClockIcon, ChevronDownIcon, ChevronRightIcon, SearchIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SoftphoneLeadButton } from "@/components/softphone/softphone-lead-button";
import type { SoftphoneLead } from "@/components/softphone/softphone-provider";
import { callAction } from "@/lib/errors/call-action";
import { canShowCallButton } from "@/lib/dialer/eligibility";
import type { Database } from "@/lib/supabase/types";

import {
  updatePropertyStatus,
  type PropertyStatus,
  type TeamMember,
} from "./actions";
import {
  DEFAULT_COLLAPSED_STATUSES,
  STATUS_ACCENT,
  STATUS_LABEL,
  STATUS_ORDER,
} from "./board-config";
import { filterLeads } from "./filter";
import type {
  InboundAttentionFilter,
  InboundOwnershipFilter,
} from "./inbound-filters";
import {
  loadLeadBoardAction,
  setLeadNextActionAction,
} from "./board-actions";
import type {
  CustomTag,
  LeadBoardCursor,
  LeadBoardData,
  LeadBoardFilters,
  LeadBoardLead,
  ListMembership,
} from "./board-query";
import {
  compareLeadUrgency,
  formatNextAction,
  matchesUrgencyFilter,
  type UrgencyFilter,
} from "./urgency";

type ContactSummary = Pick<
  Database["public"]["Tables"]["contacts"]["Row"],
  "first_name" | "last_name" | "entity_name"
> & Partial<Pick<
  Database["public"]["Tables"]["contacts"]["Row"],
  "id" | "phone_1" | "phone_2" | "phone_3" | "do_not_contact" | "sms_opted_out"
>>;

export type Lead = LeadBoardLead;

export type LastMessage = {
  direction: "inbound" | "outbound";
  body: string;
  createdAt: string;
};

type MotivationLevel = "hot" | "warm" | "cold";
type MotivationFilter = MotivationLevel | "unset" | "all";
type OwnershipFilter = InboundOwnershipFilter;
type AttentionFilter = InboundAttentionFilter | null;

type MoveFailure = {
  attemptedStatus: PropertyStatus;
  previousStatus: PropertyStatus;
};

const COLLAPSED_STORAGE_KEY = "sandra.leads.collapsed";
const ALL_PROPERTY_STATUSES: readonly PropertyStatus[] = [
  "prospect",
  ...STATUS_ORDER,
];

const MOTIVATION_DOT: Record<MotivationLevel, string> = {
  hot: "bg-red-500",
  warm: "bg-amber-500",
  cold: "bg-blue-500",
};

const MOTIVATION_LABEL: Record<MotivationLevel, string> = {
  hot: "Hot",
  warm: "Warm",
  cold: "Cold",
};

type KanbanProps = {
  initialLeads: Lead[];
  initialTotals: Record<PropertyStatus, number>;
  initialBaselineTotals: Record<PropertyStatus, number>;
  initialUrgencyCounts: Record<UrgencyFilter, number>;
  initialNextCursors: Partial<Record<PropertyStatus, LeadBoardCursor>>;
  initialHasMore: Partial<Record<PropertyStatus, boolean>>;
  initialSnapshotGenerations: Partial<Record<PropertyStatus, string>>;
  initialFilters: LeadBoardFilters;
  dayStart: string;
  dayEnd: string;
  unreadPropertyIds: string[];
  assigneeEmails: Record<string, string>;
  teamMembers: TeamMember[];
  currentUserId: string | null;
  listMemberships: Record<string, ListMembership[]>;
  customTags: Record<string, CustomTag[]>;
  lastMessageByPropertyId: Record<string, LastMessage>;
  initialOwnership?: OwnershipFilter;
  initialAttentionFilter?: AttentionFilter;
  hasInboundFilter?: boolean;
  inboundScopeLabel?: string | null;
  renderedAt: string;
};

export function Kanban({
  initialLeads,
  initialTotals,
  initialBaselineTotals,
  initialUrgencyCounts,
  initialNextCursors,
  initialHasMore,
  initialSnapshotGenerations,
  initialFilters,
  dayStart,
  dayEnd,
  unreadPropertyIds,
  assigneeEmails,
  teamMembers,
  currentUserId,
  listMemberships,
  customTags,
  lastMessageByPropertyId,
  initialOwnership = "all",
  initialAttentionFilter = null,
  hasInboundFilter = false,
  inboundScopeLabel = null,
  renderedAt,
}: KanbanProps) {
  const router = useRouter();
  const [leads, setLeads] = useState<Lead[]>(initialLeads);
  const [totals, setTotals] = useState(initialTotals);
  const [baselineTotals, setBaselineTotals] = useState(initialBaselineTotals);
  const [urgencyCounts, setUrgencyCounts] = useState(initialUrgencyCounts);
  const [nextCursors, setNextCursors] = useState(initialNextCursors);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [snapshotGenerations, setSnapshotGenerations] = useState(initialSnapshotGenerations);
  const [unreadIds, setUnreadIds] = useState(unreadPropertyIds);
  const [listsByLead, setListsByLead] = useState(listMemberships);
  const [tagsByLead, setTagsByLead] = useState(customTags);
  const [messagesByLead, setMessagesByLead] = useState(lastMessageByPropertyId);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<PropertyStatus>>(
    () => new Set(DEFAULT_COLLAPSED_STATUSES),
  );
  const [search, setSearch] = useState(initialFilters.search);
  const [ownership, setOwnership] = useState<OwnershipFilter>(initialOwnership);
  const [motivation, setMotivation] = useState<MotivationFilter>(initialFilters.motivation);
  const [urgency, setUrgency] = useState<UrgencyFilter>(initialFilters.urgency);
  const [attention, setAttention] = useState<AttentionFilter>(
    initialAttentionFilter,
  );
  const [moveFailures, setMoveFailures] = useState<Record<string, MoveFailure>>(
    {},
  );
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState<Set<PropertyStatus>>(new Set());
  const inFlightMoveIds = useRef(new Set<string>());
  const renderedAtMs = new Date(renderedAt).getTime();
  const initialRender = useRef(true);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
      if (raw === null) return;
      const parsed: unknown = JSON.parse(raw);
      if (
        !Array.isArray(parsed) ||
        !parsed.every(
          (status) =>
            typeof status === "string" &&
            STATUS_ORDER.includes(status as PropertyStatus),
        )
      ) {
        return;
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reconcile the SSR-safe default with a validated client preference after mount.
      setCollapsed(new Set(parsed as PropertyStatus[]));
    } catch {
      // Malformed or unavailable storage keeps the safe Closed/Dead default.
    }
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
  );

  const unreadSet = useMemo(
    () => new Set(unreadIds),
    [unreadIds],
  );

  const ownershipFiltered = useMemo(() => {
    if (ownership === "all") return leads;
    if (ownership === "unassigned") {
      return leads.filter(
        (lead) =>
          lead.assigned_user_id === null &&
          !["prospect", "closed", "dead"].includes(lead.status),
      );
    }
    const assigneeId = ownership === "mine" ? currentUserId : ownership;
    if (!assigneeId) return leads;
    return leads.filter((lead) => lead.assigned_user_id === assigneeId);
  }, [currentUserId, leads, ownership]);

  const motivationFiltered = useMemo(() => {
    if (motivation === "all") return ownershipFiltered;
    return ownershipFiltered.filter((lead) => {
      if (motivation === "unset") return !lead.motivation_level;
      return lead.motivation_level === motivation;
    });
  }, [motivation, ownershipFiltered]);

  const filteredLeads = useMemo(
    () => filterLeads(motivationFiltered, search).filter((lead) =>
      matchesUrgencyFilter(lead, urgency, dayStart, dayEnd),
    ),
    [dayEnd, dayStart, motivationFiltered, search, urgency],
  );

  const activeFilterCount =
    Number(search.trim().length > 0) +
    Number(ownership !== "all") +
    Number(motivation !== "all") +
    Number(attention !== null) +
    Number(urgency !== "all") +
    Number(Boolean(inboundScopeLabel));

  const leadsByStatus = useMemo(() => {
    const grouped: Record<PropertyStatus, Lead[]> = {
      prospect: [],
      new_lead: [],
      contacted: [],
      interested: [],
      offer_sent: [],
      offer_declined: [],
      under_contract: [],
      closed: [],
      dead: [],
    };
    for (const lead of filteredLeads) {
      const key = STATUS_ORDER.includes(lead.status as PropertyStatus)
        ? (lead.status as PropertyStatus)
        : "new_lead";
      grouped[key].push(lead);
    }
    for (const status of STATUS_ORDER) {
      grouped[status].sort((a, b) => compareLeadUrgency(a, b, dayStart, dayEnd));
    }
    return grouped;
  }, [dayEnd, dayStart, filteredLeads]);

  const activeLead = activeId
    ? leads.find((lead) => lead.id === activeId) ?? null
    : null;

  const boardFilters = useMemo<LeadBoardFilters>(() => ({
    ...initialFilters,
    search,
    ownership,
    motivation,
    urgency,
    attention,
  }), [attention, initialFilters, motivation, ownership, search, urgency]);
  const boardFilterKey = JSON.stringify(boardFilters);
  const boardFilterKeyRef = useRef(boardFilterKey);
  const boardFiltersRef = useRef(boardFilters);
  const cursorFilterKeyRef = useRef(boardFilterKey);
  const [cursorFilterKey, setCursorFilterKey] = useState(boardFilterKey);
  const requestSequence = useRef(0);

  useEffect(() => {
    boardFiltersRef.current = boardFilters;
    if (boardFilterKeyRef.current !== boardFilterKey) {
      boardFilterKeyRef.current = boardFilterKey;
      requestSequence.current += 1;
    }
  }, [boardFilterKey, boardFilters]);

  const applyReplacement = (data: LeadBoardData, sourceFilterKey: string) => {
    cursorFilterKeyRef.current = sourceFilterKey;
    setCursorFilterKey(sourceFilterKey);
    setLeads(data.leads as Lead[]);
    setTotals(data.totals);
    if (data.baselineTotals) setBaselineTotals(data.baselineTotals);
    if (data.urgencyCounts) setUrgencyCounts(data.urgencyCounts);
    setNextCursors(data.nextCursors);
    setHasMore(data.hasMore);
    setSnapshotGenerations(data.snapshotGenerations);
    setUnreadIds(data.unreadPropertyIds);
    setListsByLead(data.listMemberships);
    setTagsByLead(data.customTags);
    setMessagesByLead(data.lastMessageByPropertyId);
  };

  const refreshBoard = async () => {
    const filters = boardFiltersRef.current;
    const filterKey = boardFilterKeyRef.current;
    const request = ++requestSequence.current;
    setIsRefreshing(true);
    setLoadError(null);
    let result: Awaited<ReturnType<typeof loadLeadBoardAction>>;
    try {
      result = await loadLeadBoardAction({ filters });
    } catch {
      if (request !== requestSequence.current || filterKey !== boardFilterKeyRef.current) return;
      setIsRefreshing(false);
      setLoadError("We couldn't refresh your leads.");
      return;
    }
    if (request !== requestSequence.current || filterKey !== boardFilterKeyRef.current) return;
    setIsRefreshing(false);
    if (!result.ok) {
      setLoadError(result.error.message || "We couldn't refresh your leads.");
      return;
    }
    applyReplacement(result.data, filterKey);
  };

  useEffect(() => {
    if (initialRender.current) {
      initialRender.current = false;
      return;
    }
    const timeout = window.setTimeout(() => void refreshBoard(), search ? 250 : 0);
    return () => window.clearTimeout(timeout);
    // Each control intentionally re-queries the full server-backed queue. The
    // memoized object itself would retrigger on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attention, motivation, ownership, search, urgency]);

  const loadMoreInStatus = async (status: PropertyStatus) => {
    if (cursorFilterKeyRef.current !== boardFilterKeyRef.current) return;
    const cursor = nextCursors[status];
    if (!cursor || loadingMore.has(status)) return;
    const filterKey = boardFilterKeyRef.current;
    const generation = requestSequence.current;
    setLoadingMore((previous) => new Set(previous).add(status));
    let result: Awaited<ReturnType<typeof loadLeadBoardAction>>;
    try {
      result = await loadLeadBoardAction({ filters: boardFiltersRef.current, status, cursor });
    } catch {
      setLoadingMore((previous) => {
        const next = new Set(previous);
        next.delete(status);
        return next;
      });
      if (filterKey === boardFilterKeyRef.current && generation === requestSequence.current) {
        setLoadError(`We couldn't load more ${STATUS_LABEL[status]} leads.`);
      }
      return;
    }
    setLoadingMore((previous) => {
      const next = new Set(previous);
      next.delete(status);
      return next;
    });
    if (
      filterKey !== boardFilterKeyRef.current ||
      generation !== requestSequence.current
    ) {
      return;
    }
    if (!result.ok) {
      setLoadError(result.error.message || `We couldn't load more ${STATUS_LABEL[status]} leads.`);
      return;
    }
    const data = result.data;
    const expectedGeneration = snapshotGenerations[status];
    const receivedGeneration = data.snapshotGenerations?.[status];
    if (!expectedGeneration || !receivedGeneration || expectedGeneration !== receivedGeneration) {
      void refreshBoard();
      return;
    }
    setLeads((previous) => {
      const known = new Set(previous.map((lead) => lead.id));
      return [...previous, ...(data.leads as Lead[]).filter((lead) => !known.has(lead.id))];
    });
    setNextCursors((previous) => ({ ...previous, [status]: data.nextCursors[status] }));
    setHasMore((previous) => ({ ...previous, [status]: data.hasMore[status] }));
    setSnapshotGenerations((previous) => ({ ...previous, [status]: receivedGeneration }));
    setUnreadIds((previous) => Array.from(new Set([...previous, ...data.unreadPropertyIds])));
    setListsByLead((previous) => ({ ...previous, ...data.listMemberships }));
    setTagsByLead((previous) => ({ ...previous, ...data.customTags }));
    setMessagesByLead((previous) => ({ ...previous, ...data.lastMessageByPropertyId }));
    const existingIds = new Set(leads.map((lead) => lead.id));
    const newlyLoaded = (data.leads as Lead[]).filter((lead) => !existingIds.has(lead.id));
    const loadedInStatus = leads.filter((lead) => lead.status === status).length + newlyLoaded.length;
    if (
      !data.hasMore[status] &&
      (data.totals[status] !== totals[status] || loadedInStatus !== totals[status])
    ) {
      void refreshBoard();
    }
  };

  const resetFilters = () => {
    if (hasInboundFilter) {
      // Dashboard entry URLs may have been scoped before the global board
      // limit. Reload the bare board so Reset restores the complete dataset,
      // instead of merely changing a client control over a narrowed result.
      router.push("/leads");
      return;
    }
    setSearch("");
    setOwnership("all");
    setMotivation("all");
    setAttention(null);
    setUrgency("all");
  };

  const changeOwnership = (next: OwnershipFilter) => {
    if (hasInboundFilter && next !== initialOwnership) {
      router.push(inboundOwnershipHref(next));
      return;
    }
    setOwnership(next);
  };

  const toggleCollapsed = (status: PropertyStatus) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      try {
        window.localStorage.setItem(
          COLLAPSED_STORAGE_KEY,
          JSON.stringify(Array.from(next)),
        );
      } catch {
        // The interaction still works when storage is unavailable.
      }
      return next;
    });
  };

  const saveMove = async (
    lead: Lead,
    attemptedStatus: PropertyStatus,
    previousStatus: PropertyStatus,
    optimistic: boolean,
  ) => {
    // A fast second drag must not race the first save and let an older
    // response overwrite the newer card position. Keep one status mutation
    // per lead in flight; dnd-kit will snap an ignored second drag back.
    if (inFlightMoveIds.current.has(lead.id)) return;
    inFlightMoveIds.current.add(lead.id);

    if (optimistic) {
      setMoveFailures((previous) => {
        const next = { ...previous };
        delete next[lead.id];
        return next;
      });
      setLeads((previous) =>
        previous.map((item) =>
          item.id === lead.id ? { ...item, status: attemptedStatus } : item,
        ),
      );
    } else {
      setRetryingIds((previous) => new Set(previous).add(lead.id));
    }

    const result = await callAction(
      updatePropertyStatus(lead.id, attemptedStatus, previousStatus),
      {
        successMessage: `Moved ${lead.address} to ${STATUS_LABEL[attemptedStatus]}`,
        fallbackMessage: `Could not move ${lead.address}`,
      },
    );

    if (result.ok) {
      setLeads((previous) =>
        previous.map((item) =>
          item.id === lead.id ? { ...item, status: result.data.status } : item,
        ),
      );
      setMoveFailures((previous) => {
        const next = { ...previous };
        delete next[lead.id];
        return next;
      });
      void refreshBoard();
    } else {
      if (result.error.code === "DNC_LOCKED") {
        setLeads((previous) => previous.filter((item) => item.id !== lead.id));
        setMoveFailures((previous) => {
          const next = { ...previous };
          delete next[lead.id];
          return next;
        });
        void refreshBoard();
        router.refresh();
        setRetryingIds((previous) => {
          const next = new Set(previous);
          next.delete(lead.id);
          return next;
        });
        inFlightMoveIds.current.delete(lead.id);
        return;
      }
      const reportedCurrentStatus = result.error.details?.currentStatus;
      const reconciledStatus =
        typeof reportedCurrentStatus === "string" &&
        ALL_PROPERTY_STATUSES.includes(reportedCurrentStatus as PropertyStatus)
          ? (reportedCurrentStatus as PropertyStatus)
          : previousStatus;
      setLeads((previous) =>
        previous.map((item) =>
          item.id === lead.id ? { ...item, status: reconciledStatus } : item,
        ),
      );
      setMoveFailures((previous) => ({
        ...previous,
        [lead.id]: { attemptedStatus, previousStatus: reconciledStatus },
      }));
    }

    if (!optimistic) {
      setRetryingIds((previous) => {
        const next = new Set(previous);
        next.delete(lead.id);
        return next;
      });
    }
    inFlightMoveIds.current.delete(lead.id);
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveId(null);
    if (!event.over) return;

    const propertyId = String(event.active.id);
    const nextStatus = String(event.over.id) as PropertyStatus;
    if (!STATUS_ORDER.includes(nextStatus)) return;

    const lead = leads.find((item) => item.id === propertyId);
    if (!lead || lead.status === nextStatus) return;
    await saveMove(
      lead,
      nextStatus,
      lead.status as PropertyStatus,
      true,
    );
  };

  const retryMove = async (lead: Lead) => {
    const failure = moveFailures[lead.id];
    if (!failure || retryingIds.has(lead.id)) return;
    await saveMove(
      lead,
      failure.attemptedStatus,
      failure.previousStatus,
      false,
    );
  };

  const selectedOwnerLabel =
    ownership === "mine"
      ? "My leads"
      : ownership === "all"
        ? "All leads"
        : ownership === "unassigned"
          ? "Unassigned"
          : shortEmail(
              teamMembers.find((member) => member.id === ownership)?.email ??
                "Selected teammate",
            );

  return (
    <div className="flex flex-col gap-3">
      <div className="border-border bg-card flex flex-wrap items-center gap-3 rounded-2xl border p-3">
        <div className="relative min-w-52 flex-1 sm:max-w-md">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search address, homeowner, city, ZIP, market…"
            className="bg-muted/60 h-10 w-full rounded-full border-none pr-10 pl-11"
            aria-label="Search leads"
          />
          {search ? (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2"
            >
              <XIcon className="size-4" />
            </button>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            className="border-border flex h-8 overflow-hidden rounded-full border"
            role="group"
            aria-label="Lead ownership"
          >
            <button
              type="button"
              onClick={() => changeOwnership("all")}
              aria-pressed={ownership === "all"}
              className={`px-4 text-xs font-bold transition-colors ${
                ownership === "all"
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-foreground hover:bg-muted"
              }`}
            >
              All leads
            </button>
          <button
            type="button"
            onClick={() => changeOwnership("mine")}
            disabled={!currentUserId}
            aria-pressed={ownership === "mine"}
            className={`px-4 text-xs font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              ownership === "mine"
                ? "bg-primary text-primary-foreground"
                : "bg-background text-foreground hover:bg-muted"
            }`}
          >
            My leads
          </button>
          </div>
          <select
            value={
              ownership === "all" ||
              ownership === "mine" ||
              ownership === "unassigned"
                ? ""
                : ownership
            }
            onChange={(event) => {
              if (event.target.value) changeOwnership(event.target.value);
            }}
            aria-label="Choose a teammate"
            className={`border-border h-8 w-40 rounded-full border px-3 text-xs font-bold outline-none ${
              ownership !== "all" &&
              ownership !== "mine" &&
              ownership !== "unassigned"
                ? "bg-primary text-primary-foreground"
                : "bg-background text-foreground"
            }`}
          >
            <option value="">Teammate</option>
            <option value="unassigned">Unassigned</option>
            {teamMembers
              .filter((member) => member.id !== currentUserId)
              .map((member) => (
                <option key={member.id} value={member.id}>
                  {shortEmail(member.email)}
                </option>
              ))}
          </select>
          {ownership === "unassigned" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => changeOwnership("all")}
            >
              Unassigned <XIcon data-icon="inline-end" />
            </Button>
          ) : null}
        </div>

        <select
          value={motivation}
          onChange={(event) =>
            setMotivation(event.target.value as MotivationFilter)
          }
          aria-label="Filter by motivation"
          className={`border-border h-8 rounded-full border px-4 text-xs font-bold outline-none ${
            motivation === "all"
              ? "bg-background text-foreground"
              : "bg-primary text-primary-foreground"
          }`}
        >
          <option value="all">All motivation</option>
          <option value="hot">Hot</option>
          <option value="warm">Warm</option>
          <option value="cold">Cold</option>
          <option value="unset">Not set</option>
        </select>

        {attention ? (
          <Button variant="outline" size="sm" onClick={() => setAttention(null)}>
            {attention === "stale"
              ? "Stale conversations"
              : "Sequence ended without follow-up"}{" "}
            <XIcon data-icon="inline-end" />
          </Button>
        ) : null}

        {activeFilterCount > 0 ? (
          <Button variant="outline" size="sm" onClick={resetFilters}>
            Reset all ({activeFilterCount})
          </Button>
        ) : null}

        {activeFilterCount > 0 ? (
          <span className="text-muted-foreground text-xs" aria-live="polite">
            {filteredLeads.length} loaded · {Object.values(totals).reduce((sum, count) => sum + count, 0)} total
          </span>
        ) : null}
        {isRefreshing ? <span className="text-muted-foreground text-xs" role="status">Refreshing…</span> : null}
      </div>

      <div className="border-border bg-card flex flex-wrap items-center gap-2 rounded-2xl border px-3 py-2" aria-label="Lead urgency">
        <span className="text-muted-foreground mr-1 text-[10px] font-bold tracking-widest uppercase">Today&apos;s order</span>
        {([
          ["all", "All"],
          ["overdue", "Overdue"],
          ["today", "Due today"],
          ["scheduled", "Scheduled later"],
          ["none", "No next action"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={urgency === value}
            onClick={() => setUrgency(value)}
            className={`rounded-full border px-3 py-1.5 text-xs font-bold ${
              urgency === value
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-foreground hover:bg-muted"
            }`}
          >
            {label} {urgencyCounts[value]}
          </button>
        ))}
      </div>

      {loadError ? (
        <div className="border-destructive/30 bg-destructive/5 text-destructive flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm" role="alert">
          <span>{loadError} Your previous cards are still shown.</span>
          <Button variant="outline" size="sm" onClick={() => void refreshBoard()}>Try again</Button>
        </div>
      ) : null}

      {!isRefreshing && filteredLeads.length === 0 && activeFilterCount > 0 ? (
        <FilteredEmptyState
          search={search}
          ownership={ownership}
          ownershipLabel={selectedOwnerLabel}
          motivation={motivation}
          attention={attention}
          urgency={urgency}
          inboundScopeLabel={inboundScopeLabel}
          onClearSearch={() => setSearch("")}
          onClearOwnership={() => changeOwnership("all")}
          onClearMotivation={() => setMotivation("all")}
          onClearAttention={() => setAttention(null)}
          onClearUrgency={() => setUrgency("all")}
          onReset={resetFilters}
        />
      ) : (
        <DndContext
          id="leads-kanban"
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div
            className="flex gap-3 overflow-x-auto pb-3"
            data-testid="leads-board-scroll"
          >
            {STATUS_ORDER.map((status) => (
              <Column
                key={status}
                status={status}
                leads={leadsByStatus[status]}
                totalInStatus={totals[status]}
                baselineTotalInStatus={baselineTotals[status]}
                isActiveDropTarget={activeId != null}
                isCollapsed={collapsed.has(status)}
                onToggleCollapsed={() => toggleCollapsed(status)}
                onLeadClick={(id) => router.push(`/leads/${id}`)}
                unreadSet={unreadSet}
                assigneeEmails={assigneeEmails}
                currentUserId={currentUserId}
                listMemberships={listsByLead}
                customTags={tagsByLead}
                lastMessageByPropertyId={messagesByLead}
                renderedAtMs={renderedAtMs}
                dayStart={dayStart}
                dayEnd={dayEnd}
                moveFailures={moveFailures}
                retryingIds={retryingIds}
                onRetryMove={(lead) => void retryMove(lead)}
                hasMore={cursorFilterKey === boardFilterKey && Boolean(hasMore[status])}
                loadingMore={loadingMore.has(status)}
                onLoadMore={() => void loadMoreInStatus(status)}
                onNextActionSaved={(leadId, task) => {
                  setLeads((previous) => previous.map((lead) => lead.id === leadId ? {
                    ...lead,
                    next_task_id: task.id,
                    next_task_title: task.title,
                    next_task_due_at: task.dueAt,
                  } : lead));
                  void refreshBoard();
                }}
                onLeadPermanentlyLocked={(leadId) => {
                  setLeads((previous) => previous.filter((lead) => lead.id !== leadId));
                  void refreshBoard();
                  router.refresh();
                }}
              />
            ))}
          </div>
          <DragOverlay>
            {activeLead ? (
              <LeadCard
                lead={activeLead}
                overlay
                hasUnread={unreadSet.has(activeLead.id)}
                assigneeEmails={assigneeEmails}
                currentUserId={currentUserId}
                lists={listsByLead[activeLead.id] ?? []}
                customTags={tagsByLead[activeLead.id] ?? []}
                lastMessage={messagesByLead[activeLead.id] ?? null}
                renderedAtMs={renderedAtMs}
                dayStart={dayStart}
                dayEnd={dayEnd}
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}

function inboundOwnershipHref(ownership: OwnershipFilter): string {
  if (ownership === "all") return "/leads";
  if (ownership === "mine") return "/leads?assignee=me";
  if (ownership === "unassigned") return "/leads?unassigned=true";
  return `/leads?assignee=${encodeURIComponent(ownership)}`;
}

function FilteredEmptyState({
  search,
  ownership,
  ownershipLabel,
  motivation,
  attention,
  urgency,
  inboundScopeLabel,
  onClearSearch,
  onClearOwnership,
  onClearMotivation,
  onClearAttention,
  onClearUrgency,
  onReset,
}: {
  search: string;
  ownership: OwnershipFilter;
  ownershipLabel: string;
  motivation: MotivationFilter;
  attention: AttentionFilter;
  urgency: UrgencyFilter;
  inboundScopeLabel: string | null;
  onClearSearch: () => void;
  onClearOwnership: () => void;
  onClearMotivation: () => void;
  onClearAttention: () => void;
  onClearUrgency: () => void;
  onReset: () => void;
}) {
  return (
    <div className="border-border bg-card flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed p-8 text-center">
      <h2 className="text-lg font-bold">No leads match these filters</h2>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {search.trim() ? (
          <Button variant="outline" size="sm" onClick={onClearSearch}>
            Search: {search.trim()} <XIcon data-icon="inline-end" />
          </Button>
        ) : null}
        {ownership !== "all" ? (
          <Button variant="outline" size="sm" onClick={onClearOwnership}>
            {ownershipLabel} <XIcon data-icon="inline-end" />
          </Button>
        ) : null}
        {motivation !== "all" ? (
          <Button variant="outline" size="sm" onClick={onClearMotivation}>
            Motivation: {motivation === "unset" ? "Not set" : MOTIVATION_LABEL[motivation]}
            <XIcon data-icon="inline-end" />
          </Button>
        ) : null}
        {attention ? (
          <Button variant="outline" size="sm" onClick={onClearAttention}>
            {attention === "stale"
              ? "Stale conversations"
              : "Sequence ended without follow-up"}{" "}
            <XIcon data-icon="inline-end" />
          </Button>
        ) : null}
        {urgency !== "all" ? (
          <Button variant="outline" size="sm" onClick={onClearUrgency}>
            {urgency === "overdue"
              ? "Overdue"
              : urgency === "today"
                ? "Due today"
                : urgency === "scheduled"
                  ? "Scheduled later"
                  : "No next action"}{" "}
            <XIcon data-icon="inline-end" />
          </Button>
        ) : null}
        {inboundScopeLabel ? (
          <Button variant="outline" size="sm" onClick={onReset}>
            {inboundScopeLabel} <XIcon data-icon="inline-end" />
          </Button>
        ) : null}
      </div>
      <Button className="mt-5" onClick={onReset}>
        Reset all
      </Button>
    </div>
  );
}

function Column({
  status,
  leads,
  totalInStatus,
  baselineTotalInStatus,
  isActiveDropTarget,
  isCollapsed,
  onToggleCollapsed,
  onLeadClick,
  unreadSet,
  assigneeEmails,
  currentUserId,
  listMemberships,
  customTags,
  lastMessageByPropertyId,
  renderedAtMs,
  dayStart,
  dayEnd,
  moveFailures,
  retryingIds,
  onRetryMove,
  hasMore,
  loadingMore,
  onLoadMore,
  onNextActionSaved,
  onLeadPermanentlyLocked,
}: {
  status: PropertyStatus;
  leads: Lead[];
  totalInStatus: number;
  baselineTotalInStatus: number;
  isActiveDropTarget: boolean;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  onLeadClick: (id: string) => void;
  unreadSet: Set<string>;
  assigneeEmails: Record<string, string>;
  currentUserId: string | null;
  listMemberships: Record<string, ListMembership[]>;
  customTags: Record<string, CustomTag[]>;
  lastMessageByPropertyId: Record<string, LastMessage>;
  renderedAtMs: number;
  dayStart: string;
  dayEnd: string;
  moveFailures: Record<string, MoveFailure>;
  retryingIds: Set<string>;
  onRetryMove: (lead: Lead) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onNextActionSaved: (leadId: string, task: { id: string; title: string; dueAt: string }) => void;
  onLeadPermanentlyLocked: (leadId: string) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: status });
  const hover = isOver && isActiveDropTarget;
  const countLabel = leads.length < totalInStatus
    ? `${leads.length}/${totalInStatus}`
    : totalInStatus !== baselineTotalInStatus
      ? `${totalInStatus}/${baselineTotalInStatus}`
      : `${totalInStatus}`;
  const countDescription = leads.length < totalInStatus
    ? `${leads.length} loaded, ${totalInStatus} matching, ${baselineTotalInStatus} total`
    : `${totalInStatus} matching, ${baselineTotalInStatus} total`;

  if (isCollapsed) {
    return (
      <div
        ref={setNodeRef}
        data-status={status}
        className={`bg-muted/30 relative flex min-h-[60vh] w-10 shrink-0 flex-col items-center rounded-lg border border-t-4 ${STATUS_ACCENT[status]}`}
      >
        {hover ? (
          <div className="bg-card absolute top-12 left-1 z-10 w-40 rounded-lg border border-dashed border-current px-3 py-2 text-center text-xs font-bold shadow-md">
            Move to {STATUS_LABEL[status]}
          </div>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleCollapsed}
          aria-label={`Expand ${STATUS_LABEL[status]}`}
          className="mt-1"
        >
          <ChevronRightIcon />
        </Button>
        <div
          className="text-muted-foreground mt-2 text-xs font-semibold tracking-wide whitespace-nowrap"
          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
        >
          {STATUS_LABEL[status]}
        </div>
        <Badge variant="secondary" className="mt-3 font-mono" aria-label={countDescription} title={countDescription}>
          {countLabel}
        </Badge>
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      data-status={status}
      className={`bg-muted/30 flex min-h-[60vh] w-72 shrink-0 flex-col rounded-lg border border-t-4 ${STATUS_ACCENT[status]}`}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="text-sm font-semibold">{STATUS_LABEL[status]}</div>
        <div className="flex items-center gap-1.5">
          <Badge variant="secondary" className="font-mono" aria-label={countDescription} title={countDescription}>
            {countLabel}
          </Badge>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onToggleCollapsed}
            aria-label={`Collapse ${STATUS_LABEL[status]}`}
          >
            <ChevronDownIcon />
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-2 p-2">
        {hover ? (
          <div className="border-foreground/70 bg-background/70 rounded-xl border border-dashed px-3 py-3 text-center text-xs font-bold">
            Move to {STATUS_LABEL[status]}
          </div>
        ) : null}
        {leads.length === 0 ? (
          <div className="text-muted-foreground px-2 py-6 text-center text-xs">
            No leads
          </div>
        ) : (
          leads.map((lead) => (
            <LeadCard
              key={lead.id}
              lead={lead}
              onClick={() => onLeadClick(lead.id)}
              hasUnread={unreadSet.has(lead.id)}
              assigneeEmails={assigneeEmails}
              currentUserId={currentUserId}
              lists={listMemberships[lead.id] ?? []}
              customTags={customTags[lead.id] ?? []}
              lastMessage={lastMessageByPropertyId[lead.id] ?? null}
              renderedAtMs={renderedAtMs}
              dayStart={dayStart}
              dayEnd={dayEnd}
              moveFailure={moveFailures[lead.id] ?? null}
              isRetrying={retryingIds.has(lead.id)}
              onRetry={() => onRetryMove(lead)}
              onNextActionSaved={(task) => onNextActionSaved(lead.id, task)}
              onPermanentlyLocked={() => onLeadPermanentlyLocked(lead.id)}
            />
          ))
        )}
        {hasMore ? (
          <Button variant="outline" size="sm" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? "Loading…" : `Load more ${STATUS_LABEL[status]}`}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function LeadCard({
  lead,
  overlay = false,
  onClick,
  hasUnread = false,
  assigneeEmails,
  currentUserId,
  lists = [],
  customTags = [],
  lastMessage = null,
  renderedAtMs,
  dayStart,
  dayEnd,
  moveFailure = null,
  isRetrying = false,
  onRetry,
  onNextActionSaved,
  onPermanentlyLocked,
}: {
  lead: Lead;
  overlay?: boolean;
  onClick?: () => void;
  hasUnread?: boolean;
  assigneeEmails: Record<string, string>;
  currentUserId: string | null;
  lists?: ListMembership[];
  customTags?: CustomTag[];
  lastMessage?: LastMessage | null;
  renderedAtMs: number;
  dayStart: string;
  dayEnd: string;
  moveFailure?: MoveFailure | null;
  isRetrying?: boolean;
  onRetry?: () => void;
  onNextActionSaved?: (task: { id: string; title: string; dueAt: string }) => void;
  onPermanentlyLocked?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: lead.id });
  const style: React.CSSProperties = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : {};
  const assigneeEmail = lead.assigned_user_id
    ? assigneeEmails[lead.assigned_user_id] ?? null
    : null;
  const assignedToMe =
    lead.assigned_user_id && lead.assigned_user_id === currentUserId;
  const owner = homeownerName(lead.homeowner);
  const location = [lead.city, lead.state].filter(Boolean).join(", ");
  const [settingAction, setSettingAction] = useState(false);
  const [dueInput, setDueInput] = useState("");
  const [nextActionError, setNextActionError] = useState<string | null>(null);
  const [savingAction, setSavingAction] = useState(false);
  const idempotencyKey = useRef<string | null>(null);
  const nextAction = formatNextAction(lead.next_task_due_at, dayStart, dayEnd);
  const dialerLead = toSoftphoneLead(lead);

  const saveNextAction = async () => {
    if (savingAction) return;
    const parsed = new Date(dueInput);
    if (!dueInput || Number.isNaN(parsed.getTime())) {
      setNextActionError("Choose a valid date and time.");
      return;
    }
    idempotencyKey.current ??= crypto.randomUUID();
    setSavingAction(true);
    setNextActionError(null);
    let result: Awaited<ReturnType<typeof setLeadNextActionAction>>;
    try {
      result = await setLeadNextActionAction({
        propertyId: lead.id,
        dueAt: parsed.toISOString(),
        idempotencyKey: idempotencyKey.current,
      });
    } catch {
      setSavingAction(false);
      setNextActionError("Couldn't save the next action.");
      return;
    }
    setSavingAction(false);
    if (!result.ok) {
      if (result.error.code === "DNC_LOCKED") {
        setSettingAction(false);
        setNextActionError(null);
        setDueInput("");
        idempotencyKey.current = null;
        onPermanentlyLocked?.();
        return;
      }
      setNextActionError(result.error.message || "Couldn't save the next action.");
      return;
    }
    setSettingAction(false);
    setNextActionError(null);
    setDueInput("");
    idempotencyKey.current = null;
    onNextActionSaved?.({ id: result.data.id, title: result.data.title, dueAt: result.data.dueAt });
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`bg-card relative cursor-grab rounded-md border p-2.5 text-xs shadow-sm select-none active:cursor-grabbing ${
        isDragging && !overlay ? "opacity-30" : ""
      } ${overlay ? "shadow-lg" : ""}`}
      onClick={onClick}
      {...attributes}
      {...listeners}
      role="group"
      tabIndex={-1}
      aria-label={`Lead at ${lead.address}`}
    >
      {hasUnread ? (
        <span
          aria-label="Unread inbound message"
          title="Unread inbound message"
          className="bg-destructive absolute top-1.5 right-1.5 size-2 rounded-full"
        />
      ) : null}

      {overlay || !onClick ? (
        <div className={`truncate font-semibold ${hasUnread ? "pr-4" : ""}`}>{lead.address}</div>
      ) : (
        <Link
          href={`/leads/${lead.id}`}
          prefetch={false}
          aria-label={`Open lead at ${lead.address}`}
          className={`block w-full truncate text-left font-semibold ${hasUnread ? "pr-4" : ""}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {lead.address}
        </Link>
      )}
      {!overlay ? <div className="absolute top-2 right-2"><SoftphoneLeadButton lead={dialerLead} compact /></div> : null}
      <div className="text-muted-foreground mt-0.5 truncate">
        {owner}
        {location ? ` · ${location}` : ""}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        {lead.motivation_level &&
        (lead.motivation_level === "hot" ||
          lead.motivation_level === "warm" ||
          lead.motivation_level === "cold") ? (
          <Badge variant="secondary" className="gap-1 text-[10px]">
            <span
              className={`size-2 rounded-full ${MOTIVATION_DOT[lead.motivation_level as MotivationLevel]}`}
            />
            {MOTIVATION_LABEL[lead.motivation_level as MotivationLevel]}
          </Badge>
        ) : null}
        {lead.outreach_dispo ? (
          <Badge variant="outline" className="font-mono text-[9px] uppercase">
            {formatDisposition(lead.outreach_dispo)}
          </Badge>
        ) : null}
        {lead.homeowner_sms_opted_out ? (
          <Badge
            variant="outline"
            className="border-amber-600/60 bg-amber-50 font-mono text-[9px] uppercase text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
            title={
              lead.homeowner_sms_opted_out_at
                ? `SMS opted out ${new Date(lead.homeowner_sms_opted_out_at).toLocaleDateString()}`
                : "SMS opted out"
            }
          >
            SMS opted out
          </Badge>
        ) : null}
        {lead.assigned_user_id ? (
          <Badge
            variant={assignedToMe ? "default" : "outline"}
            className="text-[10px]"
          >
            {assignedToMe
              ? "me"
              : assigneeEmail
                ? shortEmail(assigneeEmail)
                : "assigned"}
          </Badge>
        ) : null}
      </div>

      <div className="mt-1.5 flex flex-wrap gap-1">
        {lead.market ? (
          <Badge variant="outline" className="text-[10px]">
            {lead.market}
          </Badge>
        ) : null}
        {lead.is_vacant ? (
          <Badge variant="destructive" className="text-[10px]">
            Vacant
          </Badge>
        ) : null}
        {lead.absentee_flag ? (
          <Badge variant="secondary" className="text-[10px]">
            Absentee
          </Badge>
        ) : null}
        {lead.cass_status && lead.cass_status !== "verified" ? (
          <Badge variant="outline" className="text-[10px]">
            {lead.cass_status}
          </Badge>
        ) : null}
      </div>

      {lists.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {lists.slice(0, 3).map((list) => (
            <Badge
              key={list.listId}
              variant="secondary"
              className="text-[10px]"
              style={
                list.color
                  ? {
                      backgroundColor: `${list.color}22`,
                      color: list.color,
                      borderColor: `${list.color}55`,
                    }
                  : undefined
              }
              title={list.name}
            >
              {list.name}
            </Badge>
          ))}
          {lists.length > 3 ? (
            <Badge variant="outline" className="text-[10px]">
              +{lists.length - 3}
            </Badge>
          ) : null}
          {lists.length >= 2 ? (
            <Badge
              variant="destructive"
              className="text-[10px]"
              title={`Stacked on ${lists.length} lists — high-motivation signal`}
            >
              🔥 {lists.length} lists
            </Badge>
          ) : null}
        </div>
      ) : null}

      {customTags.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {customTags.slice(0, 3).map((tag) => (
            <Badge
              key={tag.tagId}
              variant="outline"
              className="text-[10px]"
              style={
                tag.color
                  ? { color: tag.color, borderColor: `${tag.color}55` }
                  : undefined
              }
              title={tag.name}
            >
              #{tag.name}
            </Badge>
          ))}
          {customTags.length > 3 ? (
            <Badge variant="outline" className="text-[10px]">
              +{customTags.length - 3}
            </Badge>
          ) : null}
        </div>
      ) : null}

      <div
        className={`mt-2 rounded-md px-2 py-1.5 ${
          nextAction.tone === "overdue"
            ? "border-l-2 border-red-500 bg-red-500/5 text-red-700"
            : nextAction.tone === "today"
              ? "border-l-2 border-amber-500 bg-amber-500/5 text-amber-800"
              : nextAction.tone === "none"
                ? "border border-dashed border-amber-500/60 text-amber-800"
                : "border-l-2 border-border bg-muted/40 text-foreground"
        }`}
        data-testid={`leadcard-next-action-${lead.id}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] font-bold uppercase">
            <CalendarClockIcon className="size-3 shrink-0" />
            <span className="truncate">{nextAction.label}</span>
          </span>
          {nextAction.tone === "none" && !overlay && !settingAction ? (
            <button type="button" className="font-bold underline underline-offset-2" onClick={() => setSettingAction(true)}>
              Set
            </button>
          ) : null}
        </div>
        {lead.next_task_title ? <div className="mt-0.5 truncate text-[10px] opacity-75">{lead.next_task_title}</div> : null}
        {settingAction ? (
          <div className="mt-2 flex flex-col gap-1.5">
            <label className="font-semibold" htmlFor={`next-action-${lead.id}`}>Due date and time</label>
            <input
              id={`next-action-${lead.id}`}
              type="datetime-local"
              value={dueInput}
              disabled={savingAction}
              onChange={(event) => setDueInput(event.target.value)}
              className="border-border bg-background h-8 rounded-md border px-2 text-[11px]"
            />
            <div className="flex gap-2">
              <button type="button" disabled={savingAction} className="font-bold underline underline-offset-2 disabled:opacity-50" onClick={() => void saveNextAction()}>
                {savingAction ? "Saving…" : nextActionError ? "Retry" : "Save"}
              </button>
              <button type="button" disabled={savingAction} className="text-muted-foreground underline underline-offset-2 disabled:opacity-50" onClick={() => { setSettingAction(false); setNextActionError(null); idempotencyKey.current = null; }}>
                Cancel
              </button>
            </div>
            {nextActionError ? <div className="text-destructive" role="alert">{nextActionError} Not saved.</div> : null}
          </div>
        ) : null}
      </div>

      {moveFailure ? (
        <div
          className="border-destructive/30 bg-destructive/5 text-destructive mt-2 flex items-center justify-between gap-2 rounded-md border px-2 py-1.5"
          role="alert"
        >
          <span>
            Couldn&apos;t move to {STATUS_LABEL[moveFailure.attemptedStatus]}. Not
            saved.
          </span>
          <button
            type="button"
            className="shrink-0 font-bold underline underline-offset-2 disabled:opacity-50"
            disabled={isRetrying}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onRetry?.();
            }}
          >
            {isRetrying ? "Retrying…" : "Retry"}
          </button>
        </div>
      ) : null}

      <div
        className="text-muted-foreground mt-2 truncate text-[11px]"
        data-testid={`leadcard-last-message-${lead.id}`}
        title={lastMessage?.body}
      >
        {lastMessage ? (
          <>
            <span className="font-semibold text-foreground/80">
              {lastMessage.direction === "inbound" ? "Them" : "Us"}:
            </span>{" "}
            {lastMessage.body} · {formatRelativeAge(lastMessage.createdAt, renderedAtMs)}
          </>
        ) : (
          "No messages"
        )}
      </div>
    </div>
  );
}

function toSoftphoneLead(lead: Lead): SoftphoneLead {
  const contact = lead.homeowner;
  const phones = [contact?.phone_1, contact?.phone_2, contact?.phone_3].filter((phone): phone is string => Boolean(phone));
  const name = homeownerName(contact);
  const callable = canShowCallButton({
    property: { id: lead.id, state: lead.state, is_dnc_locked: lead.is_dnc_locked },
    contact: contact?.id ? { id: contact.id, phone_1: contact.phone_1 ?? null, phone_2: contact.phone_2 ?? null, phone_3: contact.phone_3 ?? null, do_not_contact: contact.do_not_contact ?? false, sms_opted_out: contact.sms_opted_out ?? false } : null,
  });
  return { id: lead.id, contactId: contact?.id ?? null, firstName: contact?.first_name ?? name.split(" ")[0] ?? "homeowner", name, address: lead.address, state: lead.state, phones, dncLocked: lead.is_dnc_locked ?? false, contactDnc: contact?.do_not_contact ?? false, callable };
}

export function homeownerName(homeowner: ContactSummary | null): string {
  if (!homeowner) return "Unknown homeowner";
  if (homeowner.entity_name?.trim()) return homeowner.entity_name.trim();
  const personName = [homeowner.first_name, homeowner.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  return personName || "Unknown homeowner";
}

export function formatRelativeAge(
  isoDate: string,
  nowMs: number,
): string {
  const timestamp = new Date(isoDate).getTime();
  if (!Number.isFinite(timestamp)) return "—";
  const seconds = Math.max(0, Math.floor((nowMs - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

function formatDisposition(disposition: string): string {
  return disposition.replaceAll("_", " ");
}

function shortEmail(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}
