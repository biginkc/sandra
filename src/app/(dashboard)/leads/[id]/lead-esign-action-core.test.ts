import { describe, expect, it, vi } from "vitest";

import {
  ESIGN_MERGE_FIELD_NAMES,
  type ProviderSignature,
  type TemplateOption,
} from "@/lib/esign/contracts";

import type { SendContractInput } from "./esign-types";
import {
  createLeadEsignActionCore,
  hashSendPayload,
  type EsignActionFiles,
  type EsignActionProvider,
  type EsignActionRepository,
  type EsignRequestRecord,
  type LeadEsignActionDependencies,
  type LeadSendContext,
} from "./lead-esign-action-core";

const NOW = new Date("2026-08-29T20:00:00.000Z");

const template: TemplateOption = {
  id: "template-local-1",
  name: "Purchase agreement",
  documentType: "purchase_agreement",
  providerTemplateId: "provider-template-1",
  sellerRoleName: "Seller",
  signerRoles: [
    { name: "Seller", order: 0 },
    { name: "Buyer", order: 1 },
  ],
  mergeFieldNames: ESIGN_MERGE_FIELD_NAMES,
};

const sendInput: SendContractInput = {
  propertyId: "property-1",
  templateId: template.id,
  sendIntentId: "11111111-1111-4111-8111-111111111111",
  signers: [
    {
      role: "Seller",
      order: 0,
      name: "Seller Owner",
      emailAddress: "seller@example.com",
    },
    {
      role: "Buyer",
      order: 1,
      name: "Buyer One",
      emailAddress: "buyer@example.com",
    },
  ],
  mergeValues: {
    seller_name: "Seller Owner",
    property_address: "123 Main St",
    offer_price: "$125,000",
    closing_date: "2026-09-30",
    earnest_money: "$1,000",
  },
};

const signatures: readonly ProviderSignature[] = sendInput.signers.map(
  (signer, index) => ({ ...signer, signatureId: `signature-${index + 1}` }),
);

function leadContext(
  overrides: Partial<LeadSendContext> = {},
): LeadSendContext {
  return {
    propertyId: "property-1",
    sellerName: "Seller Owner",
    sellerEmailAddress: "seller@example.com",
    propertyAddress: "123 Main St",
    connected: true,
    sendingEnabled: true,
    testMode: true,
    templates: [template],
    ...overrides,
  };
}

function request(
  overrides: Partial<EsignRequestRecord> = {},
): EsignRequestRecord {
  return {
    id: "request-1",
    orgId: "org-1",
    propertyId: "property-1",
    template,
    signers: sendInput.signers,
    mergeValues: sendInput.mergeValues,
    sendIntentId: sendInput.sendIntentId,
    payloadHash: hashSendPayload(sendInput),
    retryOfRequestId: null,
    status: "awaiting",
    deliveryState: "sending",
    providerRequestId: null,
    detailsUrl: null,
    voidRequestedAt: null,
    signedPdfFileId: null,
    ...overrides,
  };
}

