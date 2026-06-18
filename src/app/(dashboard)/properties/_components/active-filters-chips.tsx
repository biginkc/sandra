"use client";

import { XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useFilterState } from "./use-filter-state";
import { BLOCK_PICKER_GROUPS } from "./add-block-picker";
import { SaveFilterButton } from "./save-filter-button";
import type { FilterBlock } from "@/lib/prospects/filter-schema";
import type { BlockStack } from "@/lib/prospects/filter-schema";

/**
 * Look up the human-readable label for a block kind from BLOCK_PICKER_GROUPS.
 * Falls back to the raw kind string if not found (future-proofs new kinds).
 */
function labelFor(kind: FilterBlock["kind"]): string {
  for (const g of BLOCK_PICKER_GROUPS) {
    for (const it of g.items) {
      if (it.kind === kind) return it.label;
    }
  }
  return kind;
}

/**
 * One-line summary of a configured block, appended after the label in the chip.
 * Returns empty string if the block is in a default / "any" state (no summary needed).
 */
function summarize(block: FilterBlock): string {
  switch (block.kind) {
    case "vacancy":
    case "absentee":
    case "has_unread_inbound":
    case "needs_human_attention":
    case "has_open_tasks":
      return block.tri === "any" ? "" : block.tri === "yes" ? "Yes" : "No";

    case "list":
    case "tag":
    case "cass":
    case "outreach_dispo":
    case "source":
    case "state":
    case "market":
    case "pipeline_status":
    case "engagement":
    case "assignee":
    case "motivation_level": {
      if (block.values.length === 0) return "";
      const verb =
        block.combinator === "all"
          ? "All of"
          : block.combinator === "not"
            ? "Not"
            : "Any of";
      return `${verb} [${block.values.length}]`;
    }

    case "list_count":
    case "beds":
    case "baths":
    case "year_built":
    case "estimated_value":
    case "equity_pct": {
      const { min, max } = block.range;
      if (min == null && max == null) return "";
      if (min != null && max != null) return `${min}–${max}`;
      if (min != null) return `≥ ${min}`;
      return `≤ ${max}`;
    }

    case "created_date": {
      if (block.date.mode === "since") return `Since ${block.date.days}d`;
      if (block.date.mode === "prior") return `Prior ${block.date.days}d`;
      return `${block.date.from ?? "…"} – ${block.date.to ?? "…"}`;
    }
  }
}

export type ActiveFiltersChipsProps = {
  orgId?: string;
  currentBlocks?: BlockStack;
};

/**
 * Renders one chip per configured filter block above the prospects table.
 * Returns null when no blocks are configured (nothing to show).
 *
 * Each chip shows: `<KindLabel>: <ConfigSummary> ×`
 * Clicking × removes that block from the URL state via useFilterState.removeBlock.
 * "Clear all" wipes the entire filter stack.
 */
export function ActiveFiltersChips(_props: ActiveFiltersChipsProps = {}) {
  const { orgId, currentBlocks } = _props;
  const { blocks, removeBlock, clearAll } = useFilterState();

  if (blocks.length === 0) return null;

  return (
    <div
      className="flex flex-wrap gap-1.5 items-center"
      data-active-filters-chips
    >
      {blocks.map((b) => {
        const summary = summarize(b);
        const label = labelFor(b.kind);
        return (
          <Badge
            key={b.id}
            variant="secondary"
            className="gap-1 pr-1"
            data-chip-kind={b.kind}
          >
            <span>
              {label}
              {summary ? `: ${summary}` : ""}
            </span>
            <button
              onClick={() => removeBlock(b.id)}
              aria-label={`Remove ${label} filter`}
              className="hover:opacity-70 focus:outline-none"
            >
              <XIcon className="size-3" />
            </button>
          </Badge>
        );
      })}
      <Button variant="ghost" size="sm" onClick={clearAll}>
        Clear all
      </Button>
      {orgId && currentBlocks ? (
        <SaveFilterButton orgId={orgId} currentBlocks={currentBlocks} />
      ) : null}
    </div>
  );
}
