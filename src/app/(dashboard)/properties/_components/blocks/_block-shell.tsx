"use client";

import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { TeamMember } from "@/lib/auth/team-member";

// ---------------------------------------------------------------------------
// BlockOptions — the data contract that Plan 09 must provide via context.
// All 10 fields are required; Plan 09 (page integration) wires them.
// ---------------------------------------------------------------------------

export type BlockOptions = {
  /** All active lists; multi-select list-block shows these */
  lists: Array<{ id: string; name: string; color?: string }>;
  /** Tags already filtered to category='custom' (per Constraint line 130) */
  tags: Array<{ id: string; name: string; color?: string }>;
  /** Distinct counties.market values */
  markets: string[];
  /** Distinct 2-letter properties.state values */
  states: string[];
  /** Auth users for assignee picker; "unassigned" sentinel is added by the block */
  assignees: TeamMember[];
  /** properties.source enum values */
  sources: string[];
  /** properties.status enum values (e.g., ['prospect','lead','contract','closed']) */
  pipelineStatuses: string[];
  /** properties.motivation_level enum values */
  motivationLevels: string[];
  /** outreach_dispo enum values */
  outreachDispos: string[];
  /** CASS status enum values */
  cassStatuses: string[];
};

export const BlockOptionsContext = createContext<BlockOptions | null>(null);

export function useBlockOptions(): BlockOptions {
  const v = useContext(BlockOptionsContext);
  if (!v) {
    throw new Error(
      "BlockOptionsContext missing — wrap with <BlockOptionsContext.Provider value={opts}>",
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// BlockShell — shared wrapper: label row + × button + children slot
// ---------------------------------------------------------------------------

export function BlockShell({
  label,
  onRemove,
  children,
}: {
  label: string;
  onRemove: () => void;
  children: ReactNode;
}) {
  return (
    <div data-block-shell>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium">{label}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${label} filter`}
          onClick={onRemove}
        >
          <XIcon />
        </Button>
      </div>
      <div>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CombinatorSelect — "All / Any / Do Not Include" tri-state for multi-select blocks
// ---------------------------------------------------------------------------

export function CombinatorSelect({
  value,
  onChange,
}: {
  value: "all" | "any" | "not";
  onChange: (v: "all" | "any" | "not") => void;
}) {
  return (
    <select
      className="text-xs border rounded px-1 py-0.5 mr-2 mb-2"
      value={value}
      onChange={(e) => onChange(e.target.value as "all" | "any" | "not")}
      aria-label="Combinator"
    >
      <option value="all">All</option>
      <option value="any">Any</option>
      <option value="not">Do Not Include</option>
    </select>
  );
}
