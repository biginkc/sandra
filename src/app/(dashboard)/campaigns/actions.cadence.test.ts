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
      p_limit: 100,
      p_run_id: expect.any(String),
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
      p_limit: 100,
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
      p_limit: 100,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/campaigns/campaign-1");
    expect(revalidatePath).toHaveBeenCalledWith("/campaigns");
    expect(revalidatePath).toHaveBeenCalledWith("/messages");
  });

  it("loops resume batches until nothing remains and aggregates the window", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ affected_count: 500, first_scheduled_for: "2026-06-30T18:05:00.000Z", last_scheduled_for: "2026-06-30T18:38:16.000Z", remaining_count: 700 }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{ affected_count: 500, first_scheduled_for: "2026-06-30T18:38:20.000Z", last_scheduled_for: "2026-06-30T19:11:36.000Z", remaining_count: 200 }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{ affected_count: 200, first_scheduled_for: "2026-06-30T19:11:40.000Z", last_scheduled_for: "2026-06-30T19:24:56.000Z", remaining_count: 0 }],
        error: null,
      });
    const admin = adminCampaignClient({ rpc });
    createClient.mockResolvedValue(campaignLookupClient("org-1"));
    getCallerMemberships.mockResolvedValue([
      { user_id: "user-1", org_id: "org-1", role: "member" },
    ]);
    createAdminClient.mockReturnValue(admin.client);

    const result = await resumeCampaignSends("campaign-1", 4, true);

    expect(rpc).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      ok: true,
      data: {
        affectedCount: 1200,
        firstScheduledFor: "2026-06-30T18:05:00.000Z",
        lastScheduledFor: "2026-06-30T19:24:56.000Z",
        paceSeconds: 4,
        startAfterSeconds: 300,
      },
    });
  });

  it("reuses one run id across cadence batches", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ ...rpcRow, remaining_count: 1 }], error: null })
      .mockResolvedValueOnce({ data: [{ ...rpcRow, remaining_count: 0 }], error: null });
    const admin = adminCampaignClient({ rpc });
    createClient.mockResolvedValue(campaignLookupClient("org-1"));
    getCallerMemberships.mockResolvedValue([
      { user_id: "user-1", org_id: "org-1", role: "member" },
    ]);
    createAdminClient.mockReturnValue(admin.client);

    const result = await applyCampaignCadenceChange("campaign-1", 8, true);

    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1].p_run_id).toBe(rpc.mock.calls[1][1].p_run_id);
  });

  it("loops pause batches and reports the final counts", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ affected_count: 500, pending_count: 0, paused_count: 500, remaining_count: 100 }], error: null })
      .mockResolvedValueOnce({ data: [{ affected_count: 100, pending_count: 1, paused_count: 600, remaining_count: 0 }], error: null });
    createClient.mockResolvedValue(campaignLookupClient("org-1"));
    getCallerMemberships.mockResolvedValue([
      { user_id: "user-1", org_id: "org-1", role: "member" },
    ]);
    createAdminClient.mockReturnValue({ rpc });

    const result = await pauseCampaignSends("campaign-1", true);

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      ok: true,
      data: { affectedCount: 600, pendingCount: 1, pausedCount: 600 },
    });
  });

  it("reports a mid-loop failure with how many batches already landed", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ ...rpcRow, remaining_count: 10 }], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "canceling statement due to statement timeout" } });
    const admin = adminCampaignClient({ rpc });
    createClient.mockResolvedValue(campaignLookupClient("org-1"));
    getCallerMemberships.mockResolvedValue([
      { user_id: "user-1", org_id: "org-1", role: "member" },
    ]);
    createAdminClient.mockReturnValue(admin.client);

    const result = await resumeCampaignSends("campaign-1", 4, true);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CADENCE_CHANGE_FAILED");
      expect(result.error.message).toContain("1 batch already applied; retry to finish the rest");
    }
  });

  it("falls back to the single-shot RPC before the batching migration is applied", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function" } })
      .mockResolvedValueOnce({ data: [{ affected_count: 9, pending_count: 0, paused_count: 9 }], error: null });
    createClient.mockResolvedValue(campaignLookupClient("org-1"));
    getCallerMemberships.mockResolvedValue([
      { user_id: "user-1", org_id: "org-1", role: "member" },
    ]);
    createAdminClient.mockReturnValue({ rpc });

    const result = await pauseCampaignSends("campaign-1", true);

    expect(rpc).toHaveBeenNthCalledWith(2, "pause_campaign_queue", {
      p_campaign_id: "campaign-1",
      p_operator_confirmed: true,
    });
    expect(result).toEqual({
      ok: true,
      data: { affectedCount: 9, pendingCount: 0, pausedCount: 9 },
    });
  });

  it("stops after the max batch count instead of looping forever", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ ...rpcRow, remaining_count: 5 }], error: null });
    const admin = adminCampaignClient({ rpc });
    createClient.mockResolvedValue(campaignLookupClient("org-1"));
    getCallerMemberships.mockResolvedValue([
      { user_id: "user-1", org_id: "org-1", role: "member" },
    ]);
    createAdminClient.mockReturnValue(admin.client);

    const result = await resumeCampaignSends("campaign-1", 4, true);

    expect(result.ok).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(600);
  });
});
