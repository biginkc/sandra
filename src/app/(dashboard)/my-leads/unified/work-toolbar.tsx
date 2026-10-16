"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { ChevronsDownUp, ChevronsUpDown, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MY_LEAD_STAGE_LABELS, MY_LEAD_STAGE_ORDER } from "../_components/types";
import {
  NEEDS_ATTENTION_CHIPS,
  WAITING_CHIPS,
  WORK_TABS,
  WORK_TAB_LABELS,
  type WorkChip,
  type WorkReason,
  type WorkStage,
  type WorkTab,
} from "./contract";
import { chipLabel } from "./copy";

export const WORK_SEARCH_MAX = 200;

/**
 * Tabs, reason chips, Stage select, hidden search and expand/collapse-all (design v8 section 6).
 * Values + callbacks only. Counts come from the page read (tabCounts / chipCounts / stageCounts), so every
 * number matches the list a click shows. The chips apply to the Needs attention and Waiting on them tabs;
 * All leads has none.
 */
export type WorkToolbarProps = {
  tab: WorkTab;
  chip: WorkChip;
  /** Null = all stages. */
  stage: WorkStage | null;
  search: string;
  tabCounts: Record<WorkTab, number>;
  /** Counts for the current tab's chips, keyed by reason. The "all" chip uses tabCounts[tab]. */
  chipCounts: Partial<Record<WorkReason, number>>;
  stageCounts: Partial<Record<WorkStage, number>>;
  /** True when every visible row is expanded (the icon then offers Collapse all). */
  allExpanded: boolean;
  /** Changing the tab: the container resets chip to "all" and page to 1. */
  onTabChange: (tab: WorkTab) => void;
  onChipChange: (chip: WorkChip) => void;
  onStageChange: (stage: WorkStage | null) => void;
  /** Called on every keystroke with at most 200 characters; the container debounces. */
  onSearchChange: (value: string) => void;
  onToggleAll: () => void;
};

function chipsFor(tab: WorkTab): readonly WorkChip[] {
  if (tab === "needs_attention") return NEEDS_ATTENTION_CHIPS;
  if (tab === "waiting") return WAITING_CHIPS;
  return [];
}

export function WorkToolbar({
  tab,
  chip,
  stage,
  search,
  tabCounts,
  chipCounts,
  stageCounts,
  allExpanded,
  onTabChange,
  onChipChange,
  onStageChange,
  onSearchChange,
  onToggleAll,
}: WorkToolbarProps) {
  const [searchOpen, setSearchOpen] = useState(search.length > 0);
  // A search that arrives from outside (browser Back/Forward) opens the box so the term is visible.
  const [seenSearch, setSeenSearch] = useState(search);
  if (search !== seenSearch) {
    setSeenSearch(search);
    if (search.length > 0) setSearchOpen(true);
  }
  const searchRef = useRef<HTMLInputElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const chips = chipsFor(tab);
  const stageTotal = MY_LEAD_STAGE_ORDER.reduce((sum, key) => sum + (stageCounts[key] ?? 0), 0);

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + WORK_TABS.length) % WORK_TABS.length;
    tabRefs.current[next]?.focus();
    onTabChange(WORK_TABS[next]);
  }

  function openSearch() {
    setSearchOpen(true);
    queueMicrotask(() => searchRef.current?.focus());
  }

  function closeSearch() {
    setSearchOpen(false);
    if (search) onSearchChange("");
  }

  return (
    <div className="space-y-3" data-testid="work-toolbar">
      <div className="flex items-center gap-2">
        <div
          role="tablist"
          aria-label="Work queue"
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto border-b border-border"
        >
          {WORK_TABS.map((key, index) => {
            const selected = key === tab;
            return (
              <button
                key={key}
                ref={(node) => { tabRefs.current[index] = node; }}
                type="button"
                role="tab"
                id={`work-tab-${key}`}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                data-testid={`work-tab-${key}`}
                className={cn(
                  "-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  selected ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
                onClick={() => { if (!selected) onTabChange(key); }}
                onKeyDown={(event) => onTabKeyDown(event, index)}
              >
                {WORK_TAB_LABELS[key]}{" "}
                <span className="tabular-nums text-xs font-bold" data-testid={`work-tab-count-${key}`}>{tabCounts[key] ?? 0}</span>
              </button>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!searchOpen && (
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Search" data-testid="work-search-open" onClick={openSearch}>
              <Search aria-hidden="true" />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={allExpanded ? "Collapse all" : "Expand all"}
            data-testid="work-toggle-all"
            onClick={onToggleAll}
          >
            {allExpanded ? <ChevronsDownUp aria-hidden="true" /> : <ChevronsUpDown aria-hidden="true" />}
          </Button>
        </div>
      </div>

      {searchOpen && (
        <div className="flex items-center gap-2" role="search">
          <input
            ref={searchRef}
            type="search"
            aria-label="Search name, address or phone"
            placeholder="Search name, address or phone"
            maxLength={WORK_SEARCH_MAX}
            value={search}
            data-testid="work-search-input"
            className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            onChange={(event) => onSearchChange(event.target.value.slice(0, WORK_SEARCH_MAX))}
            onKeyDown={(event) => { if (event.key === "Escape") closeSearch(); }}
          />
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Close search" data-testid="work-search-close" onClick={closeSearch}>
            <X aria-hidden="true" />
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {chips.length > 0 && (
          <div
            role="group"
            aria-label="Reason"
            className="flex min-w-0 flex-1 basis-72 flex-nowrap gap-1.5 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0"
          >
            {chips.map((key) => {
              const selected = key === chip;
              const count = key === "all" ? tabCounts[tab] ?? 0 : chipCounts[key as WorkReason] ?? 0;
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={selected}
                  data-testid={`work-chip-${key}`}
                  className={cn(
                    "shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                    selected
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-background text-foreground hover:bg-muted",
                    !selected && count === 0 && "text-muted-foreground",
                  )}
                  onClick={() => { if (!selected) onChipChange(key); }}
                >
                  {chipLabel(key, tab)}{" "}
                  <span className="tabular-nums" data-testid={`work-chip-count-${key}`}>{count}</span>
                </button>
              );
            })}
          </div>
        )}
        <label className="ml-auto flex shrink-0 items-center gap-2 text-xs font-semibold text-muted-foreground">
          <span>Stage</span>
          <select
            aria-label="Stage"
            data-testid="work-stage-select"
            value={stage ?? ""}
            className="h-8 rounded-lg border border-input bg-background px-2 text-sm font-medium text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            onChange={(event) => onStageChange(event.target.value === "" ? null : (event.target.value as WorkStage))}
          >
            <option value="">All stages ({stageTotal})</option>
            {MY_LEAD_STAGE_ORDER.map((key) => (
              <option key={key} value={key}>{MY_LEAD_STAGE_LABELS[key]} ({stageCounts[key] ?? 0})</option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
