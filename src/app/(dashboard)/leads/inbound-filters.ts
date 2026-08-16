export type InboundOwnershipFilter = "all" | "mine" | "unassigned" | string;
export type InboundAttentionFilter = "stale" | "sequence_ended";

export type LeadsInboundParams = {
  assignee?: string;
  unassigned?: string;
  stale?: string;
  sequence_ended?: string;
};

export function resolveInboundLeadFilters(
  params: LeadsInboundParams,
  context: { currentUserId: string | null; teammateIds: string[] },
): {
  ownership: InboundOwnershipFilter;
  attention: InboundAttentionFilter | null;
} {
  let ownership: InboundOwnershipFilter = "all";
  if (params.assignee === "me" && context.currentUserId) {
    ownership = "mine";
  } else if (
    params.assignee &&
    context.teammateIds.includes(params.assignee)
  ) {
    ownership =
      params.assignee === context.currentUserId ? "mine" : params.assignee;
  } else if (params.unassigned === "true") {
    ownership = "unassigned";
  }

  const attention =
    params.stale === "true"
      ? "stale"
      : params.sequence_ended === "true"
        ? "sequence_ended"
        : null;

  return { ownership, attention };
}
