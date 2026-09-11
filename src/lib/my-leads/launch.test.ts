import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, rpc } = vi.hoisted(() => ({
  createClient: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

import {
  applyAcquisitionLaunch,
  previewAcquisitionLaunch,
  rollbackAcquisitionLaunch,
} from "./launch";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const MEMBER_ID = "00000000-0000-4000-8000-000000000002";
const COHORT_ID = "00000000-0000-4000-8000-000000000003";
const EPISODE_ID = "00000000-0000-4000-8000-000000000004";
const PROPERTY_ID = "00000000-0000-4000-8000-000000000005";
const REQUEST_ID = "00000000-0000-4000-8000-000000000006";

const preview = {
  ok: true,
  cohortId: COHORT_ID,
  orgId: ORG_ID,
  memberId: MEMBER_ID,
  settingsRevision: 4,
  previewCutoffAt: "2026-09-12T14:00:00.000Z",
  previewCount: 1,
  fingerprint: "sha256-fingerprint",
  rows: [
    {
      property_id: PROPERTY_ID,
      expected_episode_id: EPISODE_ID,
      expected_assigned_user_id: MEMBER_ID,
      expected_assigned_at: "2026-09-01T14:00:00.000Z",
      expected_episode_initialized_at: "2026-09-01T14:00:00.000Z",
      expected_member_revision: 2,
      expected_shared_status: "new_lead",
      expected_queue_version: 0,
      expected_queue_stage: null,
      expected_is_dnc_locked: false,
      expected_deleted_at: null,
      expected_settings_revision: 4,
    },
  ],
  excluded: {
    assignedTotal: 2,
    closedOrDead: 0,
    dnc: 0,
    offerDeclined: 0,
    alreadyArchived: 1,
    missingEpisode: 0,
  },
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  createClient.mockResolvedValue({ rpc });
});

describe("My Leads launch RPC wrappers", () => {
  it("requests an exact read-only preview and parses its rows", async () => {
    rpc.mockResolvedValue({ data: preview, error: null });

    await expect(
      previewAcquisitionLaunch({ orgId: ORG_ID, memberId: MEMBER_ID }),
    ).resolves.toEqual(preview);
    expect(rpc).toHaveBeenCalledWith("fn_preview_acquisition_launch", {
      p_org_id: ORG_ID,
      p_member_id: MEMBER_ID,
    });
  });

  it("accepts a legacy preview row with no prior assignment episode", async () => {
    rpc.mockResolvedValue({
      data: {
        ...preview,
        rows: [{
          ...preview.rows[0],
          expected_episode_id: null,
          expected_episode_initialized_at: null,
        }],
      },
      error: null,
    });

    await expect(
      previewAcquisitionLaunch({ orgId: ORG_ID, memberId: MEMBER_ID }),
    ).resolves.toMatchObject({
      ok: true,
      rows: [{ expected_episode_id: null, expected_episode_initialized_at: null }],
    });
  });

  it("binds apply to cohort, fingerprint, settings CAS and idempotency", async () => {
    rpc.mockResolvedValue({
      data: {
        ok: true,
        duplicate: false,
        cohortId: COHORT_ID,
        memberId: MEMBER_ID,
        count: 1,
        fingerprint: "sha256-fingerprint",
        settingsRevision: 5,
      },
      error: null,
    });

    await expect(
      applyAcquisitionLaunch({
        orgId: ORG_ID,
        memberId: MEMBER_ID,
        cohortId: COHORT_ID,
        previewFingerprint: "sha256-fingerprint",
        expectedSettingsRevision: 4,
        idempotencyKey: REQUEST_ID,
      }),
    ).resolves.toMatchObject({ ok: true, duplicate: false, count: 1 });
    expect(rpc).toHaveBeenCalledWith("fn_apply_acquisition_launch", {
      p_org_id: ORG_ID,
      p_member_id: MEMBER_ID,
      p_cohort_id: COHORT_ID,
      p_preview_fingerprint: "sha256-fingerprint",
      p_expected_settings_revision: 4,
      p_idempotency_key: REQUEST_ID,
    });
  });

  it("sends rollback as an owner command with a distinct idempotency key", async () => {
    rpc.mockResolvedValue({
      data: { ok: true, duplicate: true, cohortId: COHORT_ID, count: 1 },
      error: null,
    });

    await expect(
      rollbackAcquisitionLaunch({
        orgId: ORG_ID,
        cohortId: COHORT_ID,
        idempotencyKey: REQUEST_ID,
      }),
    ).resolves.toEqual({ ok: true, duplicate: true, cohortId: COHORT_ID, count: 1 });
    expect(rpc).toHaveBeenCalledWith("fn_rollback_acquisition_launch", {
      p_org_id: ORG_ID,
      p_cohort_id: COHORT_ID,
      p_idempotency_key: REQUEST_ID,
    });
  });

  it.each([
    ["LAUNCH_INVALIDATED", "LAUNCH_INVALIDATED"],
    ["ROLLBACK_BLOCKED", "ROLLBACK_BLOCKED"],
    ["LAUNCH_ALREADY_APPLIED", "LAUNCH_ALREADY_APPLIED"],
    ["40001", "STALE_STATE"],
  ])("maps %s without claiming mutation success", async (message, code) => {
    rpc.mockResolvedValue({ data: null, error: { code: message, message } });
    await expect(
      applyAcquisitionLaunch({
        orgId: ORG_ID,
        memberId: MEMBER_ID,
        cohortId: COHORT_ID,
        previewFingerprint: "sha256-fingerprint",
        expectedSettingsRevision: 4,
        idempotencyKey: REQUEST_ID,
      }),
    ).resolves.toMatchObject({ ok: false, code });
  });

  it("rejects malformed successful results and previews", async () => {
    rpc.mockResolvedValue({ data: { ok: true }, error: null });
    await expect(
      applyAcquisitionLaunch({
        orgId: ORG_ID,
        memberId: MEMBER_ID,
        cohortId: COHORT_ID,
        previewFingerprint: "sha256-fingerprint",
        expectedSettingsRevision: 4,
        idempotencyKey: REQUEST_ID,
      }),
    ).resolves.toMatchObject({ ok: false, code: "INVALID_INPUT" });
    await expect(
      previewAcquisitionLaunch({ orgId: ORG_ID, memberId: MEMBER_ID }),
    ).resolves.toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });
});
