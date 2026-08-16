import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  assignUnsafe,
  createClientMock,
  preflightUnsafe,
  requestUnsafe,
  verifyUnsafe,
} = vi.hoisted(() => ({
  assignUnsafe: vi.fn(),
  createClientMock: vi.fn(),
  preflightUnsafe: vi.fn(),
  requestUnsafe: vi.fn(),
  verifyUnsafe: vi.fn(),
}));

vi.mock("../leads/actions", () => ({
  addPropertiesToListBulk: vi.fn(),
  applyTagBulk: vi.fn(),
  assignLeadsBulk: assignUnsafe,
  createAndApplyCustomTagBulk: vi.fn(),
  deletePropertiesBulk: vi.fn(),
  qualifyLeadsBulk: vi.fn(),
  removePropertiesFromListBulk: vi.fn(),
  verifyPropertiesBulk: verifyUnsafe,
}));

vi.mock("@/lib/skip-trace/actions", () => ({
  preflightSkipTrace: preflightUnsafe,
  requestSkipTrace: requestUnsafe,
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));
vi.mock("./actions", () => ({ getAllMatchingProspectIds: vi.fn() }));

import {
  assignLeadsBulk,
  preflightProspectSkipTrace,
  requestProspectSkipTrace,
  verifyPropertiesBulk,
} from "./dnc-safe-actions";

function queryResult(data: unknown) {
  const promise = Promise.resolve({ data, error: null });
  const builder = {
    select: vi.fn(),
    in: vi.fn(),
    eq: vi.fn(),
    or: vi.fn(),
    is: vi.fn(),
    then: promise.then.bind(promise),
  };
  builder.select.mockReturnValue(builder);
  builder.in.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.or.mockReturnValue(builder);
  builder.is.mockReturnValue(builder);
  return builder;
}

describe("Prospects DNC-safe bulk actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assignUnsafe.mockResolvedValue({
      ok: true,
      data: { succeeded: 1, skipped: 0, failed: [] },
    });
    verifyUnsafe.mockResolvedValue({ ok: true, data: { jobId: "cass-job" } });
    preflightUnsafe.mockResolvedValue({
      ok: true,
      data: {
        requested: 1,
        eligible: 1,
        cassVerified: 1,
        cassUnverified: 0,
        notEligible: 0,
        killSwitchSkipped: 0,
        tracefyCreditsRequired: 1,
        tracefyCreditsAvailable: 10,
        tracefyCreditStatus: "sufficient",
        canLaunchSkipTrace: true,
        estimatedCassVerificationCostUsd: 0,
        cassVerificationPropertyIds: [],
      },
    });
    requestUnsafe.mockResolvedValue({
      ok: true,
      data: {
        jobId: "skip-job",
        status: "queued",
        requested: 1,
        eligible: 1,
        cassSkipped: 0,
        killSwitchSkipped: 0,
      },
    });
    createClientMock.mockResolvedValue({
      from: vi.fn((table: string) =>
        table === "properties"
          ? queryResult([
              {
                id: "locked",
                status: "closed",
                is_dnc_locked: true,
                skip_trace_disabled: false,
              },
              {
                id: "eligible",
                status: "prospect",
                is_dnc_locked: false,
                skip_trace_disabled: false,
              },
            ])
          : queryResult([]),
      ),
    });
  });

  it("rechecks DNC on the server and never forwards the locked ID to a mutation", async () => {
    const result = await assignLeadsBulk(["locked", "eligible"], "user-1");

    expect(assignUnsafe).toHaveBeenCalledWith(["eligible"], "user-1");
    expect(result).toEqual({
      ok: true,
      data: {
        succeeded: 1,
        skipped: 0,
        failed: [{
          propertyId: "locked",
          message: "Prospect is locked Do Not Contact and cannot be changed in bulk.",
        }],
      },
    });
  });

  it("does not start CASS when a forged stale ID is now DNC", async () => {
    const result = await verifyPropertiesBulk(["locked"], "request-key");

    expect(verifyUnsafe).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      error: {
        code: "DNC_LOCKED",
        message: "Prospect is locked Do Not Contact and cannot be changed in bulk.",
      },
    });
  });

  it("filters DNC before skip-trace preflight can check credits", async () => {
    const result = await preflightProspectSkipTrace(["locked", "eligible"]);

    expect(preflightUnsafe).toHaveBeenCalledWith(["eligible"]);
    expect(result.ok && result.data.dncLockedSkipped).toBe(1);
  });

  it("does not request skip trace when every forged ID is DNC", async () => {
    const result = await requestProspectSkipTrace(["locked"]);

    expect(requestUnsafe).not.toHaveBeenCalled();
    expect(result.ok && result.data.status).toBe("none_eligible");
    expect(result.ok && result.data.dncLockedSkipped).toBe(1);
  });
});
