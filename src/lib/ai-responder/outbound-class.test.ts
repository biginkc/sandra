import { describe, expect, it } from "vitest";

import { classifyOutbound, resolveOutboundVerdict } from "./outbound-class";

const T0 = Date.parse("2026-06-13T18:00:00.000Z");
const ctx = { inboundMessageId: "in-1", inboundCreatedAtMs: T0 };
const row = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  created_at: "2026-06-13T18:00:05.000Z",
  status: "sent",
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
  it("an AI reply stamped with THIS inbound is answered; one for a different inbound is unrelated_ai", () => {
    expect(classifyOutbound(row({ metadata: { generated_by: "ai_responder_v1", inbound_message_id: "in-1" } }), ctx)).toBe("answered");
    expect(classifyOutbound(row({ metadata: { generated_by: "ai_responder_v1", inbound_message_id: "in-2" } }), ctx)).toBe("unrelated_ai");
  });
  it("an AI row for THIS inbound that is still pending is unsent_reply (in flight / abandoned), not answered", () => {
    expect(classifyOutbound(row({ status: "pending", metadata: { generated_by: "ai_responder_v1", inbound_message_id: "in-1" } }), ctx)).toBe("unsent_reply");
    expect(classifyOutbound(row({ status: "queued", metadata: { generated_by: "ai_responder_v1", inbound_message_id: "in-1" } }), ctx)).toBe("answered");
  });
  it("an AI outbound with NO inbound id is unrelated_ai, never a human reply", () => {
    expect(classifyOutbound(row({ metadata: { generated_by: "ai_responder_v1" } }), ctx)).toBe("unrelated_ai");
    expect(classifyOutbound(row({ metadata: { generated_by: "ai_responder_v1" } }), { ...ctx, inboundMessageId: null })).toBe("unrelated_ai");
  });
  it("a human / rep reply at or after the inbound is answered ONLY when sent or delivered", () => {
    expect(classifyOutbound(row({ metadata: { repSms: {} } }), ctx)).toBe("answered");
    expect(classifyOutbound(row({ status: "delivered" }), ctx)).toBe("answered");
    expect(classifyOutbound(row({ status: "queued" }), ctx)).toBe("unsent_reply");
    expect(classifyOutbound(row({ status: "pending" }), ctx)).toBe("unsent_reply");
    expect(classifyOutbound(row({ created_at: "2026-06-13T17:59:00.000Z" }), ctx)).toBe("unrelated_human");
  });
  it("an unknown inbound time or unparseable timestamp is unrelated_human (flag, never silently skip)", () => {
    expect(classifyOutbound(row(), { ...ctx, inboundCreatedAtMs: null })).toBe("unrelated_human");
    expect(classifyOutbound(row({ created_at: "garbage" }), ctx)).toBe("unrelated_human");
  });
});

describe("resolveOutboundVerdict precedence", () => {
  it("already-answered wins over everything", () => {
    expect(resolveOutboundVerdict(["unrelated_ai", "answered", "broadcast", "unsent_reply"])).toBe("already_answered");
  });
  it("else an AI reply to a different inbound (or unrelated human text) flags", () => {
    expect(resolveOutboundVerdict(["broadcast", "unrelated_ai"])).toBe("outbound_since_claim");
    expect(resolveOutboundVerdict(["unrelated_human", "unsent_reply"])).toBe("outbound_since_claim");
  });
  it("else an unsent human reply waits (never a silent skip)", () => {
    expect(resolveOutboundVerdict(["broadcast", "unsent_reply"])).toBe("reply_pending");
  });
  it("else broadcast-only is silent", () => {
    expect(resolveOutboundVerdict(["broadcast", "broadcast"])).toBe("broadcast_since_claim");
  });
});
