import type { FilterBlock } from "./filter-schema";

export const EMPTY_AUDIENCE_VALIDATION_MESSAGE =
  "Audience filters are empty — they would target every prospect.";

export function isEffectiveBlock(block: FilterBlock): boolean {
  switch (block.kind) {
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
    case "motivation_level":
      return block.values.length > 0;

    case "list_count":
    case "beds":
    case "baths":
    case "year_built":
    case "estimated_value":
    case "equity_pct":
      return block.range.min != null || block.range.max != null;

    case "vacancy":
    case "absentee":
    case "has_unread_inbound":
    case "needs_human_attention":
    case "has_open_tasks":
      return block.tri !== "any";

    case "created_date":
      if (block.date.mode === "fixed") {
        return block.date.from != null || block.date.to != null;
      }
      return true;

    default: {
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
}

export function hasEffectiveAudience(args: {
  search: string | null | undefined;
  blockStack: readonly FilterBlock[];
}): boolean {
  const search = typeof args.search === "string" ? args.search.trim() : "";
  return search.length > 0 || args.blockStack.some(isEffectiveBlock);
}
