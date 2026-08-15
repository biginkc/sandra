import type { PropertyStatus } from "./actions";

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

type AttentionLead = { id: string; status: string };
type AttentionMessage = {
  property_id: string | null;
  direction: string;
  created_at: string;
};
type CompletedEnrollment = {
  property_id: string | null;
  completed_at: string | null;
};

export function deriveAttentionLeadIds({
  leads,
  messages,
  completedEnrollments,
  now,
}: {
  leads: AttentionLead[];
  messages: AttentionMessage[];
  completedEnrollments: CompletedEnrollment[];
  now: Date;
}): { stale: string[]; sequenceEnded: string[] } {
  const messagesByProperty = new Map<string, AttentionMessage[]>();
  for (const message of messages) {
    if (!message.property_id) continue;
    const rows = messagesByProperty.get(message.property_id) ?? [];
    rows.push(message);
    messagesByProperty.set(message.property_id, rows);
  }

  const staleCutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const staleExcluded = new Set<PropertyStatus>([
    "prospect",
    "under_contract",
    "closed",
    "dead",
  ]);
  const stale = leads
    .filter((lead) => !staleExcluded.has(lead.status as PropertyStatus))
    .filter((lead) => {
      const rows = messagesByProperty.get(lead.id) ?? [];
      const inboundTimes = rows
        .filter((message) => message.direction === "inbound")
        .map((message) => Date.parse(message.created_at))
        .filter(Number.isFinite);
      // This deliberately mirrors dashboard_summary(): at least one inbound
      // is older than seven days, and no outbound is newer than the most
      // recent inbound. It is not equivalent to "latest inbound is old."
      if (!inboundTimes.some((createdAt) => createdAt < staleCutoff)) {
        return false;
      }
      const latestInboundAt = Math.max(...inboundTimes);
      return !rows.some(
        (message) =>
          message.direction === "outbound" &&
          Date.parse(message.created_at) > latestInboundAt,
      );
    })
    .map((lead) => lead.id);

  const shownLeadIds = new Set(leads.map((lead) => lead.id));
  const sequenceCutoff = now.getTime() - 24 * 60 * 60 * 1000;
  const sequenceEndedSet = new Set<string>();
  for (const enrollment of completedEnrollments) {
    if (!enrollment.property_id || !enrollment.completed_at) continue;
    if (!shownLeadIds.has(enrollment.property_id)) continue;
    const completedAt = Date.parse(enrollment.completed_at);
    if (!Number.isFinite(completedAt) || completedAt >= sequenceCutoff) continue;
    const hasLaterOutbound = (
      messagesByProperty.get(enrollment.property_id) ?? []
    ).some(
      (message) =>
        message.direction === "outbound" &&
        Date.parse(message.created_at) > completedAt,
    );
    if (!hasLaterOutbound) sequenceEndedSet.add(enrollment.property_id);
  }

  return {
    stale,
    sequenceEnded: leads
      .map((lead) => lead.id)
      .filter((id) => sequenceEndedSet.has(id)),
  };
}
