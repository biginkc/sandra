import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors/classes";

const providerMocks = vi.hoisted(() => ({
  getCredentials: vi.fn(),
  templateCapability: vi.fn(),
  createProvider: vi.fn(),
  sendWithTemplate: vi.fn(),
  remind: vi.fn(),
  cancel: vi.fn(),
  updateSignerEmail: vi.fn(),
}));

vi.mock("@/lib/esign/credentials", () => ({
  configuredDropboxSignEmbeddedDomain: () => "sandra.example.com",
  getEsignCredentials: providerMocks.getCredentials,
  requireEsignTemplateManagementCredentials: providerMocks.templateCapability,
}));

vi.mock("@/lib/esign/dropbox-sign", () => ({
  createDropboxSignProvider: providerMocks.createProvider,
}));

import { providerForOrg } from "./lead-esign-bindings";

describe("bound lead eSign provider classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerMocks.getCredentials.mockResolvedValue({
      sendingEnabled: true,
      apiKey: "secret-wrapper",
      clientId: "client-id",
      providerAccountId: "account-1",
    });
    providerMocks.templateCapability.mockResolvedValue({
      sendingEnabled: false,
      apiKey: "secret-wrapper",
      clientId: "client-id",
      providerAccountId: "account-1",
    });
    providerMocks.createProvider.mockReturnValue({
      sendWithTemplate: providerMocks.sendWithTemplate,
      remind: providerMocks.remind,
      cancel: providerMocks.cancel,
      updateSignerEmail: providerMocks.updateSignerEmail,
    });
  });

  it.each([409, 422] as const)(
    "returns a definitive send failure for non-retryable HTTP %s",
    async (statusCode) => {
      providerMocks.sendWithTemplate.mockRejectedValue(
        new ProviderError("provider rejected request", "dropbox_sign", {
          statusCode,
          retryable: false,
        }),
      );
      const provider = await providerForOrg("org-1");

      await expect(
        provider!.sendWithTemplate({
          localRequestId: "request-1",
          providerTemplateId: "template-1",
          signers: [],
          mergeValues: {
            seller_name: "Seller",
            property_address: "123 Main St",
            offer_price: "$1",
            closing_date: "2026-09-30",
            earnest_money: "$1",
          },
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ outcome: "definitive_failure" });
    },
  );

  it("keeps a retryable send failure ambiguous even when its HTTP status is 409", async () => {
    providerMocks.sendWithTemplate.mockRejectedValue(
      new ProviderError("provider may have accepted request", "dropbox_sign", {
        statusCode: 409,
        retryable: true,
      }),
    );
    const provider = await providerForOrg("org-1");

    await expect(
      provider!.sendWithTemplate({
        localRequestId: "request-1",
        providerTemplateId: "template-1",
        signers: [],
        mergeValues: {
          seller_name: "Seller",
          property_address: "123 Main St",
          offer_price: "$1",
          closing_date: "2026-09-30",
          earnest_money: "$1",
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ outcome: "ambiguous" });
  });

  it("updates a bounced signer email on the existing provider request", async () => {
    providerMocks.updateSignerEmail.mockResolvedValue({
      signatureId: "signature-updated",
      role: "Seller",
      order: 0,
      name: "Seller Owner",
      emailAddress: "fixed-seller@example.com",
    });
    const provider = await providerForOrg("org-1");
    const signal = new AbortController().signal;

    await expect(
      provider!.updateSignerEmail({
        providerRequestId: "provider-request-1",
        providerSignatureId: "signature-old",
        signerName: "Seller Owner",
        signerEmailAddress: "fixed-seller@example.com",
        signerRole: "Seller",
        signerOrder: 0,
        signal,
      }),
    ).resolves.toEqual({
      outcome: "accepted",
      signature: {
        signatureId: "signature-updated",
        role: "Seller",
        order: 0,
        name: "Seller Owner",
        emailAddress: "fixed-seller@example.com",
      },
    });
    expect(providerMocks.updateSignerEmail).toHaveBeenCalledWith({
      signatureRequestId: "provider-request-1",
      signatureId: "signature-old",
      name: "Seller Owner",
      emailAddress: "fixed-seller@example.com",
      role: "Seller",
      order: 0,
      signal,
    });
    expect(providerMocks.sendWithTemplate).not.toHaveBeenCalled();
  });

  it("can build a repair-only provider while sending is disabled", async () => {
    providerMocks.getCredentials.mockResolvedValueOnce({
      sendingEnabled: false,
      apiKey: "secret-wrapper",
      clientId: "client-id",
      providerAccountId: "account-1",
    });

    await expect(
      providerForOrg("org-1", { requireSendingEnabled: false }),
    ).resolves.toBeTruthy();
    expect(providerMocks.createProvider).toHaveBeenCalledWith({
      apiKey: "secret-wrapper",
      clientId: "client-id",
      expectedDomain: "sandra.example.com",
    });
    expect(providerMocks.templateCapability).toHaveBeenCalledWith("org-1");
  });

  it("does not create a repair-only provider while disconnect is pending", async () => {
    providerMocks.getCredentials.mockResolvedValueOnce({
      sendingEnabled: false,
      apiKey: "secret-wrapper",
      clientId: "client-id",
      providerAccountId: "account-1",
    });
    providerMocks.templateCapability.mockRejectedValueOnce(
      new Error("template management unavailable"),
    );

    await expect(
      providerForOrg("org-1", { requireSendingEnabled: false }),
    ).rejects.toThrow("template management unavailable");
    expect(providerMocks.templateCapability).toHaveBeenCalledWith("org-1");
    expect(providerMocks.createProvider).not.toHaveBeenCalled();
  });

  it("does not create a provider client for normal mutations when sending is disabled", async () => {
    providerMocks.getCredentials.mockResolvedValueOnce({
      sendingEnabled: false,
      apiKey: "secret-wrapper",
      clientId: "client-id",
      providerAccountId: "account-1",
    });

    await expect(providerForOrg("org-1")).resolves.toBeNull();
    expect(providerMocks.templateCapability).not.toHaveBeenCalled();
    expect(providerMocks.createProvider).not.toHaveBeenCalled();
  });

  it("keeps normal send operations unreachable after the disabled read", async () => {
    providerMocks.getCredentials.mockResolvedValueOnce({
      sendingEnabled: false,
      apiKey: "secret-wrapper",
      clientId: "client-id",
      providerAccountId: "account-1",
    });

    const provider = await providerForOrg("org-1");

    expect(provider).toBeNull();
    expect(providerMocks.templateCapability).not.toHaveBeenCalled();
    expect(providerMocks.createProvider).not.toHaveBeenCalled();
    expect(providerMocks.sendWithTemplate).not.toHaveBeenCalled();
  });

  it("does not create a provider client after credentials are removed", async () => {
    providerMocks.getCredentials.mockResolvedValueOnce(null);

    await expect(providerForOrg("org-1")).resolves.toBeNull();
    expect(providerMocks.createProvider).not.toHaveBeenCalled();
  });
});
