import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClientMock, resolveEligibilityMock, fromMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  resolveEligibilityMock: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));
vi.mock("@/lib/prospects/eligibility", () => ({
  resolveProspectEligibility: resolveEligibilityMock,
}));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));

import { createDialerBatchFromPropertyIds } from "./actions";

describe("Prospects dialer direct-action DNC guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createClientMock.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }) },
      from: fromMock,
    });
    resolveEligibilityMock.mockResolvedValue({
      eligibleIds: [],
      exclusions: [{ propertyId: "locked", reason: "dnc" }],
      dncLockedCount: 1,
      skipTraceDisabledCount: 0,
    });
  });

  it("cannot create a batch or items from a forged DNC-only payload", async () => {
    const result = await createDialerBatchFromPropertyIds(["locked"]);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "NO_ELIGIBLE_PROPERTIES" },
    });
    expect(fromMock).not.toHaveBeenCalledWith("dialer_batches");
    expect(fromMock).not.toHaveBeenCalledWith("dialer_batch_items");
  });

  it("cannot create a batch from a stale or forged non-Prospect id", async () => {
    resolveEligibilityMock.mockResolvedValue({
      eligibleIds: [],
      exclusions: [{ propertyId: "stale-lead", reason: "not_found_or_not_prospect" }],
      dncLockedCount: 0,
      skipTraceDisabledCount: 0,
    });

    const result = await createDialerBatchFromPropertyIds(["stale-lead"]);

    expect(result).toMatchObject({ ok: false, error: { code: "NO_ELIGIBLE_PROPERTIES" } });
    expect(fromMock).not.toHaveBeenCalledWith("dialer_batches");
    expect(fromMock).not.toHaveBeenCalledWith("dialer_batch_items");
  });
});