function harness() {
  const repository = {
    loadLeadSendContext: vi.fn().mockResolvedValue(leadContext()),
    findRequestByIntent: vi.fn().mockResolvedValue(null),
    claimSend: vi.fn().mockImplementation(async (input) => ({
      outcome: "created",
      request: request({
        id: input.retryOfRequestId ? "request-retry-1" : "request-1",
        sendIntentId: input.sendIntentId,
        payloadHash: input.payloadHash,
        retryOfRequestId: input.retryOfRequestId,
        template: input.template,
        signers: input.signers,
        mergeValues: input.mergeValues,
      }),
    })),
    reconcileSent: vi.fn().mockResolvedValue(undefined),
    markSendOutcome: vi.fn().mockResolvedValue(undefined),
    findRequest: vi.fn().mockResolvedValue(null),
    claimReminder: vi.fn().mockResolvedValue({ outcome: "ineligible" }),
    markReminderSent: vi.fn().mockResolvedValue(undefined),
    claimVoid: vi.fn().mockResolvedValue({ outcome: "ineligible" }),
    markVoidRequested: vi.fn().mockResolvedValue(undefined),
    findSignedFile: vi.fn().mockResolvedValue(null),
  } as unknown as EsignActionRepository;
  const provider = {
    sendWithTemplate: vi.fn().mockResolvedValue({
      outcome: "sent",
      providerRequestId: "provider-request-1",
      detailsUrl:
        "https://app.hellosign.com/home/manage?guid=provider-request-1",
      signatures,
    }),
    remind: vi.fn().mockResolvedValue("sent"),
    cancel: vi.fn().mockResolvedValue("accepted"),
  } as unknown as EsignActionProvider;
  const files = {
    authorizeSignedFile: vi.fn().mockResolvedValue({
      url: "/api/leads/files/file-1?token=short-lived",
      expiresAt: new Date(NOW.getTime() + 60_000),
    }),
  } as unknown as EsignActionFiles;
  const dependencies: LeadEsignActionDependencies = {
    authenticate: vi
      .fn()
      .mockResolvedValue({ orgId: "org-1", userId: "user-1" }),
    repository,
    providerForOrg: vi.fn().mockResolvedValue(provider),
    files,
    now: () => NOW,
    newId: () => "22222222-2222-4222-8222-222222222222",
  };
  return {
    core: createLeadEsignActionCore(dependencies),
    dependencies,
    repository: repository as unknown as Record<
      keyof EsignActionRepository,
      ReturnType<typeof vi.fn>
    >,
    provider: provider as unknown as Record<
      keyof EsignActionProvider,
      ReturnType<typeof vi.fn>
    >,
    files: files as unknown as Record<
      keyof EsignActionFiles,
      ReturnType<typeof vi.fn>
    >,
  };
}

