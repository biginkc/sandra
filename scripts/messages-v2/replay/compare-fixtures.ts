import type { ReplayExport, ReplayInbound } from "./schema";

export const PROP = "33333333-3333-4333-8333-333333333333";
export const CONV = "44444444-4444-4444-8444-444444444444";

export function inbound(id: string, body: string, receivedAt: string, extra: Partial<ReplayInbound> = {}): ReplayInbound {
  return { id, externalId: id, from: "+19135550001", to: "+18165559999", body, receivedAt, contactId: null, propertyId: PROP, conversationId: CONV, ...extra };
}

export function makeExport(over: Partial<ReplayExport> & { inbound: ReplayInbound[] }): ReplayExport {
  return {
    version: 1, batchId: "t", createdAt: "2026-10-07T12:00:00.000Z", sourceOrgId: "o",
    window: { start: "2026-09-07T12:00:00.000Z", end: "2026-10-07T12:00:00.000Z", days: 30, contextDays: 60 },
    businessNumbers: [],
    tables: { contacts: [], properties: [], property_contacts: [], message_threads: [], messages: [], sms_phone_suppressions: [], consent_events: [], ai_responder_configs: [], jev_outcome_thresholds: [] },
    reference: { pipelineRuns: [], outboundInWindow: [], humanEvents: { runs: [], reviews: [], decisions: [], dispoSets: [] } },
    counts: {},
    ...over,
  };
}
