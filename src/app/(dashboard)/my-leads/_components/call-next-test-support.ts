import type { CallNextRow, CallNextReason, CallNextTier } from "@/lib/my-leads/call-next";
import type { QueueRow } from "@/lib/my-leads/queries";

export const SNAPSHOT_AT = "2026-10-05T15:00:00Z";

export function queueRowFixture(propertyId: string, over: Partial<QueueRow> = {}): QueueRow {
  return {
    propertyId,
    stage: "contacted",
    queueVersion: 1,
    sharedStatus: "new_lead",
    assignmentEpisodeId: `episode-${propertyId}`,
    assignedAt: "2026-09-01T12:00:00Z",
    initializedAt: "2026-09-01T12:00:00Z",
    episodeKind: "live",
    clockEligible: true,
    firstCallAt: null,
    stageEnteredAt: "2026-09-02T12:00:00Z",
    address: `${propertyId} Main St`,
    city: "Kansas City",
    state: "MO",
    homeownerName: `Owner ${propertyId}`,
    phone: "+18165550100",
    contactId: `contact-${propertyId}`,
    phones: ["+18165550100"],
    contactDnc: false,
    temperature: null,
    motivationKind: null,
    motivationText: null,
    warningReasons: [],
    nextStepAt: null,
    nextStepType: null,
    offer: null,
    attemptsCount: 0,
    ...over,
  };
}

export function stripItem(
  propertyId: string,
  reason: CallNextReason = "longest_since_touch",
  over: Partial<CallNextRow> = {},
): CallNextRow {
  const tier: CallNextTier = reason === "pinned_call_today" ? 0 : reason.startsWith("appointment") ? 1 : reason.startsWith("inbound") ? 2 : reason === "needs_offer" || reason === "offer_follow_up_overdue" ? 3 : reason.endsWith("going_cold") || reason === "missed_callback" ? 4 : 5;
  return {
    propertyId,
    tier,
    reason,
    reasonAt: "2026-10-03T15:00:00Z",
    pinned: reason === "pinned_call_today",
    lastTouchAt: "2026-10-03T15:00:00Z",
    row: queueRowFixture(propertyId),
    ...over,
  };
}
