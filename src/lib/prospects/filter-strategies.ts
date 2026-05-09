import { BLOCK_KINDS, type BlockKind } from "./filter-schema";

export type FilterQueryStrategy =
  | "columnBoolean"
  | "columnMultiSelect"
  | "numericRange"
  | "columnDateRange"
  | "relationshipJoin"
  | "relationshipAntiJoin"
  | "aggregateView"
  | "computedServerSide";

export type FilterStrategyDefinition = {
  strategy: FilterQueryStrategy;
  column?: string;
  relation?: string;
  notes?: string;
};

/**
 * Query-shape registry for the prospects filter engine.
 *
 * Keep this explicit. The filter translator still owns the actual Supabase
 * calls, but this map makes every block's strategy visible and testable so
 * risky filters do not disappear inside a large switch.
 */
export const FILTER_STRATEGIES = {
  list: {
    strategy: "relationshipJoin",
    relation: "property_lists",
    notes:
      "Uses embedded joins for any/single-list-all/not; multi-list all falls back to set intersection.",
  },
  tag: {
    strategy: "computedServerSide",
    relation: "property_tags",
    notes: "Prefetches matching property ids from the tag junction table.",
  },
  list_count: {
    strategy: "aggregateView",
    relation: "property_stack_counts",
  },
  vacancy: {
    strategy: "columnBoolean",
    column: "is_vacant",
  },
  cass: {
    strategy: "columnMultiSelect",
    column: "cass_status",
  },
  outreach_dispo: {
    strategy: "columnMultiSelect",
    column: "outreach_dispo",
  },
  source: {
    strategy: "columnMultiSelect",
    column: "source",
  },
  beds: {
    strategy: "numericRange",
    column: "beds",
  },
  baths: {
    strategy: "numericRange",
    column: "baths",
  },
  year_built: {
    strategy: "numericRange",
    column: "year_built",
  },
  state: {
    strategy: "columnMultiSelect",
    column: "state",
  },
  market: {
    strategy: "columnMultiSelect",
    column: "market",
  },
  absentee: {
    strategy: "columnBoolean",
    column: "absentee_flag",
  },
  estimated_value: {
    strategy: "numericRange",
    column: "arv",
  },
  equity_pct: {
    strategy: "numericRange",
    column: "equity_pct",
  },
  pipeline_status: {
    strategy: "columnMultiSelect",
    column: "status",
  },
  engagement: {
    strategy: "relationshipJoin",
    relation: "messages",
    notes:
      "Common buckets use message joins; mixed/fallback buckets compute scoped property id sets server-side.",
  },
  assignee: {
    strategy: "columnMultiSelect",
    column: "assigned_user_id",
    notes: "Supports the unassigned sentinel as assigned_user_id IS NULL.",
  },
  created_date: {
    strategy: "columnDateRange",
    column: "created_at",
  },
  has_unread_inbound: {
    strategy: "computedServerSide",
    relation: "messages",
  },
  needs_human_attention: {
    strategy: "columnBoolean",
    column: "needs_human_attention",
  },
  has_open_tasks: {
    strategy: "computedServerSide",
    relation: "tasks",
  },
  motivation_level: {
    strategy: "columnMultiSelect",
    column: "motivation_level",
  },
} satisfies Record<BlockKind, FilterStrategyDefinition>;

export const RISKY_FILTER_CONTRACT_KINDS = [
  "vacancy",
  "cass",
  "equity_pct",
  "pipeline_status",
  "list",
  "list_count",
  "engagement",
  "has_unread_inbound",
  "has_open_tasks",
] as const satisfies readonly BlockKind[];

export function assertFilterStrategyRegistryComplete(): true {
  const missing = BLOCK_KINDS.filter((kind) => !(kind in FILTER_STRATEGIES));
  if (missing.length > 0) {
    throw new Error(
      `Missing filter strategy definitions: ${missing.join(", ")}`,
    );
  }
  return true;
}
