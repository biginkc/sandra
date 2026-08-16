import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  beginCassJob: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/enrichment/cass-job", () => ({
  beginCassJob: mocks.beginCassJob,
  finalizeCassJob: vi.fn(),
  runCassChunk: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));

import { loadCassJobIds } from "./cass-bulk";

function makeClient(ownedPropertyIds: string[]) {
  return {
    from: vi.fn((table: string) => {
      if (table === "jobs") {
        const builder: Record<string, unknown> = {};
        builder.select = () => builder;
        builder.eq = () => builder;
        builder.single = () =>
          Promise.resolve({
            data: {
              id: "job-a",
              org_id: "org-a",
              type: "cass_dsf2_ncoa",
              status: "queued",
              input_params: { property_ids: ["property-a", "property-b"] },
            },
            error: null,
          });
        return builder;
      }
      if (table === "properties") {
        const builder: Record<string, unknown> = {};
        builder.select = () => builder;
        builder.eq = () => builder;
        builder.in = () =>
          Promise.resolve({
            data: ownedPropertyIds.map((id) => ({ id })),
            error: null,
          });
        return builder;
      }
      throw new Error(`Unexpected table ${table}`);
    }),
  };
}

describe("CASS workflow tenant provenance", () => {
  beforeEach(() => {
    mocks.beginCassJob.mockReset();
    mocks.createAdminClient.mockReset();
  });

  it("rejects a mixed-tenant property list before starting any paid work", async () => {
    mocks.createAdminClient.mockReturnValue(makeClient(["property-a"]));

    await expect(loadCassJobIds("job-a")).rejects.toThrow(
      "1 property ID(s) do not belong to job organization",
    );
    expect(mocks.beginCassJob).not.toHaveBeenCalled();
  });

  it("returns immutable tenant provenance for an entirely owned job", async () => {
    mocks.createAdminClient.mockReturnValue(
      makeClient(["property-a", "property-b"]),
    );

    await expect(loadCassJobIds("job-a")).resolves.toEqual({
      orgId: "org-a",
      propertyIds: ["property-a", "property-b"],
    });
    expect(mocks.beginCassJob).toHaveBeenCalledWith(expect.anything(), {
      jobId: "job-a",
      totalItems: 2,
    });
  });
});
