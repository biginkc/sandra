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

describe("markPropertyNeedsAttention on an already-held lead (reviews B-1 / B-1', N-2, N-3)", () => {
  beforeEach(() => vi.clearAllMocks());
  const heldClient = (rpcResult: { data: unknown; error: { message: string } | null }) => {
    const { client } = makeClient([{ data: null, error: null }]);
    const rpc = vi.fn(async () => rpcResult);
    return { client: { ...client, rpc }, rpc };
  };

  it("0 rows: writes the hold through routing_v2_write_hold as safety, with no read first", async () => {
    const { client, rpc } = heldClient({ data: "upgraded", error: null });
    expect(await markPropertyNeedsAttention(client as never, "property-1", "legal_threat")).toBe(true);
    expect(rpc).toHaveBeenCalledWith("routing_v2_write_hold", { p_property_id: "property-1", p_inbound_message_id: null, p_reason: "legal_threat", p_kind: "safety" });
    expect(client.from).toHaveBeenCalledTimes(1);
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("0 rows and the lead became unheld meanwhile: the safety write holds it, and it is recorded as this call's escalation", async () => {
    const { client } = heldClient({ data: "held", error: null });
    expect(await markPropertyNeedsAttention(client as never, "property-1", "nine_asked_stop")).toBe(true);
    expect(recordLeadEvent).toHaveBeenCalledTimes(1);
  });

  it("a real upgrade error returns false so callers retry (N-2)", async () => {
    const { client } = heldClient({ data: null, error: { message: "deadlock detected" } });
    expect(await markPropertyNeedsAttention(client as never, "property-1", "nine_asked_stop")).toBe(false);
  });
});
