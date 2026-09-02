import { describe, expect, it, vi } from "vitest";

import { ESIGN_MERGE_FIELD_NAMES } from "@/lib/esign/contracts";

import type {
  ContractActionHandlers,
  LeadEsignPreflight,
  LoadLeadEsignPreflightAction,
  SendContractAction,
  SendContractInput,
} from "./esign-types";

const sendInput = {
  propertyId: "property-1",
  templateId: "template-local-1",
  sendIntentId: "intent-1",
  signers: [
    {
      role: "Seller",
      order: 0,
      name: "Seller Owner",
      emailAddress: "seller@example.com",
    },
  ],
  mergeValues: {
    seller_name: "Seller Owner",
    property_address: "123 Main St",
    offer_price: "$125,000",
    closing_date: "2026-09-30",
    earnest_money: "$1,000",
  },
} satisfies SendContractInput;

const preflight = {
  propertyId: "property-1",
  testMode: true,
  blockers: [],
  templates: [
    {
      id: "template-local-1",
      name: "Purchase agreement",
      documentType: "purchase_agreement",
      providerTemplateId: "provider-template-1",
      sellerRoleName: "Seller",
      signerRoles: [{ name: "Seller", order: 0 }],
      mergeFieldNames: ESIGN_MERGE_FIELD_NAMES,
    },
  ],
  sellerDefaults: {
    name: "Seller Owner",
    emailAddress: "seller@example.com",
  },
  mergeDefaults: sendInput.mergeValues,
} satisfies LeadEsignPreflight;

describe("lead eSign server-action contracts", () => {
  it("keeps preflight and send results inside the safe Result boundary", async () => {
    const load: LoadLeadEsignPreflightAction = vi
      .fn()
      .mockResolvedValue({ ok: true, data: preflight });
    const send: SendContractAction = vi.fn().mockResolvedValue({
      ok: true,
      data: { requestId: "request-local-1" },
    });

    await expect(load("property-1")).resolves.toEqual({
      ok: true,
      data: preflight,
    });
    await expect(send(sendInput)).resolves.toEqual({
      ok: true,
      data: { requestId: "request-local-1" },
    });
    expect(send).toHaveBeenCalledWith(sendInput);
    expect(Object.keys(sendInput.mergeValues).sort()).toEqual(
      [...ESIGN_MERGE_FIELD_NAMES].sort(),
    );
  });

  it("locks reminder, void, retry, and authorized-download input/result shapes", async () => {
    const actions: ContractActionHandlers = {
      viewAction: vi.fn().mockResolvedValue({ ok: true, data: { detailsUrl: "https://app.hellosign.com/home/manage?guid=request-1" } }),
      remindAction: vi.fn().mockResolvedValue({ ok: true, data: null }),
      voidAction: vi.fn().mockResolvedValue({ ok: true, data: null }),
      retryAction: vi.fn().mockResolvedValue({
        ok: true,
        data: { requestId: "request-retry-1" },
      }),
      fixSignerEmailAndResendAction: vi.fn().mockResolvedValue({
        ok: true,
        data: null,
      }),
      confirmNotSentAction: vi.fn().mockResolvedValue({
        ok: true,
        data: null,
      }),
      downloadAction: vi.fn().mockResolvedValue({
        ok: true,
        data: { url: "https://authorized.example/signed.pdf" },
      }),
    };

    await expect(
      actions.remindAction({
        requestId: "request-local-1",
        signerId: "signature-local-1",
      }),
    ).resolves.toEqual({ ok: true, data: null });
    await expect(
      actions.voidAction({ requestId: "request-local-1" }),
    ).resolves.toEqual({ ok: true, data: null });
    await expect(
      actions.retryAction({ requestId: "request-local-1" }),
    ).resolves.toEqual({
      ok: true,
      data: { requestId: "request-retry-1" },
    });
    await expect(
      actions.fixSignerEmailAndResendAction({
        requestId: "request-local-1",
        signerId: "signature-local-1",
        emailAddress: "fixed-seller@example.com",
      }),
    ).resolves.toEqual({ ok: true, data: null });
    await expect(
      actions.confirmNotSentAction({ requestId: "request-local-1" }),
    ).resolves.toEqual({ ok: true, data: null });
    await expect(
      actions.downloadAction({ fileId: "file-local-1" }),
    ).resolves.toEqual({
      ok: true,
      data: { url: "https://authorized.example/signed.pdf" },
    });
  });

  it("allows safe action failures without provider payloads crossing the boundary", async () => {
    const send: SendContractAction = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: "PROVIDER_ERROR",
        message: "Could not send the contract.",
      },
    });

    const result = await send(sendInput);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "PROVIDER_ERROR",
        message: "Could not send the contract.",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /api[_-]?key|provider[_-]?payload|seller@example\.com/i,
    );
  });
});
