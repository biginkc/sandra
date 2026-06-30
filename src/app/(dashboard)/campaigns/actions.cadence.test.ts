import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAdminClient,
  createClient,
  getCallerMemberships,
  revalidatePath,
} = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  createClient: vi.fn(),
  getCallerMemberships: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient,
}));

vi.mock("@/app/(dashboard)/properties/actions", () => ({
  bulkQueueSms: vi.fn(),
  getAllMatchingProspectIds: vi.fn(),
}));

vi.mock("@/lib/auth/memberships", () => ({
  getCallerMemberships,
}));

vi.mock("@/lib/errors/report", () => ({
  reportError: vi.fn(),
}));

import {
  applyCampaignCadenceChange,
  previewCampaignCadenceChange,
} from "./actions";

const rpcRow = {
  affected_count: "3",
  first_scheduled_for: "2026-06-30T18:05:00.000Z",
  last_scheduled_for: "2026-06-30T18:05:16.000Z",
};

function campaignLookupClient(orgId = "org-1") {
  const maybeSingle = vi
    .fn()
    .mockResolvedValue({ data: { org_id: orgId }, error: null });
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { from };
}

describe("campaign cadence actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("previews cadence changes without requiring write confirmation", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [rpcRow], error: null });
    createClient.mockResolvedValue({ rpc });

    const result = await previewCampaignCadenceChange(" campaign-1 ", 8);

    expect(result).toEqual({
      ok: true,
      data: {
        affectedCount: 3,
        firstScheduledFor: "2026-06-30T18:05:00.000Z",
        lastScheduledFor: "2026-06-30T18:05:16.000Z",
        paceSeconds: 8,
        startAfterSeconds: 300,
      },
    });
    expect(rpc).toHaveBeenCalledWith("preview_campaign_cadence_reschedule", {
      p_campaign_id: "campaign-1",
      p_pace_seconds: 8,
      p_start_after_seconds: 300,
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses to apply cadence changes without explicit operator confirmation", async () => {
    const result = await applyCampaignCadenceChange("campaign-1", 8, false);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("OPERATOR_CONFIRMATION_REQUIRED");
    expect(createClient).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("refuses confirmed cadence changes when the caller is not a campaign org member", async () => {
    createClient.mockResolvedValue(campaignLookupClient("org-1"));
    getCallerMemberships.mockResolvedValue([
      { user_id: "user-1", org_id: "org-2", role: "member" },
    ]);

    const result = await applyCampaignCadenceChange("campaign-1", 8, true);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CAMPAIGN_UNAUTHORIZED");
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("applies cadence changes through the service RPC only when confirmed and authorized", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [rpcRow], error: null });
    createClient.mockResolvedValue(campaignLookupClient("org-1"));
    getCallerMemberships.mockResolvedValue([
      { user_id: "user-1", org_id: "org-1", role: "member" },
    ]);
    createAdminClient.mockReturnValue({ rpc });

    const result = await applyCampaignCadenceChange("campaign-1", 8, true);

    expect(result.ok).toBe(true);
    expect(createAdminClient).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("apply_campaign_cadence_reschedule", {
      p_campaign_id: "campaign-1",
      p_pace_seconds: 8,
      p_start_after_seconds: 300,
      p_operator_confirmed: true,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/campaigns/campaign-1");
    expect(revalidatePath).toHaveBeenCalledWith("/messages");
  });
});
