"use client";

import React, { lazy, Suspense } from "react";
import type { FilterBlock, BlockKind } from "@/lib/prospects/filter-schema";

// ---------------------------------------------------------------------------
// Lazy-loaded block components — one import per kind.
// BLOCK_REGISTRY is typed Record<BlockKind, ...> for compile-time exhaustiveness:
// if a new kind is added to filter-schema.ts without a matching entry here,
// TypeScript flags it. (Pitfall 6 in RESEARCH: each Suspense boundary is per-row
// so a slow chunk only skeletons that single block, not the whole stack.)
// ---------------------------------------------------------------------------

const BLOCK_REGISTRY: Record<
  BlockKind,
  React.LazyExoticComponent<React.ComponentType<any>>
> = {
  // General (7)
  list: lazy(() => import("./list-block")),
  tag: lazy(() => import("./tag-block")),
  list_count: lazy(() => import("./list-count-block")),
  vacancy: lazy(() => import("./vacancy-block")),
  cass: lazy(() => import("./cass-block")),
  outreach_dispo: lazy(() => import("./outreach-dispo-block")),
  source: lazy(() => import("./source-block")),
  // Property (5)
  beds: lazy(() => import("./beds-block")),
  baths: lazy(() => import("./baths-block")),
  year_built: lazy(() => import("./year-built-block")),
  state: lazy(() => import("./state-block")),
  market: lazy(() => import("./market-block")),
  // Owner (1)
  absentee: lazy(() => import("./absentee-block")),
  // Value & Equity (2)
  estimated_value: lazy(() => import("./estimated-value-block")),
  // equity_pct column added by Plan 04 Task 0 migration; always present in v1.
  equity_pct: lazy(() => import("./equity-pct-block")),
  // Status & Engagement (4)
  pipeline_status: lazy(() => import("./pipeline-status-block")),
  engagement: lazy(() => import("./engagement-block")),
  assignee: lazy(() => import("./assignee-block")),
  created_date: lazy(() => import("./created-date-block")),
  // Schema-audit additions (4)
  has_unread_inbound: lazy(() => import("./has-unread-inbound-block")),
  needs_human_attention: lazy(() => import("./needs-human-attention-block")),
  has_open_tasks: lazy(() => import("./has-open-tasks-block")),
  motivation_level: lazy(() => import("./motivation-level-block")),
};

export { BLOCK_REGISTRY };

// ---------------------------------------------------------------------------
// BlockSkeleton — loading fallback while a lazy chunk loads
// ---------------------------------------------------------------------------

function BlockSkeleton() {
  return (
    <div
      className="h-16 animate-pulse bg-muted rounded"
      data-testid="block-skeleton"
    />
  );
}

// ---------------------------------------------------------------------------
// renderBlock — used as FilterDrawer's renderBlock prop (Plan 06 → Plan 09).
// Each block gets its own <Suspense> so a slow chunk only skeletons that row.
// ---------------------------------------------------------------------------

export function renderBlock(
  block: FilterBlock,
  onChange: (patch: Partial<FilterBlock>) => void,
  onRemove: () => void,
): React.ReactElement {
  const Comp = BLOCK_REGISTRY[block.kind];
  return (
    <Suspense key={block.id} fallback={<BlockSkeleton />}>
      <Comp block={block as any} onChange={onChange as any} onRemove={onRemove} />
    </Suspense>
  );
}
