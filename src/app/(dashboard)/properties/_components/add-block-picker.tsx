"use client";

/**
 * STUB — Plan 06 ships the real AddBlockPicker component and BLOCK_PICKER_GROUPS.
 * This stub exists in the Plan 08 worktree solely to provide the
 * BLOCK_PICKER_GROUPS export consumed by ActiveFiltersChips for label lookup.
 *
 * Plan 09 replaces this stub with Plan 06's real implementation at integration time.
 */

export const BLOCK_PICKER_GROUPS = [
  {
    group: "General",
    items: [
      { kind: "list", label: "List" },
      { kind: "tag", label: "Tag" },
      { kind: "list_count", label: "List Count" },
      { kind: "vacancy", label: "Vacancy" },
      { kind: "cass", label: "CASS" },
      { kind: "outreach_dispo", label: "Outreach Disposition" },
      { kind: "source", label: "Source" },
    ],
  },
  {
    group: "Property",
    items: [
      { kind: "beds", label: "Beds" },
      { kind: "baths", label: "Baths" },
      { kind: "year_built", label: "Year Built" },
      { kind: "state", label: "State" },
      { kind: "market", label: "Market" },
    ],
  },
  {
    group: "Owner",
    items: [{ kind: "absentee", label: "Absentee" }],
  },
  {
    group: "Value & Equity",
    items: [
      { kind: "estimated_value", label: "Estimated Value" },
      { kind: "equity_pct", label: "Equity %" },
    ],
  },
  {
    group: "Status & Engagement",
    items: [
      { kind: "pipeline_status", label: "Pipeline Status" },
      { kind: "engagement", label: "Engagement" },
      { kind: "assignee", label: "Assignee" },
      { kind: "created_date", label: "Created Date" },
    ],
  },
  {
    group: "Schema-audit additions",
    items: [
      { kind: "has_unread_inbound", label: "Has Unread Inbound" },
      { kind: "needs_human_attention", label: "Needs Human Attention" },
      { kind: "has_open_tasks", label: "Has Open Tasks" },
      { kind: "motivation_level", label: "Motivation Level" },
    ],
  },
] as const;
