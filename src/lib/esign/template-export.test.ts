import { describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors/classes";

import { EsignSecret } from "./secret";
import {
  parseOptions,
  runTemplateExport,
  TemplateExportRunError,
  type TemplateExportDependencies,
} from "./template-export";
import type { TemplateSnapshot } from "./contracts";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const TEMPLATE_ID = "22222222-2222-4222-8222-222222222222";
const PROVIDER_TEMPLATE_ID = "provider-template-1";
const snapshot: TemplateSnapshot = {
  layout: {
    version: 1,
    signerRoles: [
      { name: "Seller", order: 0 },
      { name: "Buyer", order: 1 },
    ],
    mergeFieldNames: ["seller_name", "property_address"],
    documents: [{
      index: 0,
      name: "agreement.pdf",
      fields: [
        {
          apiId: "seller-signature",
          name: "Seller signature",
          type: "signature",
          signer: 0,
          page: 0,
          x: 1,
          y: 2,
          width: 3,
          height: 4,
          required: true,
        },
        {
          apiId: "seller-name",
          name: "seller_name",
          type: "text",
          signer: "sender",
          page: 1,
          x: 5,
          y: 6,
          width: 7,
          height: 8,
          required: false,
        },
      ],
    }],
  },
  pdf: Buffer.from("%PDF-fake"),
  sha256: "a".repeat(64),
};

function dependencies(overrides: Partial<TemplateExportDependencies> = {}) {
  const write = vi.fn();
  const provider = {
    exportTemplateSnapshot: vi.fn().mockResolvedValue(snapshot),
  };
  const base: TemplateExportDependencies = {
    listOrganizationIds: vi.fn().mockResolvedValue([ORG_ID]),
    getCredentials: vi.fn().mockResolvedValue({
      apiKey: new EsignSecret("api-key"),
      clientId: "client-id",
    }),
    listTemplates: vi.fn().mockResolvedValue([{
      id: TEMPLATE_ID,
      name: "Purchase Agreement",
      providerTemplateId: PROVIDER_TEMPLATE_ID,
    }]),
    createProvider: vi.fn().mockReturnValue(provider),
    storeSnapshot: vi.fn().mockResolvedValue(undefined),
    write,
    ...overrides,
  };
  return { dependencies: base, provider, write };
}

describe("eSign template export CLI", () => {
  it("parses dry-run and org flags", () => {
    expect(parseOptions(["--dry-run", "--org", ORG_ID])).toEqual({
      dryRun: true,
      orgId: ORG_ID,
    });
    expect(parseOptions([])).toEqual({ dryRun: false });
    expect(parseOptions(["--help"])).toEqual({ help: true });
    expect(() => parseOptions(["--org", "not-an-org"])).toThrow(
      "organization UUID",
    );
  });

  it("calls the provider in dry-run mode and never persists", async () => {
    const fakes = dependencies();

    await expect(
      runTemplateExport({
        options: { dryRun: true },
        dependencies: fakes.dependencies,
      }),
    ).resolves.toEqual({ attempted: 1, stored: 0, dryRun: true, rows: 1 });

    expect(fakes.provider.exportTemplateSnapshot).toHaveBeenCalledWith(
      PROVIDER_TEMPLATE_ID,
    );
    expect(fakes.dependencies.storeSnapshot).not.toHaveBeenCalled();
    expect(fakes.write).toHaveBeenCalledWith(
      expect.stringContaining("Purchase Agreement"),
    );
  });

  it("stores only unexported templates and converges to zero work on rerun", async () => {
    const fakes = dependencies();
    const listTemplates = vi.fn()
      .mockResolvedValueOnce([{
        id: TEMPLATE_ID,
        name: "Purchase Agreement",
        providerTemplateId: PROVIDER_TEMPLATE_ID,
      }])
      .mockResolvedValueOnce([]);
    fakes.dependencies.listTemplates = listTemplates;

    await expect(
      runTemplateExport({
        options: { dryRun: false, orgId: ORG_ID },
        dependencies: fakes.dependencies,
      }),
    ).resolves.toMatchObject({ attempted: 1, stored: 1, rows: 1 });
    await expect(
      runTemplateExport({
        options: { dryRun: false, orgId: ORG_ID },
        dependencies: fakes.dependencies,
      }),
    ).resolves.toEqual({ attempted: 0, stored: 0, dryRun: false, rows: 0 });

    expect(fakes.dependencies.listOrganizationIds).not.toHaveBeenCalled();
    expect(fakes.dependencies.storeSnapshot).toHaveBeenCalledWith({
      orgId: ORG_ID,
      templateId: TEMPLATE_ID,
      pdf: snapshot.pdf,
      sha256: snapshot.sha256,
      layout: snapshot.layout,
    });
  });

  it("prints safe failure data and exits through the run error", async () => {
    const fakes = dependencies();
    fakes.provider.exportTemplateSnapshot.mockRejectedValue(
      new ProviderError("secret provider response body", "dropbox_sign", {
        providerCode: "not_found",
        statusCode: 404,
      }),
    );

    await expect(
      runTemplateExport({
        options: { dryRun: true },
        dependencies: fakes.dependencies,
      }),
    ).rejects.toBeInstanceOf(TemplateExportRunError);
    const output = fakes.write.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain('"code":"NOT_FOUND"');
    expect(output).toContain(
      '"message":"Dropbox Sign rejected the template export."',
    );
    expect(output).not.toContain("secret provider response body");
  });
});
