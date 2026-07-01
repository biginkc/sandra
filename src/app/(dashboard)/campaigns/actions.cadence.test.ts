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
  pauseCampaignSends,
  previewCampaignCadenceChange,
  resumeCampaignSends,
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

function adminCampaignClient(args: {
  jobs?: Array<{ id: string; input_params: Record<string, unknown> }>;
  rpc: ReturnType<typeof vi.fn>;
}) {
  const jobsUpdateIn = vi.fn().mockResolvedValue({ error: null });
  const jobsUpdateQuery = {
    eq: vi.fn(() => jobsUpdateQuery),
    contains: vi.fn(() => jobsUpdateQuery),
    in: jobsUpdateIn,
  };
  const jobsUpdate = vi.fn(() => jobsUpdateQuery);
  const activeJobsIn = vi
    .fn()
    .mockResolvedValue({ data: args.jobs ?? [], error: null });
  const jobsSelectQuery = {
    eq: vi.fn(() => jobsSelectQuery),
    contains: vi.fn(() => jobsSelectQuery),
    in: activeJobsIn,
  };
  const jobsSelect = vi.fn(() => jobsSelectQuery);

  const campaignUpdateMaybeSingle = vi
    .fn()
    .mockResolvedValue({ data: { id: "campaign-1" }, error: null });
  const campaignUpdateQuery = {
    eq: vi.fn(() => campaignUpdateQuery),
    select: vi.fn(() => ({ maybeSingle: campaignUpdateMaybeSingle })),
  };
  const campaignUpdate = vi.fn(() => campaignUpdateQuery);

  const from = vi.fn((table: string) => {
    if (table === "jobs") {
      return { select: jobsSelect, update: jobsUpdate };
    }
    if (table === "campaigns") {
      return { update: campaignUpdate };
    }
    throw new Error(`Unexpected table ${table}`);
  });

  const client = {
    from,
    rpc: args.rpc,
  };

  return {
    client,
    from,
    jobsSelect,
    jobsSelectQuery,
    jobsUpdate,
    jobsUpdateQuery,
    jobsUpdateIn,
    campaignUpdate,
    campaignUpdateQuery,
    campaignUpdateMaybeSingle,
    activeJobsIn,
  };
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
    const admin = adminCampaignClient({
      rpc,
      jobs: [
        {
          id: "job-1",
          input_params: {
            opts: { campaignId: "campaign-1", paceSeconds: 8 },
          },
        },
      ],
    });
    createClient.mockResolvedValue(campaignLookupClient("org-1"));
    getCallerMemberships.mockResolvedValue([
      { user_id: "user-1", org_id: "org-1", role: "member" },
    ]);
    createAdminClient.mockReturnValue(admin.client);

    const result = await applyCampaignCadenceChange("campaign-1", 8, true);

    expect(result.ok).toBe(true);
    expect(createAdminClient).toHaveBeenCalledTimes(1);
    expect(admin.activeJobsIn).toHaveBeenCalledWith("status", [
      "queued",
      "running",
      "finalizing",
    ]);
    expect(admin.jobsSelectQuery.eq).toHaveBeenCalledWith("org_id", "org-1");
    expect(admin.jobsSelectQuery.contains).toHaveBeenCalledWith("input_params", {
      opts: { campaignId: "campaign-1" },
    });
    expect(admin.jobsUpdate).toHaveBeenCalledWith({
      input_params: {
        opts: { campaignId: "campaign-1", paceSeconds: 8 },
      },
    });
    expect(admin.jobsUpdateQuery.eq).toHaveBeenCalledWith("id", "job-1");
    expect(admin.jobsUpdateQuery.eq).toHaveBeenCalledWith("org_id", "org-1");
    expect(admin.jobsUpdateQuery.contains).toHaveBeenCalledWith("input_params", {
      opts: { campaignId: "campaign-1" },
    });
    expect(admin.jobsUpdateIn).toHaveBeenCalledWith("status", [
      "queued",
      "running",
      "finalizing",
    ]);
    expect(rpc).toHaveBeenCalledWith("apply_campaign_cadence_reschedule", {
      p_campaign_id: "campaign-1",
      p_pace_seconds: 8,
      p_start_after_seconds: 300,
      p_operator_confirmed: true,
    });
    expect(admin.campaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ pace_seconds: 8 }),
    );
    expect(admin.campaignUpdateQuery.eq).toHaveBeenCalledWith("id", "campaign-1");
    expect(revalidatePath).toHaveBeenCalledWith("/campaigns/campaign-1");
    expect(revalidatePath).toHaveBeenCalledWith("/campaigns");
    expect(revalidatePath).toHaveBeenCalledWith("/messages");
  });

  it("persists cadence on the campaign row even when no queued messages are rescheduled", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          affected_count: "0",
          first_scheduled_for: null,
          last_scheduled_for: null,
        },
      ],
      error: null,
    });
    const admin = adminCampaignClient({ rpc, jobs: [] });
    createClient.mockResolvedValue(campaignLookupClient("org-1"));
    getCallerMemberships.mockResolvedValue([
      { user_id: "user-1", org_id: "org-1", role: "member" },
    ]);
    createAdminClient.mockReturnValue(admin.client);

    const result = await applyCampaignCadenceChange("campaign-1", 4, true);

    expect(result).toEqual({
      ok: true,
      data: {
        affectedCount: 0,
        firstScheduledFor: null,
        lastScheduledFor: null,
        paceSeconds: 4,
        startAfterSeconds: 300,
      },
    });
    expect(admin.campaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ pace_seconds: 4 }),
    );
    expect(admin.campaignUpdateQuery.eq).toHaveBeenCalledWith("org_id", "org-1");
    expect(revalidatePath).toHaveBeenCalledWith("/campaigns/campaign-1");
  });

  it("restores active job pace when the confirmed cadence RPC fails", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "reschedule failed" },
    });
    const admin = adminCampaignClient({
      rpc,
      jobs: [
        {
          id: "job-1",
          input_params: {
            opts: { campaignId: "campaign-1", paceSeconds: 8 },
          },
        },
      ],
    });
    createClient.mockResolvedValue(campaignLookupClient("org-1"));
    getCallerMemberships.mockResolvedValue([
      { user_id: "user-1", org_id: "org-1", role: "member" },
    ]);
    createAdminClient.mockReturnValue(admin.client);

    const result = await applyCampaignCadenceChange("campaign-1", 4, true);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CADENCE_CHANGE_FAILED");
    expect(admin.jobsUpdate).toHaveBeenNthCalledWith(1, {
      input_params: {
        opts: { campaignId: "campaign-1", paceSeconds: 4 },
      },
    });
    expect(admin.jobsUpdate).toHaveBeenNthCalledWith(2, {
      input_params: {
        opts: { campaignId: "campaign-1", paceSeconds: 8 },
      },
    });
    expect(admin.campaignUpdate).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("pauses campaign sends through the service RPC only when confirmed and authorized", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ affected_count: "9", pending_count: "2", paused_count: "9" }],
      error: null,
    });
    createClient.mockResolvedValue(campaignLookupClient("org-1"));
    getCallerMemberships.mockResolvedValue([
      { user_id: "user-1", org_id: "org-1", role: "member" },
    ]);
    createAdminClient.mockReturnValue({ rpc });

    const result = await pauseCampaignSends("campaign-1", true);

    expect(result).toEqual({
      ok: true,
      data: { affectedCount: 9, pendingCount: 2, pausedCount: 9 },
    });
    expect(rpc).toHaveBeenCalledWith("pause_campaign_queue", {
      p_campaign_id: "campaign-1",
      p_operator_confirmed: true,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/campaigns/campaign-1");
    expect(revalidatePath).toHaveBeenCalledWith("/campaigns");
    expect(revalidatePath).toHaveBeenCalledWith("/messages");
  });

  it("resumes paused campaign sends through the service RPC with cadence", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [rpcRow], error: null });
    const admin = adminCampaignClient({
      rpc,
      jobs: [
        {
          id: "job-1",
          input_params: {
            opts: { campaignId: "campaign-1", paceSeconds: 8 },
          },
        },
      ],
    });
    createClient.mockResolvedValue(campaignLookupClient("org-1"));
    getCallerMemberships.mockResolvedValue([
      { user_id: "user-1", org_id: "org-1", role: "member" },
    ]);
    createAdminClient.mockReturnValue(admin.client);

    const result = await resumeCampaignSends("campaign-1", 2, true);

    expect(result.ok).toBe(true);
    expect(admin.jobsUpdate).toHaveBeenCalledWith({
      input_params: {
        opts: { campaignId: "campaign-1", paceSeconds: 2 },
      },
    });
    expect(rpc).toHaveBeenCalledWith("resume_campaign_queue", {
      p_campaign_id: "campaign-1",
      p_pace_seconds: 2,
      p_start_after_seconds: 300,
      p_operator_confirmed: true,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/campaigns/campaign-1");
    expect(revalidatePath).toHaveBeenCalledWith("/campaigns");
    expect(revalidatePath).toHaveBeenCalledWith("/messages");
  });
});
