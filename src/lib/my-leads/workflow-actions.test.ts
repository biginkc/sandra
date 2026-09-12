import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, rpc } = vi.hoisted(() => ({
  createClient: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

import {
  archiveAcquisitionContract,
  declineAcquisitionOffer,
  handoffAcquisitionLead,
  logAcquisitionOffer,
  readyAcquisitionOffer,
  recordAcquisitionContract,
} from "./workflow-actions";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const PROPERTY_ID = "00000000-0000-4000-8000-000000000002";
const EPISODE_ID = "00000000-0000-4000-8000-000000000003";
const OFFER_ID = "00000000-0000-4000-8000-000000000004";
const ACTOR_ID = "00000000-0000-4000-8000-000000000005";
const REQUEST_ID = "00000000-0000-4000-8000-000000000006";

const envelope = {
  orgId: ORG_ID,
  propertyId: PROPERTY_ID,
  expectedEpisodeId: EPISODE_ID,
  expectedQueueVersion: 2,
  expectedSharedStatus: "contacted",
  idempotencyKey: REQUEST_ID,
};

const success = {
  ok: true,
  duplicate: false,
  propertyId: PROPERTY_ID,
  queueVersion: 3,
  stage: "needs_offer",
  archived: false,
  assignmentEpisodeId: EPISODE_ID,
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  createClient.mockResolvedValue({ rpc });
  rpc.mockResolvedValue({ data: success, error: null });
});

describe("My Leads workflow RPC wrappers", () => {
  it("sends readiness as one JSON envelope with motivation and status CAS", async () => {
    await expect(
      readyAcquisitionOffer({
        ...envelope,
        motivationResponse: { kind: "specified", text: "Moving soon" },
        temperature: "warm",
      }),
    ).resolves.toEqual(success);
    expect(rpc).toHaveBeenCalledWith("fn_ready_acquisition_offer", {
      p_input: {
        ...envelope,
        motivationResponse: { kind: "specified", text: "Moving soon" },
        temperature: "warm",
      },
    });
  });

  it("maps offer and lifecycle form field names to their command RPCs", async () => {
    await logAcquisitionOffer({
      ...envelope,
      amountCents: 125000,
      method: "dropbox_sign",
      sentAt: "2026-09-11T14:00:00.000Z",
      followUpAt: "2026-09-12T14:00:00.000Z",
      motivationResponse: { kind: "no_motivation", text: null },
      temperature: null,
    });
    expect(rpc).toHaveBeenLastCalledWith("fn_log_acquisition_offer", {
      p_input: expect.objectContaining({ method: "dropbox_sign", amountCents: 125000 }),
    });

    await recordAcquisitionContract({
      ...envelope,
      expectedQueueVersion: 3,
      expectedSharedStatus: "offer_sent",
      signedAt: "2026-09-13T14:00:00.000Z",
      offerId: OFFER_ID,
    });
    expect(rpc).toHaveBeenLastCalledWith("fn_record_acquisition_contract", {
      p_input: expect.objectContaining({ offerId: OFFER_ID }),
    });

    await declineAcquisitionOffer({
      ...envelope,
      expectedQueueVersion: 3,
      expectedSharedStatus: "offer_sent",
      pendingOfferId: OFFER_ID,
      occurredAt: "2026-09-13T15:00:00.000Z",
    });
    expect(rpc).toHaveBeenLastCalledWith("fn_decline_acquisition_offer", {
      p_input: expect.objectContaining({ pendingOfferId: OFFER_ID }),
    });

    await handoffAcquisitionLead({
      ...envelope,
      recipientUserId: ACTOR_ID,
      reason: "needs_nurture",
    });
    expect(rpc).toHaveBeenLastCalledWith("fn_handoff_acquisition_lead", {
      p_input: expect.objectContaining({ recipientUserId: ACTOR_ID }),
    });

    await archiveAcquisitionContract({
      ...envelope,
      expectedQueueVersion: 4,
      expectedSharedStatus: "under_contract",
    });
    expect(rpc).toHaveBeenLastCalledWith("fn_archive_acquisition_contract", {
      p_input: expect.objectContaining({ expectedSharedStatus: "under_contract" }),
    });
  });

  it("returns a replayed result and preserves duplicate state", async () => {
    rpc.mockResolvedValue({ data: { ...success, duplicate: true }, error: null });
    await expect(
      readyAcquisitionOffer({
        ...envelope,
        motivationResponse: { kind: "no_motivation", text: null },
        temperature: null,
      }),
    ).resolves.toMatchObject({ ok: true, duplicate: true });
  });

  it.each([
    ["DNC_LOCKED", "DNC_LOCKED"],
    ["PENDING_OFFER_EXISTS", "PENDING_OFFER_EXISTS"],
    ["40001", "STALE_STATE"],
    ["23505", "IDEMPOTENCY_CONFLICT"],
  ])("maps database error %s to %s", async (message, code) => {
    rpc.mockResolvedValue({ data: null, error: { code: message, message } });
    await expect(
      archiveAcquisitionContract({ ...envelope }),
    ).resolves.toMatchObject({ ok: false, code });
  });

  it("rejects malformed successful results", async () => {
    rpc.mockResolvedValue({ data: { ok: true, duplicate: false }, error: null });
    await expect(archiveAcquisitionContract(envelope)).resolves.toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
  });
});
