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
import { ChevronDownIcon, ChevronRightIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { callAction } from "@/lib/errors/call-action";
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

type ContactSummary = Pick<
  Database["public"]["Tables"]["contacts"]["Row"],
  "first_name" | "last_name" | "entity_name"
>;

export type Lead = Pick<
  Database["public"]["Tables"]["properties"]["Row"],
  | "id"
  | "address"
  | "city"
  | "state"
  | "zip"
  | "market"
  | "status"
  | "is_vacant"
  | "cass_status"
  | "absentee_flag"
  | "assigned_user_id"
  | "motivation_level"
  | "outreach_dispo"
> & {
  homeowner: ContactSummary | null;
};

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

type ListMembership = {
  listId: string;
  name: string;
  color: string | null;
};

type CustomTag = {
  tagId: string;
  name: string;
  color: string | null;
};

type KanbanProps = {
  initialLeads: Lead[];
  unreadPropertyIds: string[];
  assigneeEmails: Record<string, string>;
  teamMembers: TeamMember[];
  currentUserId: string | null;
  listMemberships: Record<string, ListMembership[]>;
  customTags: Record<string, CustomTag[]>;
  lastMessageByPropertyId: Record<string, LastMessage>;
  attentionLeadIds: { stale: string[]; sequenceEnded: string[] };
  initialOwnership?: OwnershipFilter;
  initialAttentionFilter?: AttentionFilter;
  hasInboundFilter?: boolean;
  renderedAt: string;
};

export function Kanban({
  initialLeads,
  unreadPropertyIds,
  assigneeEmails,
  teamMembers,
  currentUserId,
  listMemberships,
  customTags,
  lastMessageByPropertyId,
  attentionLeadIds,
  initialOwnership = "all",
  initialAttentionFilter = null,
  hasInboundFilter = false,
  renderedAt,
}: KanbanProps) {
  const router = useRouter();
  const [leads, setLeads] = useState<Lead[]>(initialLeads);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<PropertyStatus>>(
    () => new Set(DEFAULT_COLLAPSED_STATUSES),
  );
  const [search, setSearch] = useState("");
  const [ownership, setOwnership] = useState<OwnershipFilter>(initialOwnership);
  const [motivation, setMotivation] = useState<MotivationFilter>("all");
  const [attention, setAttention] = useState<AttentionFilter>(
    initialAttentionFilter,
  );
  const [moveFailures, setMoveFailures] = useState<Record<string, MoveFailure>>(
    {},
  );
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());
  const inFlightMoveIds = useRef(new Set<string>());
  const renderedAtMs = new Date(renderedAt).getTime();

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
    () => new Set(unreadPropertyIds),
    [unreadPropertyIds],
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

  const attentionFiltered = useMemo(() => {
    if (!attention) return motivationFiltered;
    const ids = new Set(
      attention === "stale"
        ? attentionLeadIds.stale
        : attentionLeadIds.sequenceEnded,
    );
    return motivationFiltered.filter((lead) => ids.has(lead.id));
  }, [attention, attentionLeadIds, motivationFiltered]);

  const filteredLeads = useMemo(
    () => filterLeads(attentionFiltered, search),
    [attentionFiltered, search],
  );

  const activeFilterCount =
    Number(search.trim().length > 0) +
    Number(ownership !== "all") +
    Number(motivation !== "all") +
    Number(attention !== null);

  const totalByStatus = useMemo(() => {
    const totals: Record<PropertyStatus, number> = {
      prospect: 0,
      new_lead: 0,
      contacted: 0,
      interested: 0,
      offer_sent: 0,
      offer_declined: 0,
      under_contract: 0,
      closed: 0,
      dead: 0,
    };
    for (const lead of leads) {
      const key = STATUS_ORDER.includes(lead.status as PropertyStatus)
        ? (lead.status as PropertyStatus)
        : "new_lead";
      totals[key] += 1;
    }
    return totals;
  }, [leads]);

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
    return grouped;
  }, [filteredLeads]);

  const activeLead = activeId
    ? leads.find((lead) => lead.id === activeId) ?? null
    : null;

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
  };

  const changeOwnership = (next: OwnershipFilter) => {
    if (hasInboundFilter && next !== initialOwnership) {
      router.push("/leads");
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
    } else {
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
            {filteredLeads.length} of {leads.length} leads
          </span>
        ) : null}
      </div>

      {filteredLeads.length === 0 && activeFilterCount > 0 ? (
        <FilteredEmptyState
          search={search}
          ownership={ownership}
          ownershipLabel={selectedOwnerLabel}
          motivation={motivation}
          attention={attention}
          onClearSearch={() => setSearch("")}
          onClearOwnership={() => changeOwnership("all")}
          onClearMotivation={() => setMotivation("all")}
          onClearAttention={() => setAttention(null)}
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
                totalInStatus={totalByStatus[status]}
                filtersActive={activeFilterCount > 0}
                isActiveDropTarget={activeId != null}
                isCollapsed={collapsed.has(status)}
                onToggleCollapsed={() => toggleCollapsed(status)}
                onLeadClick={(id) => router.push(`/leads/${id}`)}
                unreadSet={unreadSet}
                assigneeEmails={assigneeEmails}
                currentUserId={currentUserId}
                listMemberships={listMemberships}
                customTags={customTags}
                lastMessageByPropertyId={lastMessageByPropertyId}
                renderedAtMs={renderedAtMs}
                moveFailures={moveFailures}
                retryingIds={retryingIds}
                onRetryMove={(lead) => void retryMove(lead)}
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
                lists={listMemberships[activeLead.id] ?? []}
                customTags={customTags[activeLead.id] ?? []}
                lastMessage={lastMessageByPropertyId[activeLead.id] ?? null}
                renderedAtMs={renderedAtMs}
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}

function FilteredEmptyState({
  search,
  ownership,
  ownershipLabel,
  motivation,
  attention,
  onClearSearch,
  onClearOwnership,
  onClearMotivation,
  onClearAttention,
  onReset,
}: {
  search: string;
  ownership: OwnershipFilter;
  ownershipLabel: string;
  motivation: MotivationFilter;
  attention: AttentionFilter;
  onClearSearch: () => void;
  onClearOwnership: () => void;
  onClearMotivation: () => void;
  onClearAttention: () => void;
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
  filtersActive,
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
  moveFailures,
  retryingIds,
  onRetryMove,
}: {
  status: PropertyStatus;
  leads: Lead[];
  totalInStatus: number;
  filtersActive: boolean;
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
  moveFailures: Record<string, MoveFailure>;
  retryingIds: Set<string>;
  onRetryMove: (lead: Lead) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: status });
  const hover = isOver && isActiveDropTarget;
  const countLabel =
    filtersActive && totalInStatus !== leads.length
      ? `${leads.length}/${totalInStatus}`
      : `${leads.length}`;

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
        <Badge variant="secondary" className="mt-3 font-mono">
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
          <Badge variant="secondary" className="font-mono">
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
              moveFailure={moveFailures[lead.id] ?? null}
              isRetrying={retryingIds.has(lead.id)}
              onRetry={() => onRetryMove(lead)}
            />
          ))
        )}
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
  moveFailure = null,
  isRetrying = false,
  onRetry,
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
  moveFailure?: MoveFailure | null;
  isRetrying?: boolean;
  onRetry?: () => void;
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
      role="link"
      tabIndex={0}
      aria-label={`Open lead at ${lead.address}`}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && onClick) {
          event.preventDefault();
          onClick();
        }
      }}
    >
      {hasUnread ? (
        <span
          aria-label="Unread inbound message"
          title="Unread inbound message"
          className="bg-destructive absolute top-1.5 right-1.5 size-2 rounded-full"
        />
      ) : null}

      <div className={`truncate font-semibold ${hasUnread ? "pr-4" : ""}`}>
        {lead.address}
      </div>
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
