import { describe, expect, it } from "vitest";

import { classifyOutbound } from "./outbound-class";

const T0 = Date.parse("2026-06-13T18:00:00.000Z");
const ctx = { inboundMessageId: "in-1", inboundCreatedAtMs: T0 };
const row = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  created_at: "2026-06-13T18:00:05.000Z",
  campaign_id: null,
  metadata: null,
  ...over,
});

describe("classifyOutbound", () => {
  it("bulk campaign rows are broadcast", () => {
    expect(classifyOutbound(row({ campaign_id: "c1" }), ctx)).toBe("broadcast");
  });
  it("Norma pre-call, sequence tick stamp and seller reminders are broadcast", () => {
    expect(classifyOutbound(row({ metadata: { generated_by: "norma_precall" } }), ctx)).toBe("broadcast");
    expect(classifyOutbound(row({ metadata: { generated_by: "sequence_tick" } }), ctx)).toBe("broadcast");
    expect(classifyOutbound(row({ metadata: { kind: "seller_appointment_reminder" } }), ctx)).toBe("broadcast");
  });
  it("a row linked from sequence_step_runs is broadcast even without a stamp", () => {
    expect(classifyOutbound(row(), { ...ctx, sequenceMessageIds: new Set(["m1"]) })).toBe("broadcast");
  });
  it("an AI reply stamped with THIS inbound is answered; one for a different inbound is unrelated", () => {
    expect(classifyOutbound(row({ metadata: { generated_by: "ai_responder_v1", inbound_message_id: "in-1" } }), ctx)).toBe("answered");
    expect(classifyOutbound(row({ metadata: { generated_by: "ai_responder_v1", inbound_message_id: "in-2" } }), ctx)).toBe("unrelated");
  });
  it("a human / rep reply created at or after the inbound is answered; before it is unrelated", () => {
    expect(classifyOutbound(row({ metadata: { repSms: {} } }), ctx)).toBe("answered");
    expect(classifyOutbound(row({ created_at: "2026-06-13T17:59:00.000Z" }), ctx)).toBe("unrelated");
  });
  it("an unknown inbound time or unparseable timestamp is unrelated (flag, never silently skip)", () => {
    expect(classifyOutbound(row(), { ...ctx, inboundCreatedAtMs: null })).toBe("unrelated");
    expect(classifyOutbound(row({ created_at: "garbage" }), ctx)).toBe("unrelated");
  });
});
