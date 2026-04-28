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
  | "assigned_user_id"
  | "motivation_level"
> & {
  homeowner: ContactSummary | null;
};

type MotivationLevel = "hot" | "warm" | "cold";

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

const MOTIVATION_ORDER: readonly MotivationLevel[] = ["hot", "warm", "cold"];

// 'prospect' is deliberately NOT in STATUS_ORDER — prospects live on the
// /properties data-lake surface, not the kanban working surface. If a row
// arrives here with status='prospect' (should not happen given the
// server-side filter in /leads/page.tsx) it groups under 'new_lead' as a
// safety net.
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
  prospect: "Prospect",
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
  prospect: "border-t-slate-400",
  new_lead: "border-t-blue-500",
  contacted: "border-t-cyan-500",
  interested: "border-t-amber-500",
  offer_sent: "border-t-orange-500",
  offer_declined: "border-t-rose-500",
  under_contract: "border-t-violet-500",
  closed: "border-t-emerald-500",
  dead: "border-t-zinc-400",
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
  currentUserId: string | null;
  /** property_id → list memberships (active lists only, names + hex colors). */
  listMemberships: Record<string, ListMembership[]>;
  /** property_id → `custom` category tags only (source/uploaded etc. hidden from card). */
  customTags: Record<string, CustomTag[]>;
};

const MINE_ONLY_STORAGE_KEY = "sandra.leads.mineOnly";
const MOTIVATION_FILTER_STORAGE_KEY = "sandra.leads.motivationFilter";

