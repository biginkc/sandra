import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordLeadEvent } = vi.hoisted(() => ({
  recordLeadEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: { AI_ESCALATED: "ai_escalated" },
  recordLeadEvent,
}));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { markPropertyNeedsAttention } from "./dispatch";

function makeClient(results: Array<{
  data: { id: string } | null;
  error: { message: string } | null;
}>) {
  const eq = vi.fn(() => builder);
  const builder = {
    update: vi.fn(() => builder),
    eq,
    select: vi.fn(() => builder),
    maybeSingle: vi.fn(() =>
      Promise.resolve(results.shift() ?? { data: null, error: null }),
    ),
  };
  return { client: { from: vi.fn(() => builder) }, eq };
}

describe("markPropertyNeedsAttention ledger", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records the first confirmed AI escalation and suppresses a repeated no-op", async () => {
    const { client, eq } = makeClient([
      { data: { id: "property-1" }, error: null },
      { data: null, error: null },
    ]);

    await markPropertyNeedsAttention(client as never, "property-1", "low_confidence");
    await markPropertyNeedsAttention(client as never, "property-1", "second_reason");

    expect(eq).toHaveBeenCalledWith("needs_human_attention", false);
    expect(recordLeadEvent).toHaveBeenCalledTimes(1);
    expect(recordLeadEvent).toHaveBeenCalledWith({
      propertyId: "property-1",
      actorType: "ai",
      eventType: "ai_escalated",
      payload: { from: false, to: true, reason: "low_confidence" },
    });
  });

  it("does not record a failed escalation update", async () => {
    const { client } = makeClient([
      { data: null, error: { message: "write failed" } },
    ]);

    await markPropertyNeedsAttention(client as never, "property-1", "low_confidence");
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });
});