describe("lead eSign action orchestration", () => {
  it("returns live preflight blockers and safe seller defaults", async () => {
    const h = harness();
    h.repository.loadLeadSendContext.mockResolvedValue(
      leadContext({
        connected: false,
        sendingEnabled: false,
        sellerEmailAddress: null,
        templates: [],
      }),
    );

    const result = await h.core.preflight("property-1");

    expect(result).toMatchObject({
      ok: true,
      data: {
        testMode: true,
        blockers: [
          "provider_disconnected",
          "sending_disabled",
          "no_templates",
          "owner_email_missing",
        ],
        sellerDefaults: { name: "Seller Owner", emailAddress: "" },
      },
    });
  });

  it.each([
    ["disconnect", { connected: false }, "PROVIDER_DISCONNECTED"],
    ["toggle", { sendingEnabled: false }, "SENDING_DISABLED"],
    ["template deletion", { templates: [] }, "NO_TEMPLATES"],
    [
      "owner email removal",
      { sellerEmailAddress: null },
      "OWNER_EMAIL_MISSING",
    ],
  ] as const)(
    "blocks a TOCTOU %s change before claiming or dispatching",
    async (_name, change, code) => {
      const h = harness();
      h.repository.loadLeadSendContext.mockResolvedValue(leadContext(change));

      const result = await h.core.send(sendInput);

      expect(result).toMatchObject({ ok: false, error: { code } });
      expect(h.repository.claimSend).not.toHaveBeenCalled();
      expect(h.provider.sendWithTemplate).not.toHaveBeenCalled();
    },
  );

  it("honors the atomic claim's final blocker recheck", async () => {
    const h = harness();
    h.repository.claimSend.mockResolvedValue({
      outcome: "blocked",
      blocker: "sending_disabled",
    });

    const result = await h.core.send(sendInput);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "SENDING_DISABLED" },
    });
    expect(h.provider.sendWithTemplate).not.toHaveBeenCalled();
  });

  it("rejects a cross-org or mismatched send claim before provider dispatch", async () => {
    const h = harness();
    h.repository.claimSend.mockResolvedValue({
      outcome: "created",
      request: request({ orgId: "org-other", payloadHash: "a".repeat(64) }),
    });

    const result = await h.core.send(sendInput);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "REQUEST_CLAIM_MISMATCH" },
    });
    expect(h.provider.sendWithTemplate).not.toHaveBeenCalled();
  });

  it("rejects stale role case/order and incomplete five-field snapshots", async () => {
    const h = harness();
    const staleRole = await h.core.send({
      ...sendInput,
      signers: [
        { ...sendInput.signers[0], role: "seller" },
        sendInput.signers[1],
      ],
    });
    const blankField = await h.core.send({
      ...sendInput,
      sendIntentId: "33333333-3333-4333-8333-333333333333",
      mergeValues: { ...sendInput.mergeValues, closing_date: " " },
    });

    expect(staleRole).toMatchObject({
      ok: false,
      error: { code: "INVALID_SEND_INPUT" },
    });
    expect(blankField).toMatchObject({
      ok: false,
      error: { code: "INVALID_SEND_INPUT" },
    });
    expect(h.repository.claimSend).not.toHaveBeenCalled();
  });

  it("rejects unknown runtime keys before they enter the immutable snapshot", async () => {
    const h = harness();
    const extraMerge = await h.core.send({
      ...sendInput,
      mergeValues: {
        ...sendInput.mergeValues,
        private_provider_payload: "do not persist",
      },
    } as SendContractInput);
    const extraSigner = await h.core.send({
      ...sendInput,
      signers: [
        { ...sendInput.signers[0], provider_id: "private-provider-id" },
        sendInput.signers[1],
      ],
    } as SendContractInput);

    expect(extraMerge).toMatchObject({
      ok: false,
      error: { code: "INVALID_SEND_INPUT" },
    });
    expect(extraSigner).toMatchObject({
      ok: false,
      error: { code: "INVALID_SEND_INPUT" },
    });
    expect(JSON.stringify([extraMerge, extraSigner])).not.toMatch(
      /do not persist|private-provider-id/,
    );
    expect(h.repository.claimSend).not.toHaveBeenCalled();
  });

  it("returns an existing request for the same intent/hash without redispatch", async () => {
    const h = harness();
    h.repository.findRequestByIntent.mockResolvedValue(
      request({
        deliveryState: "sent",
        providerRequestId: "provider-request-1",
      }),
    );

    await expect(h.core.send(sendInput)).resolves.toEqual({
      ok: true,
      data: { requestId: "request-1" },
    });
    expect(h.repository.loadLeadSendContext).not.toHaveBeenCalled();
    expect(h.provider.sendWithTemplate).not.toHaveBeenCalled();
  });

  it("rejects the same intent with a different payload hash", async () => {
    const h = harness();
    h.repository.findRequestByIntent.mockResolvedValue(request());

    const result = await h.core.send({
      ...sendInput,
      mergeValues: { ...sendInput.mergeValues, offer_price: "$130,000" },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "SEND_INTENT_CONFLICT" },
    });
    expect(h.provider.sendWithTemplate).not.toHaveBeenCalled();
  });

  it.each(["ambiguous", "throw"] as const)(
    "marks %s dispatches send_unknown and never leaks or blindly resends",
    async (mode) => {
      const h = harness();
      if (mode === "throw") {
        h.provider.sendWithTemplate.mockRejectedValue(
          new Error("429 seller-private@example.com provider body"),
        );
      } else {
        h.provider.sendWithTemplate.mockResolvedValue({ outcome: "ambiguous" });
      }

      const first = await h.core.send(sendInput);
      h.repository.findRequestByIntent.mockResolvedValue(
        request({ deliveryState: "send_unknown" }),
      );
      const duplicate = await h.core.send(sendInput);

      expect(first).toMatchObject({
        ok: false,
        error: { code: "SEND_UNKNOWN" },
      });
      expect(JSON.stringify(first)).not.toMatch(
        /seller-private|provider body|429/,
      );
      expect(h.repository.markSendOutcome).toHaveBeenCalledWith({
        orgId: "org-1",
        requestId: "request-1",
        deliveryState: "send_unknown",
        safeErrorMessage: null,
      });
      expect(duplicate).toEqual({ ok: true, data: { requestId: "request-1" } });
      expect(h.provider.sendWithTemplate).toHaveBeenCalledTimes(1);
    },
  );

  it("records a definitive provider failure as failed history", async () => {
    const h = harness();
    h.provider.sendWithTemplate.mockResolvedValue({
      outcome: "definitive_failure",
    });

    const result = await h.core.send(sendInput);

    expect(result).toMatchObject({ ok: false, error: { code: "SEND_FAILED" } });
    expect(h.repository.markSendOutcome).toHaveBeenCalledWith({
      orgId: "org-1",
      requestId: "request-1",
      deliveryState: "failed",
      safeErrorMessage: "Dropbox Sign rejected the contract send.",
    });
  });

  it("treats invalid post-send identifiers as send_unknown", async () => {
    const h = harness();
    h.provider.sendWithTemplate.mockResolvedValue({
      outcome: "sent",
      providerRequestId: "provider-request-1",
      detailsUrl: "https://sign.hellosign.com/sign/private",
      signatures,
    });

    const result = await h.core.send(sendInput);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "SEND_UNKNOWN" },
    });
    expect(h.repository.reconcileSent).not.toHaveBeenCalled();
    expect(h.repository.markSendOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryState: "send_unknown" }),
    );
  });

  it("retries only failed requests and creates a new linked intent", async () => {
    const h = harness();
    h.repository.findRequest.mockResolvedValue(
      request({ deliveryState: "failed", status: "error" }),
    );

    const result = await h.core.retry({ requestId: "request-1" });

    expect(result).toEqual({
      ok: true,
      data: { requestId: "request-retry-1" },
    });
    expect(h.repository.claimSend).toHaveBeenCalledWith(
      expect.objectContaining({
        sendIntentId: "22222222-2222-4222-8222-222222222222",
        retryOfRequestId: "request-1",
      }),
    );
  });

  it("rejects retry for a nonfailed or cross-org request", async () => {
    const h = harness();
    h.repository.findRequest
      .mockResolvedValueOnce(request({ deliveryState: "sent" }))
      .mockResolvedValueOnce(null);

    expect(await h.core.retry({ requestId: "request-1" })).toMatchObject({
      ok: false,
      error: { code: "RETRY_INELIGIBLE" },
    });
    expect(
      await h.core.retry({ requestId: "request-other-org" }),
    ).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(h.repository.findRequest).toHaveBeenLastCalledWith({
      orgId: "org-1",
      requestId: "request-other-org",
    });
    expect(h.provider.sendWithTemplate).not.toHaveBeenCalled();
  });

  it("enforces signer eligibility and the one-hour reminder cooldown", async () => {
    const h = harness();
    h.repository.claimReminder
      .mockResolvedValueOnce({ outcome: "cooldown" })
      .mockResolvedValueOnce({
        outcome: "eligible",
        candidate: {
          request: request({
            deliveryState: "sent",
            providerRequestId: "provider-request-1",
          }),
          signer: {
            id: "signature-1",
            name: "Seller Owner",
            emailAddress: "seller@example.com",
            status: "awaiting",
            lastRemindedAt: null,
          },
        },
      });

    const cooldown = await h.core.remind({
      requestId: "request-1",
      signerId: "signature-1",
    });
    const sent = await h.core.remind({
      requestId: "request-1",
      signerId: "signature-1",
    });

    expect(cooldown).toMatchObject({
      ok: false,
      error: { code: "REMINDER_COOLDOWN" },
    });
    expect(sent).toEqual({ ok: true, data: null });
    expect(h.repository.claimReminder).toHaveBeenCalledWith(
      expect.objectContaining({ cooldownMs: 3_600_000 }),
    );
    expect(h.repository.markReminderSent).toHaveBeenCalledWith(
      expect.objectContaining({ remindedAt: NOW }),
    );
  });

  it("independently rejects a stale eligible reminder claim inside one hour", async () => {
    const h = harness();
    h.repository.claimReminder.mockResolvedValue({
      outcome: "eligible",
      candidate: {
        request: request({
          deliveryState: "sent",
          providerRequestId: "provider-request-1",
        }),
        signer: {
          id: "signature-1",
          name: "Seller Owner",
          emailAddress: "seller@example.com",
          status: "awaiting",
          lastRemindedAt: new Date(NOW.getTime() - 59 * 60_000).toISOString(),
        },
      },
    });

    expect(
      await h.core.remind({
        requestId: "request-1",
        signerId: "signature-1",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "REMINDER_INELIGIBLE" },
    });
    expect(h.provider.remind).not.toHaveBeenCalled();
  });

  it("rejects a cross-org reminder candidate or mismatched signer claim", async () => {
    const h = harness();
    h.repository.claimReminder.mockResolvedValue({
      outcome: "eligible",
      candidate: {
        request: request({
          orgId: "org-other",
          deliveryState: "sent",
          providerRequestId: "provider-request-private",
        }),
        signer: {
          id: "signature-other",
          name: "Private Seller",
          emailAddress: "private@example.com",
          status: "awaiting",
          lastRemindedAt: null,
        },
      },
    });

    const result = await h.core.remind({
      requestId: "request-1",
      signerId: "signature-1",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "REMINDER_INELIGIBLE" },
    });
    expect(JSON.stringify(result)).not.toMatch(/private|example\.com/);
    expect(h.provider.remind).not.toHaveBeenCalled();
  });

  it("a successful cancel marks only void_requested and never marks voided", async () => {
    const h = harness();
    const awaiting = request({
      deliveryState: "sent",
      providerRequestId: "provider-request-1",
    });
    h.repository.claimVoid.mockResolvedValue({
      outcome: "eligible",
      request: awaiting,
    });

    const result = await h.core.void({ requestId: "request-1" });

    expect(result).toEqual({ ok: true, data: null });
    expect(h.repository.markVoidRequested).toHaveBeenCalledWith({
      orgId: "org-1",
      requestId: "request-1",
      requestedAt: NOW,
    });
    expect(awaiting.status).toBe("awaiting");
    expect(awaiting.voidRequestedAt).toBeNull();
  });

  it("rejects an already void-pending request without another provider call", async () => {
    const h = harness();
    h.repository.claimVoid.mockResolvedValue({
      outcome: "eligible",
      request: request({
        deliveryState: "sent",
        providerRequestId: "provider-request-1",
        voidRequestedAt: NOW.toISOString(),
      }),
    });

    expect(await h.core.void({ requestId: "request-1" })).toMatchObject({
      ok: false,
      error: { code: "VOID_INELIGIBLE" },
    });
    expect(h.provider.cancel).not.toHaveBeenCalled();
  });

  it("authorizes manager details only for the caller's org and manager URL", async () => {
    const h = harness();
    h.repository.findRequest.mockResolvedValue(
      request({
        detailsUrl:
          "https://app.hellosign.com/home/manage?guid=provider-request-1",
      }),
    );

    expect(await h.core.view({ requestId: "request-1" })).toEqual({
      ok: true,
      data: {
        detailsUrl:
          "https://app.hellosign.com/home/manage?guid=provider-request-1",
      },
    });
    expect(h.repository.findRequest).toHaveBeenCalledWith({
      orgId: "org-1",
      requestId: "request-1",
    });
  });

  it("keeps Signed independent from PDF readiness", async () => {
    const h = harness();
    h.repository.findSignedFile.mockResolvedValue(null);

    const result = await h.core.download({ fileId: "file-missing" });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "FILE_NOT_FOUND" },
    });
    expect(h.files.authorizeSignedFile).not.toHaveBeenCalled();
  });

  it("returns only a short-lived authorized Sandra download URL", async () => {
    const h = harness();
    h.repository.findSignedFile.mockResolvedValue({
      id: "file-1",
      requestId: "request-1",
    });
    h.repository.findRequest.mockResolvedValue(
      request({
        status: "signed",
        deliveryState: "sent",
        signedPdfFileId: "file-1",
      }),
    );

    expect(await h.core.download({ fileId: "file-1" })).toEqual({
      ok: true,
      data: { url: "/api/leads/files/file-1?token=short-lived" },
    });

    h.files.authorizeSignedFile.mockResolvedValue({
      url: "https://public-storage.example/signed.pdf",
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    expect(await h.core.download({ fileId: "file-1" })).toMatchObject({
      ok: false,
      error: { code: "FILE_AUTHORIZATION_FAILED" },
    });
  });
});