export function Kanban({
  initialLeads,
  unreadPropertyIds,
  assigneeEmails,
  currentUserId,
  listMemberships,
  customTags,
}: KanbanProps) {
  const [leads, setLeads] = useState<Lead[]>(initialLeads);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<PropertyStatus>>(new Set());
  const [search, setSearch] = useState<string>("");
  const [mineOnly, setMineOnly] = useState<boolean>(false);
  /**
   * Motivation filter: empty set = no filter (show everything). Non-empty =
   * show only leads whose motivation_level is in the set. "unset" is a
   * pseudo-value for leads with null motivation; stored as the string
   * "unset" so the Set stays stringly-typed.
   */
  const [motivationFilter, setMotivationFilter] = useState<
    Set<MotivationLevel | "unset">
  >(new Set());
  const router = useRouter();

  const unreadSet = useMemo(
    () => new Set(unreadPropertyIds),
    [unreadPropertyIds],
  );

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
    // Hydrate mineOnly toggle — same pattern.
    try {
      const raw = window.localStorage.getItem(MINE_ONLY_STORAGE_KEY);
      if (raw === "true") setMineOnly(true);
    } catch {
      // Ignore.
    }
    // Hydrate motivation filter (stored as JSON array).
    try {
      const raw = window.localStorage.getItem(MOTIVATION_FILTER_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as (MotivationLevel | "unset")[];
        const allowed = new Set<MotivationLevel | "unset">([
          "hot",
          "warm",
          "cold",
          "unset",
        ]);
        setMotivationFilter(new Set(parsed.filter((p) => allowed.has(p))));
      }
    } catch {
      // Ignore.
    }
  }, []);

  const toggleMineOnly = () => {
    setMineOnly((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(MINE_ONLY_STORAGE_KEY, String(next));
      } catch {
        // Ignore quota errors.
      }
      return next;
    });
  };

  const toggleMotivation = (m: MotivationLevel | "unset") => {
    setMotivationFilter((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      try {
        window.localStorage.setItem(
          MOTIVATION_FILTER_STORAGE_KEY,
          JSON.stringify(Array.from(next)),
        );
      } catch {
        // Ignore.
      }
      return next;
    });
  };

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

  const mineFiltered = useMemo(() => {
    if (!mineOnly || !currentUserId) return leads;
    return leads.filter((l) => l.assigned_user_id === currentUserId);
  }, [leads, mineOnly, currentUserId]);

  const motivationFiltered = useMemo(() => {
    if (motivationFilter.size === 0) return mineFiltered;
    return mineFiltered.filter((l) => {
      const key: MotivationLevel | "unset" =
        l.motivation_level &&
        (l.motivation_level === "hot" ||
          l.motivation_level === "warm" ||
          l.motivation_level === "cold")
          ? (l.motivation_level as MotivationLevel)
          : "unset";
      return motivationFilter.has(key);
    });
  }, [mineFiltered, motivationFilter]);

  const filteredLeads = useMemo(
    () => filterLeads(motivationFiltered, search),
    [motivationFiltered, search],
  );

  const totalByStatus = useMemo(() => {
    // 'prospect' is tracked so TS is happy, but STATUS_ORDER excludes it
    // so it never renders a column. Any stray prospect row gets ignored
    // by the kanban; they belong on /properties.
    const t: Record<PropertyStatus, number> = {
      prospect: 0,
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
      <div className="border-border bg-card flex items-center gap-3 rounded-2xl border p-3">
        <div className="relative max-w-md flex-1">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search address, city, ZIP, market…"
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
        <Button
          variant={mineOnly ? "default" : "outline"}
          size="sm"
          onClick={toggleMineOnly}
          disabled={!currentUserId}
          aria-pressed={mineOnly}
          title={
            currentUserId
              ? "Show only leads assigned to me"
              : "Sign in to filter by assignee"
          }
        >
          Mine only
        </Button>
        <div
          className="flex items-center gap-1.5"
          role="group"
          aria-label="Motivation filter"
        >
          {MOTIVATION_ORDER.map((m) => {
            const active = motivationFilter.has(m);
            return (
              <Button
                key={m}
                variant={active ? "default" : "outline"}
                size="sm"
                onClick={() => toggleMotivation(m)}
                aria-pressed={active}
                title={`Filter: ${MOTIVATION_LABEL[m]}`}
                className="gap-1.5"
              >
                <span className={`size-2 rounded-full ${MOTIVATION_DOT[m]}`} />
                {MOTIVATION_LABEL[m]}
              </Button>
            );
          })}
          <Button
            variant={motivationFilter.has("unset") ? "default" : "outline"}
            size="sm"
            onClick={() => toggleMotivation("unset")}
            aria-pressed={motivationFilter.has("unset")}
            title="Filter: no motivation set"
          >
            Unset
          </Button>
        </div>
        {(isSearching || mineOnly || motivationFilter.size > 0) ? (
          <div className="text-muted-foreground text-sm">
            {totalFiltered} of {totalAll} leads
            {mineOnly ? " · mine" : ""}
            {motivationFilter.size > 0
              ? ` · ${Array.from(motivationFilter).join("/")}`
              : ""}
            {isSearching ? " · matching search" : ""}
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
              unreadSet={unreadSet}
              assigneeEmails={assigneeEmails}
              currentUserId={currentUserId}
              listMemberships={listMemberships}
              customTags={customTags}
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
            />
          ) : null}
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
  unreadSet,
  assigneeEmails,
  currentUserId,
  listMemberships,
  customTags,
}: {
  status: PropertyStatus;
  leads: Lead[];
  totalInStatus: number;
  isActiveDropTarget: boolean;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  isSearching: boolean;
  onLeadClick: (id: string) => void;
  unreadSet: Set<string>;
  assigneeEmails: Record<string, string>;
  currentUserId: string | null;
  listMemberships: Record<string, ListMembership[]>;
  customTags: Record<string, CustomTag[]>;
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
              hasUnread={unreadSet.has(lead.id)}
              assigneeEmails={assigneeEmails}
              currentUserId={currentUserId}
              lists={listMemberships[lead.id] ?? []}
              customTags={customTags[lead.id] ?? []}
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
}: {
  lead: Lead;
  overlay?: boolean;
  onClick?: () => void;
  hasUnread?: boolean;
  assigneeEmails: Record<string, string>;
  currentUserId: string | null;
  lists?: ListMembership[];
  customTags?: CustomTag[];
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: lead.id });

  const style: React.CSSProperties = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
      }
    : {};

  const className = `bg-card cursor-grab rounded-md border p-2.5 text-xs shadow-sm select-none active:cursor-grabbing relative ${
    isDragging && !overlay ? "opacity-30" : ""
  } ${overlay ? "shadow-lg" : ""}`;

  const assigneeEmail = lead.assigned_user_id
    ? assigneeEmails[lead.assigned_user_id] ?? null
    : null;
  const assignedToMe =
    lead.assigned_user_id && lead.assigned_user_id === currentUserId;

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
      {hasUnread ? (
        <span
          aria-label="Unread inbound message"
          title="Unread inbound message"
          className="bg-destructive absolute top-1.5 right-1.5 size-2 rounded-full"
        />
      ) : null}
      <div className="flex items-center gap-1.5">
        {lead.motivation_level &&
        (lead.motivation_level === "hot" ||
          lead.motivation_level === "warm" ||
          lead.motivation_level === "cold") ? (
          <span
            aria-label={`Motivation: ${MOTIVATION_LABEL[lead.motivation_level as MotivationLevel]}`}
            title={`Motivation: ${MOTIVATION_LABEL[lead.motivation_level as MotivationLevel]}`}
            className={`size-2 shrink-0 rounded-full ${MOTIVATION_DOT[lead.motivation_level as MotivationLevel]}`}
          />
        ) : null}
        <div className={`truncate font-medium ${hasUnread ? "pr-4" : ""}`}>
          {lead.address}
        </div>
      </div>
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
      {lists.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {lists.slice(0, 3).map((l) => (
            <Badge
              key={l.listId}
              variant="secondary"
              className="text-[10px]"
              style={
                l.color
                  ? {
                      backgroundColor: `${l.color}22`,
                      color: l.color,
                      borderColor: `${l.color}55`,
                    }
                  : undefined
              }
              title={l.name}
            >
              {l.name}
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
          {customTags.slice(0, 3).map((t) => (
            <Badge
              key={t.tagId}
              variant="outline"
              className="text-[10px]"
              style={
                t.color
                  ? {
                      color: t.color,
                      borderColor: `${t.color}55`,
                    }
                  : undefined
              }
              title={t.name}
            >
              #{t.name}
            </Badge>
          ))}
          {customTags.length > 3 ? (
            <Badge variant="outline" className="text-[10px]">
              +{customTags.length - 3}
            </Badge>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function shortEmail(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}
