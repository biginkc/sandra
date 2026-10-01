import { describe, expect, it, vi } from "vitest";
import { dripHeaderLabel, dripReplyPillLabel, loadMessageDripContext } from "./drip-context";
import goldenFixture from "../../../experiments/inbox-drip-markers/golden-fixture.json";

const orgId = "10000000-0000-4000-8000-000000000001";
const propertyId = "40000000-0000-4000-8000-000000000002";
const enrollmentId = "62000000-0000-4000-8000-000000000002";
const sequenceId = "60000000-0000-4000-8000-000000000001";
const outboundId = "70000000-0000-4000-8000-000000000002";
const inboundId = "70000000-0000-4000-8000-000000000003";

function message(id: string, direction: "inbound" | "outbound", createdAt: string) {
  return { id, direction, created_at: createdAt, property_id: propertyId, campaign_id: null, metadata: {}, body: "fixture", status: "sent" };
}

function client(messages: ReturnType<typeof message>[]) {
  const rows: Record<string, unknown> = {
    sequence_enrollments: [{ id: enrollmentId, sequence_id: sequenceId, status: "paused", pause_reason: "inbound_reply", current_step_index: 1, enrolled_at: "2026-08-21T10:00:00Z", updated_at: "2026-08-21T10:00:00Z" }],
    sequence_step_runs: [{ message_id: outboundId, enrollment_id: enrollmentId, sequence_steps: { step_index: 1, sequence_id: sequenceId }, sequence_enrollments: { sequence_id: sequenceId, org_id: orgId } }],
    sequences: [{ id: sequenceId, name: "Fixture Drip" }],
    sequence_steps: [{ id: "61000000-0000-4000-8000-000000000001", sequence_id: sequenceId }, { id: "61000000-0000-4000-8000-000000000002", sequence_id: sequenceId }, { id: "61000000-0000-4000-8000-000000000003", sequence_id: sequenceId }],
    lead_events: [],
  };
  const from = vi.fn((table: string) => {
    const result = { data: rows[table] ?? [], error: null };
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "order", "gt", "limit"]) builder[method] = vi.fn(() => builder);
    builder.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
    return builder;
  });
  return { from, rpc: vi.fn().mockResolvedValue({ data: false, error: null }) };
}

describe("shared drip context loader", () => {
  it("produces the golden header/pill and exact history wording from real loader inputs", async () => {
    const supabase = client([message(outboundId, "outbound", "2026-09-02T10:00:00Z"), message(inboundId, "inbound", "2026-09-02T10:01:00Z")]);
    const result = await loadMessageDripContext(supabase as never, orgId, propertyId, [
      message(outboundId, "outbound", "2026-09-02T10:00:00Z"),
      message(inboundId, "inbound", "2026-09-02T10:01:00Z"),
    ] as never);
    expect(result.drip).toMatchObject({ name: "Fixture Drip", step: 2, total: 3, replied: true, status: "paused" });
    expect(dripHeaderLabel(result.drip)).toBe(goldenFixture.threadContext["80000000-0000-4000-8000-000000000002"].header);
    expect(dripReplyPillLabel(result.drip)).toBe(goldenFixture.threadContext["80000000-0000-4000-8000-000000000002"].pill);
    expect(result.dripMessageLabels[outboundId]).toBe("Drip · Fixture Drip · text 2 of 3");
    expect(result.dripReplyLabels[inboundId]).toBe("Reply to drip text 2");
    expect(result.dripReplyMessageIds).toEqual([inboundId]);
  });
});
