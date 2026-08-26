import { beforeEach, describe, expect, it, vi } from "vitest";

const { enrollLeadMock, recordLeadEvents } = vi.hoisted(() => ({
  enrollLeadMock: vi.fn(),
  recordLeadEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/sequences/enrollment", () => ({ enrollLead: enrollLeadMock }));
vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: { SEQUENCE_ENROLLED: "sequence_enrolled" },
  recordLeadEvents,
}));

import { enrollJobBatch } from "./csv-import";

type JobItem = {
  id: string;
  property_id: string;
  compliance_locked: boolean;
};

function makeSupabase(itemCount: number, failAfterFirstPage = false) {
  const items: JobItem[] = Array.from({ length: itemCount }, (_, index) => ({
    id: `item-${String(index + 1).padStart(5, "0")}`,
    property_id: `property-${String(index + 1).padStart(5, "0")}`,
    compliance_locked: false,
  }));

  return {
    from: vi.fn((table: string) => {
      let lastId: string | null = null;
      let limit: number | null = null;
      let selectedIds: string[] = [];
      const builder = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: (value: number) => {
          limit = value;
          return builder;
        },
        gt: (_column: string, value: string) => {
          lastId = value;
          return builder;
        },
        in: (column: string, values: string[]) => {
          if (column === "id") selectedIds = values;
          return builder;
        },
        then: (
          resolve: (value: {
            data: unknown[] | null;
            error: { message: string } | null;
          }) => unknown,
        ) => {
          if (table === "job_items") {
            if (failAfterFirstPage && lastId) {
              return Promise.resolve({
                data: null,
                error: { message: "page two unavailable" },
              }).then(resolve);
            }
            const start = lastId
              ? items.findIndex((item) => item.id === lastId) + 1
              : 0;
            // Model PostgREST's default 1,000-row response cap when the
            // production query does not explicitly page.
            const pageSize = limit ?? 1_000;
            return Promise.resolve({
              data: items.slice(start, start + pageSize),
              error: null,
            }).then(resolve);
          }
          if (table === "properties") {
            return Promise.resolve({
              data: selectedIds.map((id) => ({
                id,
                outreach_dispo: null,
                homeowner: null,
              })),
              error: null,
            }).then(resolve);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve);
        },
      };
      return builder;
    }),
  };
}

describe("enrollJobBatch paging", () => {
  beforeEach(() => {
    enrollLeadMock.mockReset();
    recordLeadEvents.mockClear();
    enrollLeadMock.mockImplementation(
      async (_client: unknown, input: { propertyId: string }) => ({
        status: "enrolled",
        enrollmentId: `enrollment-${input.propertyId}`,
        sequenceLabel: "Import sequence",
      }),
    );
  });

  it("enrolls every eligible property when a job has more than 1,000 items", async () => {
    const result = await enrollJobBatch(makeSupabase(1_205) as never, {
      jobId: "job-1",
      sequenceId: "sequence-1",
      orgId: "org-1",
    });

    expect(result).toEqual({ enrolled: 1_205, skipped: 0, failed: 0 });
    expect(enrollLeadMock).toHaveBeenCalledTimes(1_205);
    expect(enrollLeadMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ deferEvent: true }),
    );
    expect(recordLeadEvents).toHaveBeenCalledTimes(1);
    const events = recordLeadEvents.mock.calls[0]?.[0] as Array<{
      propertyId: string;
      actorType: string;
      eventType: string;
      payload: Record<string, unknown>;
      sourceType: string;
      sourceId: string;
    }>;
    expect(events).toHaveLength(1_205);
    const batchId = events[0]?.payload.batch_id;
    expect(batchId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    for (let index = 0; index < events.length; index++) {
      const ordinal = String(index + 1).padStart(5, "0");
      expect(events[index]).toEqual({
        propertyId: `property-${ordinal}`,
        actorType: "system",
        eventType: "sequence_enrolled",
        payload: {
          enrollment_id: `enrollment-property-${ordinal}`,
          sequence_id: "sequence-1",
          label: "Import sequence",
          batch_id: batchId,
          batch_count: 1_205,
        },
        sourceType: "sequence_enrollments.created",
        sourceId: `enrollment-property-${ordinal}`,
      });
    }
  });

  it("fails closed when a later job-item page cannot be read", async () => {
    await expect(
      enrollJobBatch(makeSupabase(1_205, true) as never, {
        jobId: "job-1",
        sequenceId: "sequence-1",
        orgId: "org-1",
      }),
    ).rejects.toThrow("page two unavailable");
  });
});
