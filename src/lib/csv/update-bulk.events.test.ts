import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSubOperation, matchPropertyByAddress, recordLeadEvents } =
  vi.hoisted(() => ({
    getSubOperation: vi.fn(),
    matchPropertyByAddress: vi.fn(),
    recordLeadEvents: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock("./match-by-address", () => ({ matchPropertyByAddress }));
vi.mock("./update-operations", () => ({ getSubOperation }));
vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: {
    MOTIVATION_CHANGED: "motivation_changed",
    STATUS_CHANGED: "status_changed",
    TAG_APPLIED: "tag_applied",
  },
  recordLeadEvents,
}));

import { applyBulkUpdate } from "./update-bulk";

function makeSupabase() {
  const eq = vi.fn().mockResolvedValue({ data: null, error: null });
  return {
    from: vi.fn(() => ({
      update: vi.fn(() => ({ eq })),
    })),
  };
}

describe("applyBulkUpdate lead activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    matchPropertyByAddress.mockImplementation(
      async (_supabase: unknown, input: { address: string }) => ({
        kind: "matched",
        property: {
          id: `property-${input.address}`,
          org_id: "org-1",
          status: "new_lead",
          motivation_level: null,
        },
      }),
    );
  });

  it("records only confirmed status changes with one truthful batch", async () => {
    const apply = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "updated",
        rowIndex: 0,
        address: "A",
        before: { status: "new_lead" },
        after: { status: "contacted" },
      })
      .mockResolvedValueOnce({
        kind: "unchanged",
        rowIndex: 1,
        address: "B",
        reason: "no-change",
      })
      .mockResolvedValueOnce({
        kind: "updated",
        rowIndex: 2,
        address: "C",
        before: { status: "interested" },
        after: { status: "contacted" },
      });
    getSubOperation.mockReturnValue({ apply });

    await applyBulkUpdate(makeSupabase() as never, {
      subOperationId: "update-property-status",
      rows: [{ Address: "A" }, { Address: "B" }, { Address: "C" }],
      userId: "user-1",
      jobId: "job-1",
    });

    expect(recordLeadEvents).toHaveBeenCalledTimes(1);
    const events = recordLeadEvents.mock.calls[0]?.[0];
    expect(events).toHaveLength(2);
    expect(events).toEqual([
      expect.objectContaining({
        propertyId: "property-A",
        actorType: "user",
        actorId: "user-1",
        eventType: "status_changed",
        payload: expect.objectContaining({
          from: "new_lead",
          to: "contacted",
          batch_count: 2,
        }),
      }),
      expect.objectContaining({
        propertyId: "property-C",
        eventType: "status_changed",
        payload: expect.objectContaining({
          from: "interested",
          to: "contacted",
          batch_count: 2,
        }),
      }),
    ]);
    const batchIds = new Set(
      events.map((event: { payload: { batch_id: string } }) =>
        event.payload.batch_id,
      ),
    );
    expect(batchIds.size).toBe(1);
  });

  it("counts newly inserted tag associations per tag and skips conflicts", async () => {
    const apply = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "updated",
        rowIndex: 0,
        address: "A",
        before: {},
        after: {
          tags: [
            { id: "tag-hot", label: "Hot" },
            { id: "tag-probate", label: "Probate" },
          ],
        },
      })
      .mockResolvedValueOnce({
        kind: "unchanged",
        rowIndex: 1,
        address: "B",
        reason: "no-change",
      })
      .mockResolvedValueOnce({
        kind: "updated",
        rowIndex: 2,
        address: "C",
        before: {},
        after: { tags: [{ id: "tag-hot", label: "Hot" }] },
      });
    getSubOperation.mockReturnValue({ apply });

    await applyBulkUpdate(makeSupabase() as never, {
      subOperationId: "tag-existing-properties",
      rows: [{ Address: "A" }, { Address: "B" }, { Address: "C" }],
      userId: "user-2",
      jobId: "job-2",
    });

    const events = recordLeadEvents.mock.calls[0]?.[0];
    expect(events).toHaveLength(3);
    expect(
      events.filter(
        (event: { payload: { tag_id: string } }) =>
          event.payload.tag_id === "tag-hot",
      ),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ batch_count: 2, label: "Hot" }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({ batch_count: 2, label: "Hot" }),
      }),
    ]);
    expect(
      events.find(
        (event: { payload: { tag_id: string } }) =>
          event.payload.tag_id === "tag-probate",
      ),
    ).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          batch_count: 1,
          label: "Probate",
        }),
      }),
    );
  });

  it("does not fabricate user activity when no initiating user is present", async () => {
    getSubOperation.mockReturnValue({
      apply: vi.fn().mockResolvedValue({
        kind: "updated",
        rowIndex: 0,
        address: "A",
        before: { motivation_level: null },
        after: { motivation_level: "hot" },
      }),
    });

    await applyBulkUpdate(makeSupabase() as never, {
      subOperationId: "update-motivation-level",
      rows: [{ Address: "A" }],
      userId: null,
      jobId: "job-3",
    });

    expect(recordLeadEvents).not.toHaveBeenCalled();
  });
});
