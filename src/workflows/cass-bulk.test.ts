import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimAuthorizedCassJobStart: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/enrichment/cass-job", () => ({
  claimAuthorizedCassJobStart: mocks.claimAuthorizedCassJobStart,
  finalizeCassJob: vi.fn(),
  runCassChunk: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));

import { loadCassJobIds } from "./cass-bulk";

function makeClient(propertyIds = ["property-a", "property-b"]) {
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
              input_params: { property_ids: propertyIds },
            },
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
    mocks.claimAuthorizedCassJobStart.mockReset();
    mocks.claimAuthorizedCassJobStart.mockResolvedValue("claim-a");
    mocks.createAdminClient.mockReset();
  });

  it("lets the atomic receipt claim reject a mixed-tenant target list", async () => {
    mocks.createAdminClient.mockReturnValue(makeClient());
    mocks.claimAuthorizedCassJobStart.mockRejectedValueOnce(
      new Error("CASS_JOB_TARGETS_INVALID"),
    );

    await expect(loadCassJobIds("job-a")).rejects.toThrow(
      "CASS_JOB_TARGETS_INVALID",
    );
  });

  it("returns immutable tenant provenance for an entirely owned job", async () => {
    mocks.createAdminClient.mockReturnValue(
      makeClient(),
    );

    await expect(loadCassJobIds("job-a")).resolves.toEqual({
      orgId: "org-a",
      propertyIds: ["property-a", "property-b"],
    });
    expect(mocks.claimAuthorizedCassJobStart).toHaveBeenCalledWith(expect.anything(), {
      jobId: "job-a",
      orgId: "org-a",
      claimToken: undefined,
    });
  });

  it("passes the user action's start receipt through to the service workflow", async () => {
    mocks.createAdminClient.mockReturnValue(
      makeClient(),
    );

    await loadCassJobIds("job-a", "claim-from-action");

    expect(mocks.claimAuthorizedCassJobStart).toHaveBeenCalledWith(
      expect.anything(),
      {
        jobId: "job-a",
        orgId: "org-a",
        claimToken: "claim-from-action",
      },
    );
  });

  it("loads all 11,134 receipt-backed targets without a capped REST ownership read", async () => {
    const propertyIds = Array.from({ length: 11_134 }, (_, index) =>
      `property-${index}`,
    );
    const client = makeClient(propertyIds);
    mocks.createAdminClient.mockReturnValue(client);

    const loaded = await loadCassJobIds("job-a", "claim-from-action");

    expect(loaded.propertyIds).toHaveLength(11_134);
    expect(loaded.propertyIds.at(-1)).toBe("property-11133");
    expect(client.from).toHaveBeenCalledTimes(1);
  });
});
