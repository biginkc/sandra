import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ESIGN_MERGE_FIELD_NAMES,
  type ProviderSignature,
  type TemplateOption,
} from "@/lib/esign/contracts";

import type { SendContractInput } from "./esign-types";
import {
  ESIGN_PROVIDER_TIMEOUT_MS,
  createLeadEsignActionCore,
  hashSendPayload,
  type EsignActionFiles,
  type EsignActionProvider,
  type EsignActionRepository,
  type EsignRequestRecord,
  type LeadEsignActionDependencies,
  type LeadSendContext,
} from "./lead-esign-action-core";

const reportMocks = vi.hoisted(() => ({ reportError: vi.fn() }));

vi.mock("@/lib/errors/report", () => ({
  reportError: reportMocks.reportError,
}));

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
    hasHomeownerContact: true,
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
    testMode: true,
    providerRequestId: null,
    detailsUrl: null,
    errorMessage: null,
    voidRequestedAt: null,
    signedPdfFileId: null,
    ...overrides,
  };
}

function harness() {
  const repository = {
    loadLeadSendContext: vi.fn().mockResolvedValue(leadContext()),
    findRequestByIntent: vi.fn().mockResolvedValue(null),
    isDialogEmailAuthorityReady: vi.fn().mockResolvedValue(true),
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
    findProviderLookupReference: vi.fn().mockResolvedValue({
      localRequestId: "known-local-request",
      providerRequestId: "known-provider-request",
    }),
    resolveSendUnknownNotSent: vi.fn().mockResolvedValue("updated"),
    claimEmailBounceUpdate: vi.fn().mockResolvedValue({
      outcome: "ineligible",
    }),
    finalizeEmailBounceUpdate: vi.fn().mockResolvedValue("applied"),
    releaseEmailBounceUpdate: vi.fn().mockResolvedValue("released"),
    findRequest: vi.fn().mockResolvedValue(null),
    claimReminder: vi.fn().mockResolvedValue({ outcome: "ineligible" }),
    finalizeReminder: vi.fn().mockResolvedValue("applied"),
    releaseReminder: vi.fn().mockResolvedValue("released"),
    claimVoid: vi.fn().mockResolvedValue({ outcome: "ineligible" }),
    finalizeVoid: vi.fn().mockResolvedValue("applied"),
    releaseVoid: vi.fn().mockResolvedValue("released"),
    findSignedFile: vi.fn().mockResolvedValue(null),
    reserveLiveSend: vi.fn().mockResolvedValue("reserved"),
  } as unknown as EsignActionRepository;
  const provider = {
    sendWithTemplate: vi.fn().mockResolvedValue({
      outcome: "sent",
      providerRequestId: "provider-request-1",
      detailsUrl:
        "https://app.hellosign.com/home/manage?guid=provider-request-1",
      signatures,
    }),
    remind: vi.fn().mockResolvedValue("accepted"),
    cancel: vi.fn().mockResolvedValue("accepted"),
    updateSignerEmail: vi.fn().mockResolvedValue({
      outcome: "accepted",
      signature: {
        signatureId: "signature-updated",
        role: "Seller",
        order: 0,
        name: "Seller Owner",
        emailAddress: "seller-fixed@example.com",
      },
    }),
    findSignatureRequestIdsByLocalRequestId: vi.fn()
      .mockResolvedValueOnce({
        complete: true,
        providerRequestIds: ["known-provider-request"],
      })
      .mockResolvedValueOnce({ complete: true, providerRequestIds: [] }),
    getRemainingSignatureRequests: vi.fn().mockResolvedValue(39),
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
      .mockResolvedValue({ orgId: "org-1", userId: "user-1", role: "owner" }),
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
  beforeEach(() => {
    reportMocks.reportError.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("maps a stale database signer-authority rejection to signer guidance", async () => {
    const h = harness();
    h.repository.claimSend.mockResolvedValue({ outcome: "invalid_send_input" });

    const result = await h.core.send(sendInput);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_SEND_INPUT",
        message:
          "The signer details changed. Review each signer and try again.",
      },
    });
    expect(h.provider.sendWithTemplate).not.toHaveBeenCalled();
  });

  it("uses the validated dialog seller email when the stored email is blank", async () => {
    const h = harness();
    h.repository.loadLeadSendContext.mockResolvedValue(
      leadContext({ sellerEmailAddress: null }),
    );

    const result = await h.core.send(sendInput);

    expect(result).toEqual({ ok: true, data: { requestId: "request-1" } });
    expect(h.repository.claimSend).toHaveBeenCalledWith(
      expect.objectContaining({ signers: sendInput.signers }),
    );
    expect(h.provider.sendWithTemplate).toHaveBeenCalledTimes(1);
  });

  it("reserves a live send only after Dropbox quota is above the fail-closed threshold", async () => {
    const h = harness();
    h.repository.loadLeadSendContext.mockResolvedValue(
      leadContext({
        testMode: false,
        liveSendLimit: {
          monthlyLimit: 40,
          usedThisMonth: 12,
          remainingThisMonth: 28,
        },
      }),
    );
    h.repository.claimSend.mockResolvedValue({
      outcome: "created",
      request: request({ testMode: false }),
    });

    const result = await h.core.send(sendInput);

    expect(result).toEqual({ ok: true, data: { requestId: "request-1" } });
    expect(h.provider.getRemainingSignatureRequests).toHaveBeenCalledTimes(1);
    expect(h.repository.reserveLiveSend).toHaveBeenCalledWith({
      orgId: "org-1",
      requestId: "request-1",
      providerRemaining: 39,
    });
    expect(h.provider.sendWithTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ testMode: false }),
    );
  });

  it("blocks live send dispatch when Dropbox remaining quota is at the fail-closed threshold", async () => {
    const h = harness();
    h.repository.loadLeadSendContext.mockResolvedValue(
      leadContext({ testMode: false }),
    );
    h.repository.claimSend.mockResolvedValue({
      outcome: "created",
      request: request({ testMode: false }),
    });
    h.provider.getRemainingSignatureRequests.mockResolvedValue(10);

    const result = await h.core.send(sendInput);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "LIVE_QUOTA_BLOCKED" },
    });
    expect(h.repository.markSendOutcome).toHaveBeenCalledWith({
      orgId: "org-1",
      requestId: "request-1",
      deliveryState: "failed",
      safeErrorMessage: "PROVIDER_QUOTA_TOO_LOW",
    });
    expect(h.repository.reserveLiveSend).not.toHaveBeenCalled();
    expect(h.provider.sendWithTemplate).not.toHaveBeenCalled();
  });

  it("allows live send dispatch when Dropbox remaining quota is above the fail-closed threshold", async () => {
    const h = harness();
    h.repository.loadLeadSendContext.mockResolvedValue(
      leadContext({ testMode: false }),
    );
    h.repository.claimSend.mockResolvedValue({
      outcome: "created",
      request: request({ testMode: false }),
    });
    h.provider.getRemainingSignatureRequests.mockResolvedValue(11);

    const result = await h.core.send(sendInput);

    expect(result).toEqual({ ok: true, data: { requestId: "request-1" } });
    expect(h.repository.reserveLiveSend).toHaveBeenCalledWith({
      orgId: "org-1",
      requestId: "request-1",
      providerRemaining: 11,
    });
    expect(h.provider.sendWithTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ testMode: false }),
    );
  });

  it("fails a claimed live request when the Sandra reservation RPC is uncertain", async () => {
    const h = harness();
    h.repository.loadLeadSendContext.mockResolvedValue(
      leadContext({ testMode: false }),
    );
    h.repository.claimSend.mockResolvedValue({
      outcome: "created",
      request: request({ testMode: false }),
    });
    h.repository.reserveLiveSend.mockRejectedValue(
      new Error("database connection lost"),
    );

    const result = await h.core.send(sendInput);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "LIVE_QUOTA_BLOCKED" },
    });
    expect(h.repository.markSendOutcome).toHaveBeenCalledWith({
      orgId: "org-1",
      requestId: "request-1",
      deliveryState: "failed",
      safeErrorMessage: "SANDRA_LIVE_RESERVATION_UNCERTAIN",
    });
    expect(h.provider.sendWithTemplate).not.toHaveBeenCalled();
  });

  it("keeps a lead with no homeowner contact blocked before provider dispatch", async () => {
    const h = harness();
    h.repository.loadLeadSendContext.mockResolvedValue(
      leadContext({ hasHomeownerContact: false, sellerEmailAddress: null }),
    );

    const result = await h.core.send(sendInput);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "OWNER_CONTACT_MISSING",
        message: "No homeowner contact is linked to this lead.",
      },
    });
    expect(h.repository.claimSend).not.toHaveBeenCalled();
    expect(h.provider.sendWithTemplate).not.toHaveBeenCalled();
  });

  it("surfaces a duplicate seller email claim before provider dispatch", async () => {
    const h = harness();
    h.repository.claimSend.mockResolvedValue({
      outcome: "seller_contact_conflict",
    });

    const result = await h.core.send(sendInput);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "SELLER_EMAIL_CONFLICT",
        message:
          "That seller email belongs to another contact. Use a unique seller email before sending.",
      },
    });
    expect(h.provider.sendWithTemplate).not.toHaveBeenCalled();
  });

  it("does not claim or send while the safe dialog-email migration is absent", async () => {
    const h = harness();
    h.repository.isDialogEmailAuthorityReady.mockResolvedValue(false);

    const result = await h.core.send(sendInput);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "SENDING_DISABLED",
        message: "Contract sending is finishing an update. Try again in a minute.",
      },
    });
    expect(h.repository.claimSend).not.toHaveBeenCalled();
    expect(h.provider.sendWithTemplate).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "whitespace-only",
      emailAddress: "   ",
      code: "OWNER_EMAIL_MISSING",
      message: "Enter the seller email before sending.",
    },
    {
      label: "malformed non-empty",
      emailAddress: "seller@@example.com",
      code: "INVALID_SEND_INPUT",
      message: "Enter one email address without spaces for the seller.",
    },
  ])(
    "returns the seller email-field reason for $label input",
    async ({ emailAddress, code, message }) => {
      const h = harness();
      const result = await h.core.send({
        ...sendInput,
        signers: [
          { ...sendInput.signers[0], emailAddress },
          sendInput.signers[1],
        ],
      });

      expect(result).toMatchObject({ ok: false, error: { code, message } });
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

  it.each([
    {
      outcome: "authorization_changed" as const,
      code: "AUTHORIZATION_CHANGED",
    },
    { outcome: "not_found" as const, code: "NOT_FOUND" },
  ])(
    "returns a safe $code result for an atomic $outcome claim",
    async ({ outcome, code }) => {
      const h = harness();
      h.repository.claimSend.mockResolvedValue({ outcome });

      const result = await h.core.send(sendInput);

      expect(result).toMatchObject({ ok: false, error: { code } });
      expect(JSON.stringify(result)).not.toMatch(
        /seller@example\.com|123 Main|provider-template|property-private/i,
      );
      expect(h.provider.sendWithTemplate).not.toHaveBeenCalled();
    },
  );

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
    expect(h.repository.markSendOutcome).toHaveBeenCalledWith({
      orgId: "org-1",
      requestId: "request-1",
      deliveryState: "failed",
      safeErrorMessage: "REQUEST_CLAIM_MISMATCH",
    });
    expect(h.provider.sendWithTemplate).not.toHaveBeenCalled();
  });

  it("dispatches the forensic one-signer row shape after ignoring database-only signer fields", async () => {
    const h = harness();
    const forensicTemplate = {
      ...template,
      signerRoles: [{ name: "Seller", order: 0 }],
    };
    const forensicInput = {
      ...sendInput,
      signers: [sendInput.signers[0]],
    };
    h.repository.loadLeadSendContext.mockResolvedValue(
      leadContext({ templates: [forensicTemplate] }),
    );
    h.repository.claimSend.mockResolvedValue({
      outcome: "created",
      request: request({
        id: "c36c5e1e-a98d-4b1e-a768-f0ea6d7e854c",
        template: forensicTemplate,
        payloadHash: hashSendPayload(forensicInput),
        signers: [
          {
            ...forensicInput.signers[0],
            id: "persisted-signer-1",
            status: "awaiting",
            lastRemindedAt: null,
          },
        ],
      }),
    });
    h.provider.sendWithTemplate.mockResolvedValue({
      outcome: "sent",
      providerRequestId: "provider-request-1",
      detailsUrl:
        "https://app.hellosign.com/home/manage?guid=provider-request-1",
      signatures: [
        { ...forensicInput.signers[0], signatureId: "signature-1" },
      ],
    });

    const result = await h.core.send(forensicInput);

    expect(result).toEqual({ ok: true, data: { requestId: "c36c5e1e-a98d-4b1e-a768-f0ea6d7e854c" } });
    expect(h.provider.sendWithTemplate).toHaveBeenCalledTimes(1);
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
      expect(duplicate).toMatchObject({
        ok: false,
        error: { code: "SEND_UNKNOWN" },
      });
      expect(h.provider.sendWithTemplate).toHaveBeenCalledTimes(1);
    },
  );

  it("fences an abort-ignoring provider timeout as send_unknown before the provider settles", async () => {
    vi.useFakeTimers();
    const h = harness();
    let capturedSignal: AbortSignal | undefined;
    h.provider.sendWithTemplate.mockImplementation((input) => {
      capturedSignal = input.signal;
      return new Promise<never>(() => undefined);
    });

    const resultPromise = h.core.send(sendInput);
    await vi.advanceTimersByTimeAsync(ESIGN_PROVIDER_TIMEOUT_MS);

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      error: { code: "SEND_UNKNOWN" },
    });
    expect(capturedSignal?.aborted).toBe(true);
    expect(h.repository.markSendOutcome).toHaveBeenCalledWith({
      orgId: "org-1",
      requestId: "request-1",
      deliveryState: "send_unknown",
      safeErrorMessage: null,
    });
    expect(h.repository.reconcileSent).not.toHaveBeenCalled();
  });

  it.each([
    ["sent", null],
    ["sending", "SEND_IN_PROGRESS"],
    ["send_unknown", "SEND_UNKNOWN"],
    ["email_bounced", "EMAIL_BOUNCED"],
    ["failed", "SEND_FAILED"],
  ] as const)(
    "maps a pre-claim same-intent %s row without redispatch",
    async (deliveryState, code) => {
      const h = harness();
      h.repository.findRequestByIntent.mockResolvedValue(
        request({ deliveryState }),
      );

      const result = await h.core.send(sendInput);

      if (code) expect(result).toMatchObject({ ok: false, error: { code } });
      else
        expect(result).toEqual({ ok: true, data: { requestId: "request-1" } });
      expect(h.repository.loadLeadSendContext).not.toHaveBeenCalled();
      expect(h.repository.claimSend).not.toHaveBeenCalled();
      expect(h.provider.sendWithTemplate).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["sent", null],
    ["sending", "SEND_IN_PROGRESS"],
    ["send_unknown", "SEND_UNKNOWN"],
    ["email_bounced", "EMAIL_BOUNCED"],
    ["failed", "SEND_FAILED"],
  ] as const)(
    "maps a claim-race same-intent %s row without redispatch",
    async (deliveryState, code) => {
      const h = harness();
      h.repository.claimSend.mockImplementation(async (input) => ({
        outcome: "existing",
        request: request({
          deliveryState,
          payloadHash: input.payloadHash,
          sendIntentId: input.sendIntentId,
        }),
      }));

      const result = await h.core.send(sendInput);

      if (code) expect(result).toMatchObject({ ok: false, error: { code } });
      else
        expect(result).toEqual({ ok: true, data: { requestId: "request-1" } });
      expect(h.provider.sendWithTemplate).not.toHaveBeenCalled();
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
      safeErrorMessage: "PROVIDER_REJECTED",
    });
  });

  it("records a provider-plan rejection as terminal failed history", async () => {
    const h = harness();
    h.repository.loadLeadSendContext.mockResolvedValue(
      leadContext({ testMode: false }),
    );
    h.repository.claimSend.mockResolvedValue({
      outcome: "created",
      request: request({ testMode: false }),
    });
    h.provider.sendWithTemplate.mockResolvedValue({
      outcome: "provider_plan_required",
    });

    const result = await h.core.send(sendInput);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PROVIDER_PLAN_REQUIRED" },
    });
    expect(h.repository.markSendOutcome).toHaveBeenCalledWith({
      orgId: "org-1",
      requestId: "request-1",
      deliveryState: "failed",
      safeErrorMessage: "PROVIDER_PLAN_REQUIRED",
    });
  });

  it("keeps provider-plan rejection retryable when local reservation cleanup is unconfirmed", async () => {
    const h = harness();
    h.repository.loadLeadSendContext.mockResolvedValue(
      leadContext({ testMode: false }),
    );
    h.repository.claimSend.mockResolvedValue({
      outcome: "created",
      request: request({ testMode: false }),
    });
    h.provider.sendWithTemplate.mockResolvedValue({
      outcome: "provider_plan_required",
    });
    h.repository.markSendOutcome.mockRejectedValueOnce(
      new Error("private rpc commit state unknown"),
    );

    const result = await h.core.send(sendInput);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "SEND_UNKNOWN" },
    });
    expect(JSON.stringify(result)).not.toContain("private rpc commit");
    expect(reportMocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "eSign send outcome bookkeeping failed.",
      }),
      {
        tags: {
          surface: "esign_send_outcome_bookkeeping",
          delivery_state: "failed",
        },
      },
    );
  });

  it.each([
    ["unknown", "SEND_UNKNOWN"],
    ["failed", "SEND_FAILED"],
    ["disconnected", "PROVIDER_DISCONNECTED"],
  ] as const)(
    "preserves the authoritative %s outcome when bookkeeping fails",
    async (mode, code) => {
      const h = harness();
      h.repository.markSendOutcome.mockRejectedValue(
        new Error("private repository failure"),
      );
      if (mode === "unknown") {
        h.provider.sendWithTemplate.mockResolvedValue({ outcome: "ambiguous" });
      } else if (mode === "failed") {
        h.provider.sendWithTemplate.mockResolvedValue({
          outcome: "definitive_failure",
        });
      } else {
        vi.mocked(h.dependencies.providerForOrg).mockResolvedValue(null);
      }

      const result = await h.core.send(sendInput);

      expect(result).toMatchObject({ ok: false, error: { code } });
      expect(JSON.stringify(result)).not.toContain(
        "private repository failure",
      );
      expect(reportMocks.reportError).toHaveBeenCalledTimes(1);
      const [reportedError, context] = reportMocks.reportError.mock.calls[0];
      expect(reportedError).toEqual(
        expect.objectContaining({
          message: "eSign send outcome bookkeeping failed.",
        }),
      );
      expect(context).toEqual({
        tags: {
          surface: "esign_send_outcome_bookkeeping",
          delivery_state: mode === "unknown" ? "send_unknown" : "failed",
        },
      });
      expect(JSON.stringify([reportedError.message, context])).not.toMatch(
        /private repository failure|seller@example|property-1|request-1/,
      );
    },
  );

  it("marks a claimed send failed when provider setup throws and never calls a provider method", async () => {
    const h = harness();
    vi.mocked(h.dependencies.providerForOrg).mockRejectedValue(
      new Error("private credential setup failure"),
    );

    const result = await h.core.send(sendInput);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PROVIDER_DISCONNECTED" },
    });
    expect(h.repository.markSendOutcome).toHaveBeenCalledWith({
      orgId: "org-1",
      requestId: "request-1",
      deliveryState: "failed",
      safeErrorMessage: "PROVIDER_SETUP_FAILED",
    });
    expect(h.provider.sendWithTemplate).not.toHaveBeenCalled();
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
      request({
        deliveryState: "failed",
        status: "error",
        signers: sendInput.signers.map((signer, index) => ({
          ...signer,
          id: `stored-signer-${index + 1}`,
          status: "error" as const,
          lastRemindedAt: "2026-08-29T19:00:00.000Z",
        })),
      }),
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
        signers: sendInput.signers,
      }),
    );
  });

  it("fails a consumed retry without a second provider dispatch", async () => {
    const h = harness();
    h.repository.findRequest.mockResolvedValue(
      request({ deliveryState: "failed", status: "error" }),
    );
    h.repository.claimSend.mockResolvedValue({ outcome: "retry_ineligible" });

    expect(await h.core.retry({ requestId: "request-1" })).toMatchObject({
      ok: false,
      error: { code: "RETRY_INELIGIBLE" },
    });
    expect(h.provider.sendWithTemplate).not.toHaveBeenCalled();
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

  it("fixes a bounced signer email by updating the same provider request", async () => {
    const h = harness();
    h.repository.claimEmailBounceUpdate.mockResolvedValue({
      outcome: "eligible",
      candidate: {
        claimToken: "claim-token-1",
        providerRequestId: "provider-request-1",
        signer: {
          id: "stored-signer-1",
          providerSignatureId: "signature-old",
          role: "Seller",
          order: 0,
          name: "Seller Owner",
          emailAddress: "seller-fixed@example.com",
        },
      },
    });

    const result = await h.core.fixSignerEmailAndResend({
      requestId: "request-1",
      signerId: "stored-signer-1",
      emailAddress: " seller-fixed@example.com ",
    });

    expect(result).toEqual({ ok: true, data: null });
    expect(h.repository.claimEmailBounceUpdate).toHaveBeenCalledWith({
      orgId: "org-1",
      requestId: "request-1",
      signerId: "stored-signer-1",
      actorId: "user-1",
      emailAddress: "seller-fixed@example.com",
    });
    expect(h.dependencies.providerForOrg).toHaveBeenCalledWith("org-1", {
      requireSendingEnabled: false,
    });
    expect(h.provider.updateSignerEmail).toHaveBeenCalledWith({
      providerRequestId: "provider-request-1",
      providerSignatureId: "signature-old",
      signerName: "Seller Owner",
      signerEmailAddress: "seller-fixed@example.com",
      signerRole: "Seller",
      signerOrder: 0,
      signal: expect.any(AbortSignal),
    });
    expect(h.repository.finalizeEmailBounceUpdate).toHaveBeenCalledWith({
      orgId: "org-1",
      requestId: "request-1",
      signerId: "stored-signer-1",
      claimToken: "claim-token-1",
      providerSignatureId: "signature-updated",
    });
    expect(h.repository.claimSend).not.toHaveBeenCalled();
    expect(h.provider.sendWithTemplate).not.toHaveBeenCalled();
    expect(h.repository.releaseEmailBounceUpdate).not.toHaveBeenCalled();
  });

  it("releases a bounced signer email claim after definitive provider failure", async () => {
    const h = harness();
    h.repository.claimEmailBounceUpdate.mockResolvedValue({
      outcome: "eligible",
      candidate: {
        claimToken: "claim-token-1",
        providerRequestId: "provider-request-1",
        signer: {
          id: "stored-signer-1",
          providerSignatureId: "signature-old",
          role: "Seller",
          order: 0,
          name: "Seller Owner",
          emailAddress: "seller-fixed@example.com",
        },
      },
    });
    h.provider.updateSignerEmail.mockResolvedValue({
      outcome: "definitive_failure",
    });

    const result = await h.core.fixSignerEmailAndResend({
      requestId: "request-1",
      signerId: "stored-signer-1",
      emailAddress: "seller-fixed@example.com",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "EMAIL_FIX_FAILED" },
    });
    expect(h.repository.releaseEmailBounceUpdate).toHaveBeenCalledWith({
      orgId: "org-1",
      requestId: "request-1",
      signerId: "stored-signer-1",
      claimToken: "claim-token-1",
    });
    expect(h.repository.finalizeEmailBounceUpdate).not.toHaveBeenCalled();
    expect(h.provider.sendWithTemplate).not.toHaveBeenCalled();
  });

  it("keeps a bounced signer email claim fenced after an ambiguous provider update", async () => {
    const h = harness();
    h.repository.claimEmailBounceUpdate.mockResolvedValue({
      outcome: "eligible",
      candidate: {
        claimToken: "claim-token-1",
        providerRequestId: "provider-request-1",
        signer: {
          id: "stored-signer-1",
          providerSignatureId: "signature-old",
          role: "Seller",
          order: 0,
          name: "Seller Owner",
          emailAddress: "seller-fixed@example.com",
        },
      },
    });
    h.provider.updateSignerEmail.mockResolvedValue({ outcome: "ambiguous" });

    const result = await h.core.fixSignerEmailAndResend({
      requestId: "request-1",
      signerId: "stored-signer-1",
      emailAddress: "seller-fixed@example.com",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "EMAIL_FIX_UNKNOWN" },
    });
    expect(h.repository.releaseEmailBounceUpdate).not.toHaveBeenCalled();
    expect(h.repository.finalizeEmailBounceUpdate).not.toHaveBeenCalled();
    expect(h.provider.sendWithTemplate).not.toHaveBeenCalled();
  });

  it("acknowledges only an already evidenced failed not-sent request and replays cleanly", async () => {
    const h = harness();
    h.repository.findRequest.mockResolvedValue(
      request({
        deliveryState: "failed",
        status: "error",
        errorMessage: "PROVIDER_SEND_NOT_FOUND",
      }),
    );

    const result = await h.core.confirmNotSent({ requestId: "request-1" });
    const replay = await h.core.confirmNotSent({ requestId: "request-1" });

    expect(result).toEqual({ ok: true, data: null });
    expect(replay).toEqual({ ok: true, data: null });
    expect(h.repository.findProviderLookupReference).not.toHaveBeenCalled();
    expect(h.provider.findSignatureRequestIdsByLocalRequestId).not.toHaveBeenCalled();
    expect(h.repository.resolveSendUnknownNotSent).toHaveBeenCalledWith({
      orgId: "org-1",
      requestId: "request-1",
      actorId: "user-1",
      evidence: expect.objectContaining({
        resolutionSource: "operator",
        acknowledgedFailure: "PROVIDER_SEND_NOT_FOUND",
      }),
    });
    expect(h.repository.resolveSendUnknownNotSent).toHaveBeenCalledTimes(2);
    expect(h.repository.markSendOutcome).not.toHaveBeenCalled();
    expect(h.provider.sendWithTemplate).not.toHaveBeenCalled();
  });

  it("refuses operator acknowledgement for unresolved unknown sends and non-owners", async () => {
    const h = harness();
    h.repository.findRequest.mockResolvedValue(
      request({ deliveryState: "send_unknown" }),
    );

    expect(await h.core.confirmNotSent({ requestId: "request-1" })).toMatchObject({
      ok: false,
      error: { code: "CONFIRM_NOT_SENT_INELIGIBLE" },
    });
    expect(h.repository.resolveSendUnknownNotSent).not.toHaveBeenCalled();

    vi.mocked(h.dependencies.authenticate).mockResolvedValue({
      orgId: "org-1",
      userId: "user-member",
      role: "member",
    });
    h.repository.findRequest.mockResolvedValue(
      request({
        deliveryState: "failed",
        status: "error",
        errorMessage: "PROVIDER_SEND_NOT_FOUND",
      }),
    );

    expect(await h.core.confirmNotSent({ requestId: "request-1" })).toMatchObject({
      ok: false,
      error: { code: "OWNER_REQUIRED" },
    });
    expect(h.repository.resolveSendUnknownNotSent).not.toHaveBeenCalled();
    expect(h.provider.sendWithTemplate).not.toHaveBeenCalled();
  });

  it("enforces signer eligibility and the one-hour reminder cooldown", async () => {
    const h = harness();
    h.repository.claimReminder
      .mockResolvedValueOnce({ outcome: "cooldown" })
      .mockResolvedValueOnce({
        outcome: "eligible",
        candidate: {
          claimToken: "reminder-claim-1",
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
    expect(h.repository.finalizeReminder).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: "reminder-claim-1" }),
    );
  });

  it.each([
    ["ambiguous", "REMINDER_UNKNOWN", true],
    ["definitive_failure", "REMINDER_FAILED", false],
  ] as const)(
    "handles a %s reminder without replaying the provider mutation",
    async (outcome, code, finalized) => {
      const h = harness();
      h.repository.claimReminder.mockResolvedValue({
        outcome: "eligible",
        candidate: {
          claimToken: "reminder-claim-1",
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
      h.provider.remind.mockResolvedValue(outcome);

      const result = await h.core.remind({
        requestId: "request-1",
        signerId: "signature-1",
      });

      expect(result).toMatchObject({ ok: false, error: { code } });
      expect(h.provider.remind).toHaveBeenCalledTimes(1);
      if (finalized) {
        expect(h.repository.finalizeReminder).toHaveBeenCalledWith({
          orgId: "org-1",
          requestId: "request-1",
          signerId: "signature-1",
          claimToken: "reminder-claim-1",
        });
        expect(h.repository.releaseReminder).not.toHaveBeenCalled();
      } else {
        expect(h.repository.finalizeReminder).not.toHaveBeenCalled();
        expect(h.repository.releaseReminder).toHaveBeenCalledWith({
          orgId: "org-1",
          requestId: "request-1",
          signerId: "signature-1",
          claimToken: "reminder-claim-1",
        });
      }
    },
  );

  it("fails closed on a reminder reconciliation fence without loading a provider", async () => {
    const h = harness();
    h.repository.claimReminder.mockResolvedValue({
      outcome: "reconciliation_required",
    });

    expect(
      await h.core.remind({
        requestId: "request-1",
        signerId: "signature-1",
      }),
    ).toMatchObject({ ok: false, error: { code: "REMINDER_UNKNOWN" } });
    expect(h.dependencies.providerForOrg).not.toHaveBeenCalled();
    expect(h.provider.remind).not.toHaveBeenCalled();
    expect(h.repository.finalizeReminder).not.toHaveBeenCalled();
    expect(h.repository.releaseReminder).not.toHaveBeenCalled();
  });

  it.each([
    ["accepted", "throws"],
    ["accepted", "lease_lost"],
    ["ambiguous", "throws"],
    ["ambiguous", "lease_lost"],
  ] as const)(
    "preserves a reminder claim after provider %s when finalization %s",
    async (providerOutcome, finalizeOutcome) => {
      const h = harness();
      h.repository.claimReminder.mockResolvedValue({
        outcome: "eligible",
        candidate: {
          claimToken: "reminder-claim-fenced",
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
      h.provider.remind.mockResolvedValue(providerOutcome);
      if (finalizeOutcome === "throws") {
        h.repository.finalizeReminder.mockRejectedValue(
          new Error("finalization failed"),
        );
      } else {
        h.repository.finalizeReminder.mockResolvedValue("lease_lost");
      }

      expect(
        await h.core.remind({
          requestId: "request-1",
          signerId: "signature-1",
        }),
      ).toMatchObject({ ok: false, error: { code: "REMINDER_UNKNOWN" } });
      expect(h.provider.remind).toHaveBeenCalledTimes(1);
      expect(h.repository.releaseReminder).not.toHaveBeenCalled();
    },
  );

  it("releases an exact reminder lease when provider setup throws and makes no provider call", async () => {
    const h = harness();
    h.repository.claimReminder.mockResolvedValue({
      outcome: "eligible",
      candidate: {
        claimToken: "reminder-claim-setup",
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
    vi.mocked(h.dependencies.providerForOrg).mockRejectedValue(
      new Error("private provider setup"),
    );

    const result = await h.core.remind({
      requestId: "request-1",
      signerId: "signature-1",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PROVIDER_DISCONNECTED" },
    });
    expect(h.repository.releaseReminder).toHaveBeenCalledWith({
      orgId: "org-1",
      requestId: "request-1",
      signerId: "signature-1",
      claimToken: "reminder-claim-setup",
    });
    expect(h.provider.remind).not.toHaveBeenCalled();
  });

  it("independently rejects a stale eligible reminder claim inside one hour", async () => {
    const h = harness();
    h.repository.claimReminder.mockResolvedValue({
      outcome: "eligible",
      candidate: {
        claimToken: "reminder-claim-1",
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
    expect(h.repository.releaseReminder).toHaveBeenCalledWith({
      orgId: "org-1",
      requestId: "request-1",
      signerId: "signature-1",
      claimToken: "reminder-claim-1",
    });
    expect(h.provider.remind).not.toHaveBeenCalled();
  });

  it("rejects a cross-org reminder candidate or mismatched signer claim", async () => {
    const h = harness();
    h.repository.claimReminder.mockResolvedValue({
      outcome: "eligible",
      candidate: {
        claimToken: "reminder-claim-1",
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
    expect(h.repository.releaseReminder).toHaveBeenCalledWith({
      orgId: "org-1",
      requestId: "request-1",
      signerId: "signature-1",
      claimToken: "reminder-claim-1",
    });
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
      claimToken: "void-claim-1",
    });

    const result = await h.core.void({ requestId: "request-1" });

    expect(result).toEqual({ ok: true, data: null });
    expect(h.repository.finalizeVoid).toHaveBeenCalledWith({
      orgId: "org-1",
      requestId: "request-1",
      claimToken: "void-claim-1",
    });
    expect(awaiting.status).toBe("awaiting");
    expect(awaiting.voidRequestedAt).toBeNull();
  });

  it.each([
    ["ambiguous", "VOID_UNKNOWN", true],
    ["definitive_failure", "VOID_FAILED", false],
  ] as const)(
    "handles a %s void without replaying or marking the contract voided",
    async (outcome, code, finalized) => {
      const h = harness();
      const awaiting = request({
        deliveryState: "sent",
        providerRequestId: "provider-request-1",
      });
      h.repository.claimVoid.mockResolvedValue({
        outcome: "eligible",
        request: awaiting,
        claimToken: "void-claim-1",
      });
      h.provider.cancel.mockResolvedValue(outcome);

      const result = await h.core.void({ requestId: "request-1" });

      expect(result).toMatchObject({ ok: false, error: { code } });
      expect(h.provider.cancel).toHaveBeenCalledTimes(1);
      expect(awaiting.status).toBe("awaiting");
      expect(awaiting.voidRequestedAt).toBeNull();
      if (finalized) {
        expect(h.repository.finalizeVoid).toHaveBeenCalledWith({
          orgId: "org-1",
          requestId: "request-1",
          claimToken: "void-claim-1",
        });
        expect(h.repository.releaseVoid).not.toHaveBeenCalled();
      } else {
        expect(h.repository.finalizeVoid).not.toHaveBeenCalled();
        expect(h.repository.releaseVoid).toHaveBeenCalledWith({
          orgId: "org-1",
          requestId: "request-1",
          claimToken: "void-claim-1",
        });
      }
    },
  );

  it("fails closed on a void reconciliation fence without loading a provider", async () => {
    const h = harness();
    h.repository.claimVoid.mockResolvedValue({
      outcome: "reconciliation_required",
    });

    expect(await h.core.void({ requestId: "request-1" })).toMatchObject({
      ok: false,
      error: { code: "VOID_UNKNOWN" },
    });
    expect(h.dependencies.providerForOrg).not.toHaveBeenCalled();
    expect(h.provider.cancel).not.toHaveBeenCalled();
    expect(h.repository.finalizeVoid).not.toHaveBeenCalled();
    expect(h.repository.releaseVoid).not.toHaveBeenCalled();
  });

  it.each([
    ["accepted", "throws"],
    ["accepted", "lease_lost"],
    ["ambiguous", "throws"],
    ["ambiguous", "lease_lost"],
  ] as const)(
    "preserves a void claim after provider %s when finalization %s",
    async (providerOutcome, finalizeOutcome) => {
      const h = harness();
      h.repository.claimVoid.mockResolvedValue({
        outcome: "eligible",
        request: request({
          deliveryState: "sent",
          providerRequestId: "provider-request-1",
        }),
        claimToken: "void-claim-fenced",
      });
      h.provider.cancel.mockResolvedValue(providerOutcome);
      if (finalizeOutcome === "throws") {
        h.repository.finalizeVoid.mockRejectedValue(
          new Error("finalization failed"),
        );
      } else {
        h.repository.finalizeVoid.mockResolvedValue("lease_lost");
      }

      expect(await h.core.void({ requestId: "request-1" })).toMatchObject({
        ok: false,
        error: { code: "VOID_UNKNOWN" },
      });
      expect(h.provider.cancel).toHaveBeenCalledTimes(1);
      expect(h.repository.releaseVoid).not.toHaveBeenCalled();
    },
  );

  it("releases an exact void lease when provider setup throws and makes no provider call", async () => {
    const h = harness();
    h.repository.claimVoid.mockResolvedValue({
      outcome: "eligible",
      request: request({
        deliveryState: "sent",
        providerRequestId: "provider-request-1",
      }),
      claimToken: "void-claim-setup",
    });
    vi.mocked(h.dependencies.providerForOrg).mockRejectedValue(
      new Error("private provider setup"),
    );

    const result = await h.core.void({ requestId: "request-1" });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PROVIDER_DISCONNECTED" },
    });
    expect(h.repository.releaseVoid).toHaveBeenCalledWith({
      orgId: "org-1",
      requestId: "request-1",
      claimToken: "void-claim-setup",
    });
    expect(h.provider.cancel).not.toHaveBeenCalled();
  });

  it("rejects an already void-pending request without another provider call", async () => {
    const h = harness();
    h.repository.claimVoid.mockResolvedValue({
      outcome: "eligible",
      claimToken: "void-claim-1",
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
    expect(h.repository.releaseVoid).toHaveBeenCalledWith({
      orgId: "org-1",
      requestId: "request-1",
      claimToken: "void-claim-1",
    });
    expect(h.provider.cancel).not.toHaveBeenCalled();
  });

  it("preserves the ineligible result when a defensive release loses its lease", async () => {
    const h = harness();
    h.repository.claimVoid.mockResolvedValue({
      outcome: "eligible",
      claimToken: "void-claim-lost",
      request: request({
        deliveryState: "sent",
        providerRequestId: "provider-request-1",
        status: "signed",
      }),
    });
    h.repository.releaseVoid.mockResolvedValue("lease_lost");

    expect(await h.core.void({ requestId: "request-1" })).toMatchObject({
      ok: false,
      error: { code: "VOID_INELIGIBLE" },
    });
    expect(h.repository.releaseVoid).toHaveBeenCalledWith({
      orgId: "org-1",
      requestId: "request-1",
      claimToken: "void-claim-lost",
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
