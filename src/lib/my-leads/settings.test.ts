import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, rpc } = vi.hoisted(() => ({
  createClient: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

import {
  setAcquisitionDesignation,
  setAcquisitionSettings,
} from "./settings";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const ACTOR_ID = "00000000-0000-4000-8000-000000000002";
const MEMBER_ID = "00000000-0000-4000-8000-000000000003";

beforeEach(() => {
  vi.clearAllMocks();
  createClient.mockResolvedValue({ rpc });
});

describe("My Leads settings RPC wrappers", () => {
  it("sends designation CAS data and preserves a successful result", async () => {
    rpc.mockResolvedValue({
      data: {
        ok: true,
        duplicate: false,
        orgId: ORG_ID,
        userId: MEMBER_ID,
        acquisitionsEnabled: true,
      },
      error: null,
    });

    await expect(
      setAcquisitionDesignation({
        orgId: ORG_ID,
        userId: MEMBER_ID,
        enabled: true,
        expectedEnabled: false,
        idempotencyKey: "00000000-0000-4000-8000-000000000004",
      }),
    ).resolves.toEqual({
      ok: true,
      duplicate: false,
      orgId: ORG_ID,
      userId: MEMBER_ID,
      acquisitionsEnabled: true,
    });
    expect(rpc).toHaveBeenCalledWith("fn_set_acquisition_designation", {
      p_enabled: true,
      p_expected_enabled: false,
      p_idempotency_key: "00000000-0000-4000-8000-000000000004",
      p_org_id: ORG_ID,
      p_user_id: MEMBER_ID,
    });
  });

  it("sends settings revision CAS data and returns the new revision", async () => {
    rpc.mockResolvedValue({
      data: {
        ok: true,
        duplicate: false,
        orgId: ORG_ID,
        needsSequenceOwnerId: ACTOR_ID,
        myLeadsEnabled: false,
        settingsRevision: 1,
      },
      error: null,
    });

    await expect(
      setAcquisitionSettings({
        orgId: ORG_ID,
        needsSequenceOwnerId: ACTOR_ID,
        expectedSettingsRevision: 0,
        idempotencyKey: "00000000-0000-4000-8000-000000000005",
      }),
    ).resolves.toMatchObject({
      ok: true,
      settingsRevision: 1,
      myLeadsEnabled: false,
    });
    expect(rpc).toHaveBeenCalledWith("fn_set_acquisition_settings", {
      p_expected_settings_revision: 0,
      p_idempotency_key: "00000000-0000-4000-8000-000000000005",
      p_needs_sequence_owner_id: ACTOR_ID,
      p_org_id: ORG_ID,
    });
  });

  it.each([
    [{ code: "42501", message: "FORBIDDEN" }, "FORBIDDEN"],
    [{ code: "40001", message: "STALE_STATE" }, "STALE_STATE"],
    [{ code: "22023", message: "RECIPIENT_UNAVAILABLE" }, "RECIPIENT_UNAVAILABLE"],
    [{ code: "40001", message: "IDEMPOTENCY_CONFLICT" }, "IDEMPOTENCY_CONFLICT"],
  ])("maps database error %j to %s", async (error, code) => {
    rpc.mockResolvedValue({ data: null, error });

    await expect(
      setAcquisitionSettings({
        orgId: ORG_ID,
        needsSequenceOwnerId: ACTOR_ID,
        expectedSettingsRevision: 0,
        idempotencyKey: "00000000-0000-4000-8000-000000000006",
      }),
    ).resolves.toMatchObject({ ok: false, code });
  });

  it("rejects malformed success payloads instead of claiming settings changed", async () => {
    rpc.mockResolvedValue({ data: { ok: true }, error: null });

    await expect(
      setAcquisitionDesignation({
        orgId: ORG_ID,
        userId: MEMBER_ID,
        enabled: false,
        expectedEnabled: true,
        idempotencyKey: "00000000-0000-4000-8000-000000000007",
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
  });
});
