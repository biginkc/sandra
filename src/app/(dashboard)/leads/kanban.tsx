"use client";

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useDraggable } from "@dnd-kit/core";
import { ChevronDownIcon, ChevronRightIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { callAction } from "@/lib/errors/call-action";
import type { Database } from "@/lib/supabase/types";

import { useRouter } from "next/navigation";

import { updatePropertyStatus, type PropertyStatus } from "./actions";
import { filterLeads } from "./filter";

type ContactSummary = Pick<
  Database["public"]["Tables"]["contacts"]["Row"],
  "first_name" | "last_name" | "entity_name"
>;

type Lead = Pick<
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
> & {
  homeowner: ContactSummary | null;
};

const STATUS_ORDER: readonly PropertyStatus[] = [
  "new_lead",
  "contacted",
  "offer_sent",
  "offer_declined",
  "interested",
  "under_contract",
  "closed",
  "dead",
];

const COLLAPSED_STORAGE_KEY = "sandra.leads.collapsed";

const STATUS_LABEL: Record<PropertyStatus, string> = {
  new_lead: "New Lead",
  contacted: "Contacted",
  interested: "Interested",
  offer_sent: "Offer Sent",
  offer_declined: "Offer Declined",
  under_contract: "Under Contract",
  closed: "Closed",
  dead: "Dead",
};

const STATUS_ACCENT: Record<PropertyStatus, string> = {
  new_lead: "border-t-blue-500",
  contacted: "border-t-cyan-500",
  interested: "border-t-amber-500",
  offer_sent: "border-t-orange-500",
  offer_declined: "border-t-rose-500",
  under_contract: "border-t-violet-500",
  closed: "border-t-emerald-500",
  dead: "border-t-zinc-400",
};

export function Kanban({ initialLeads }: { initialLeads: Lead[] }) {
  const [leads, setLeads] = useState<Lead[]>(initialLeads);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<PropertyStatus>>(new Set());
  const [search, setSearch] = useState<string>("");
  const router = useRouter();

  // Hydrate collapsed state from localStorage after mount (avoids SSR mismatch).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PropertyStatus[];
        setCollapsed(new Set(parsed.filter((s) => STATUS_ORDER.includes(s))));
      }
    } catch {
      // Ignore malformed storage.
    }
  }, []);

  const toggleCollapsed = (status: PropertyStatus) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      try {
        window.localStorage.setItem(
          COLLAPSED_STORAGE_KEY,
          JSON.stringify(Array.from(next)),
        );
      } catch {
        // Ignore quota errors.
      }
      return next;
    });
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
  );

  const filteredLeads = useMemo(
    () => filterLeads(leads, search),
    [leads, search],
  );

  const totalByStatus = useMemo(() => {
    const t: Record<PropertyStatus, number> = {
      new_lead: 0, contacted: 0, interested: 0, offer_sent: 0,
      offer_declined: 0, under_contract: 0, closed: 0, dead: 0,
    };
    for (const l of leads) {
      const k = (l.status as PropertyStatus) in t
        ? (l.status as PropertyStatus)
        : "new_lead";
      t[k]++;
    }
    return t;
  }, [leads]);

  const leadsByStatus = useMemo(() => {
    const grouped: Record<PropertyStatus, Lead[]> = {
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
      const key = (lead.status as PropertyStatus) in grouped
        ? (lead.status as PropertyStatus)
        : "new_lead";
      grouped[key].push(lead);
    }
    return grouped;
  }, [filteredLeads]);

  const isSearching = search.trim().length > 0;

  const activeLead = activeId
    ? leads.find((l) => l.id === activeId) ?? null
    : null;

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over) return;

    const propertyId = String(active.id);
    const newStatus = String(over.id) as PropertyStatus;
    if (!STATUS_ORDER.includes(newStatus)) return;

    const currentLead = leads.find((l) => l.id === propertyId);
    if (!currentLead || currentLead.status === newStatus) return;

    const previousStatus = currentLead.status;

    // Optimistic update
    setLeads((prev) =>
      prev.map((l) => (l.id === propertyId ? { ...l, status: newStatus } : l)),
    );

    const result = await callAction(
      updatePropertyStatus(propertyId, newStatus),
      {
        successMessage: `Moved ${currentLead.address} to ${STATUS_LABEL[newStatus]}`,
        fallbackMessage: `Could not move ${currentLead.address}`,
      },
    );

    // Revert on failure
    if (!result.ok) {
      setLeads((prev) =>
        prev.map((l) =>
          l.id === propertyId ? { ...l, status: previousStatus } : l,
        ),
      );
    }
  };

  const totalFiltered = filteredLeads.length;
  const totalAll = leads.length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search address, city, ZIP, market…"
            className="w-full pl-8 pr-8"
            aria-label="Search leads"
          />
          {search ? (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
            >
              <XIcon className="size-4" />
            </button>
          ) : null}
        </div>
        {isSearching ? (
          <div className="text-muted-foreground text-sm">
            {totalFiltered} of {totalAll} leads match
          </div>
        ) : null}
      </div>

      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="flex gap-3 overflow-x-auto pb-3">
          {STATUS_ORDER.map((status) => (
            <Column
              key={status}
              status={status}
              leads={leadsByStatus[status]}
              totalInStatus={totalByStatus[status]}
              isActiveDropTarget={activeId != null}
              isCollapsed={collapsed.has(status)}
              onToggleCollapsed={() => toggleCollapsed(status)}
              isSearching={isSearching}
              onLeadClick={(id) => router.push(`/leads/${id}`)}
            />
          ))}
        </div>
        <DragOverlay>
          {activeLead ? <LeadCard lead={activeLead} overlay /> : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function Column({
  status,
  leads,
  totalInStatus,
  isActiveDropTarget,
  isCollapsed,
  onToggleCollapsed,
  isSearching,
  onLeadClick,
}: {
  status: PropertyStatus;
  leads: Lead[];
  totalInStatus: number;
  isActiveDropTarget: boolean;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  isSearching: boolean;
  onLeadClick: (id: string) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: status });
  const hover = isOver && isActiveDropTarget;

  const countLabel =
    isSearching && totalInStatus !== leads.length
      ? `${leads.length}/${totalInStatus}`
      : `${leads.length}`;

  // Collapsed: narrow rail. Still a valid drop target so users can drag
  // onto a collapsed column to re-categorize without expanding first.
  if (isCollapsed) {
    return (
      <div
        ref={setNodeRef}
        className={`bg-muted/30 flex min-h-[60vh] w-10 shrink-0 flex-col items-center rounded-lg border border-t-4 ${STATUS_ACCENT[status]} ${
          hover ? "ring-primary/40 ring-2" : ""
        }`}
      >
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
      className={`bg-muted/30 flex min-h-[60vh] w-72 shrink-0 flex-col rounded-lg border border-t-4 ${STATUS_ACCENT[status]} ${
        hover ? "ring-primary/40 ring-2" : ""
      }`}
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
        {leads.length === 0 ? (
          <div className="text-muted-foreground px-2 py-6 text-center text-xs">
            {hover
              ? "Drop here"
              : isSearching
                ? totalInStatus === 0
                  ? "No leads"
                  : "No matches"
                : "No leads"}
          </div>
        ) : (
          leads.map((lead) => (
            <LeadCard
              key={lead.id}
              lead={lead}
              onClick={() => onLeadClick(lead.id)}
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
}: {
  lead: Lead;
  overlay?: boolean;
  onClick?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: lead.id });

  const style: React.CSSProperties = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
      }
    : {};

  const className = `bg-card cursor-grab rounded-md border p-2.5 text-xs shadow-sm select-none active:cursor-grabbing ${
    isDragging && !overlay ? "opacity-30" : ""
  } ${overlay ? "shadow-lg" : ""}`;

  // dnd-kit's PointerSensor (distance: 4) only activates a drag once the
  // pointer moves 4px. A stationary press → release is treated as a click,
  // so onClick fires naturally without conflicting with drag-to-reorder.
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={className}
      onClick={onClick}
      {...attributes}
      {...listeners}
    >
      <div className="truncate font-medium">{lead.address}</div>
      <div className="text-muted-foreground mt-0.5 truncate">
        {[lead.city, lead.state, lead.zip].filter(Boolean).join(", ") || "—"}
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {lead.market && (
          <Badge variant="outline" className="text-[10px]">
            {lead.market}
          </Badge>
        )}
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
    </div>
  );
}
