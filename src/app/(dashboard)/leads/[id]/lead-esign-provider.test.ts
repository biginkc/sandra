import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors/classes";

const providerMocks = vi.hoisted(() => ({
  getCredentials: vi.fn(),
  createProvider: vi.fn(),
  sendWithTemplate: vi.fn(),
  remind: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@/lib/esign/credentials", () => ({
  configuredDropboxSignEmbeddedDomain: () => "sandra.example.com",
  getEsignCredentials: providerMocks.getCredentials,
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
    });
    providerMocks.createProvider.mockReturnValue({
      sendWithTemplate: providerMocks.sendWithTemplate,
      remind: providerMocks.remind,
      cancel: providerMocks.cancel,
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
});
