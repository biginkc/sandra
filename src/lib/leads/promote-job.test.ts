import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordLeadEvents } = vi.hoisted(() => ({
  recordLeadEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: { QUALIFIED: "qualified" },
  recordLeadEvents,
}));

import { runPromoteLeadsChunk } from "./promote-job";

function item(label: string) {
  return {
    id: `00000000-0000-4000-8000-0000000000${label}`,
    itemKey: `property-${label}`,
    propertyId: `10000000-0000-4000-8000-0000000000${label}`,
  };
}

describe("runPromoteLeadsChunk", () => {
  beforeEach(() => {
    recordLeadEvents.mockClear();
  });

  it("processes each durable item by job id + item key", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: { outcome: "promoted" }, error: null });
    const outcomes = await runPromoteLeadsChunk({ rpc } as never, {
      jobId: "job-1",
      actorId: "actor-1",
      items: [item("01"), item("02")],
    });

    expect(outcomes).toEqual([
      { itemKey: "property-01", outcome: "promoted" },
      { itemKey: "property-02", outcome: "promoted" },
    ]);
    expect(rpc).toHaveBeenNthCalledWith(1, "process_promote_leads_item", {
      p_job: "job-1",
      p_item_key: "property-01",
    });
    expect(recordLeadEvents).toHaveBeenCalledTimes(1);
    const events = recordLeadEvents.mock.calls[0]?.[0];
    expect(events).toHaveLength(2);
    expect(events).toEqual([
      expect.objectContaining({
        propertyId: item("01").propertyId,
        actorType: "user",
        actorId: "actor-1",
        eventType: "qualified",
        payload: expect.objectContaining({
          from: "prospect",
          to: "new_lead",
          batch_count: 2,
        }),
        sourceType: "job_items.qualified",
        sourceId: item("01").id,
      }),
      expect.objectContaining({
        propertyId: item("02").propertyId,
        sourceId: item("02").id,
      }),
    ]);
    const batchIds = new Set(
      events.map(
        (event: { payload: { batch_id: string } }) => event.payload.batch_id,
      ),
    );
    expect(batchIds.size).toBe(1);
    expect([...batchIds][0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("checkpoints an item failure and continues the background chunk", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: { message: "synthetic row failure" },
      })
      .mockResolvedValueOnce({ data: { failed: 1 }, error: null })
      .mockResolvedValueOnce({
        data: { outcome: "already_lead" },
        error: null,
      });

    const outcomes = await runPromoteLeadsChunk({ rpc } as never, {
      jobId: "job-2",
      actorId: "actor-2",
      items: [item("03"), item("04")],
    });

    expect(outcomes).toEqual([
      { itemKey: "property-03", outcome: "failed" },
      { itemKey: "property-04", outcome: "already_lead" },
    ]);
    expect(rpc).toHaveBeenNthCalledWith(2, "fail_promote_leads_item", {
      p_job: "job-2",
      p_item_key: "property-03",
      p_error: "synthetic row failure",
    });
    expect(recordLeadEvents).not.toHaveBeenCalled();
  });

  it("throws when the durable failure checkpoint itself cannot be written", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: { message: "process failed" },
      })
      .mockResolvedValueOnce({
        data: null,
        error: { message: "checkpoint failed" },
      });

    await expect(
      runPromoteLeadsChunk({ rpc } as never, {
        jobId: "job-3",
        actorId: "actor-3",
        items: [item("05")],
      }),
    ).rejects.toThrow(/checkpoint failed/i);
    expect(recordLeadEvents).not.toHaveBeenCalled();
  });
});
