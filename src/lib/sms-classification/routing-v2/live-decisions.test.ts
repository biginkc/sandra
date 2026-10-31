import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import type { V2Classification } from "./classify";
import { liveDecisionRow, recordLiveV2Decision } from "./live-decisions";
import { V2_QUESTION_IDS } from "./questions";
const context = { orgId: "org", propertyId: "property", conversationId: null, inboundMessageId: "inbound", expectedRevision: 7 };
const result: Extract<V2Classification, { kind: "decided" }> = {
  kind: "decided",
  decision: { road: "book_appointment", provenance: { by: "jev", row: "1", step: "yes", signal: "just_ok", probability: 0.65 }, haiku: "decider_band", opportunityAlert: true },
  final: { road: "stop", by: "haiku", hold: true, alert: "Possible stop request — please check", failureReason: null },
  action: { road: "possible_stop", steps: [{ kind: "hold", reason: "asked_stop" }, { kind: "alert", reason: "possible_stop" }] },
  probabilities: Object.fromEntries(V2_QUESTION_IDS.map((id) => [id, 0.01])) as Record<typeof V2_QUESTION_IDS[number], number>,
  propertyType: { residential: 1, commercial: 0, lot: 0, rental: 0, didnt_say: 0 },
  haiku: { ok: true, option: "asked_stop", confidence: 0.9 }, model: "fixture", latencyMs: 10, priceOutcome: null,
};
describe("live decision evidence", () => {
  it("keeps the actionable hold separate from original Jev provenance", () => {
    expect(liveDecisionRow(context, result)).toMatchObject({
      road: "possible_stop", jev_road: "book_appointment", expected_revision: 7,
      provenance: { by: "jev", signal: "just_ok", probability: 0.65 },
      haiku: { final_by: "haiku", final_road: "stop", hold: true, attempts: null },
    });
  });
  it("failure rows never carry a route or opportunity permission", () => {
    const row = liveDecisionRow(context, { kind: "failed", reason: "jev_failed" });
    expect(row).toMatchObject({ status: "failed", failure_reason: "jev_failed" });
    expect(row).not.toHaveProperty("road"); expect(row).not.toHaveProperty("opportunity_alert");
  });
  it.each([-1, NaN, 0.5, Infinity])("refuses an invalid expected revision %s", (expectedRevision) => {
    expect(() => liveDecisionRow({ ...context, expectedRevision }, result)).toThrow("context_invalid");
  });
  it("writes only live evidence and never overwrites duplicate decisions", async () => {
    const insert = vi.fn(async () => ({ error: { code: "23505" } }));
    const from = vi.fn(() => ({ insert }));
    const db = { from } as unknown as SupabaseClient<Database>;
    expect(await recordLiveV2Decision(db, context, result)).toBe("duplicate");
    expect(from).toHaveBeenCalledExactlyOnceWith("routing_v2_live_decisions");
    expect(insert).toHaveBeenCalledTimes(1);
  });
  it("failed persistence cannot authorize execution", async () => {
    const db = { from: () => ({ insert: async () => { throw new Error("db unavailable"); } }) } as unknown as SupabaseClient<Database>;
    expect(await recordLiveV2Decision(db, context, result)).toBe("failed");
  });
});
