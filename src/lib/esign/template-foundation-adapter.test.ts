import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors/classes";

const mocks = vi.hoisted(() => ({
  memberships: vi.fn(),
  credentials: vi.fn(),
  providerFactory: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/memberships", () => ({ getCallerMemberships: mocks.memberships }));
vi.mock("./credentials", () => ({
  getEsignCredentials: mocks.credentials,
  configuredDropboxSignEmbeddedDomain: () => "app.example.com",
}));
vi.mock("./dropbox-sign", () => ({ createDropboxSignProvider: mocks.providerFactory }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: mocks.rpc,
    from: mocks.from,
    storage: {
      from: (bucket: string) => ({
        download: (path: string) => mocks.download(bucket, path),
        remove: (paths: string[]) => mocks.remove(bucket, paths),
      }),
    },
  }),
}));

import {
  classifyDropboxTemplateReadError,
  createFoundationTemplateOrchestrator,
  isMissingProviderSyncTimestampColumnError,
} from "./template-foundation-adapter";

const orgId = "123e4567-e89b-42d3-a456-426614174001";
const sourceId = "123e4567-e89b-42d3-a456-426614174000";
const storagePath = `${orgId}/${sourceId}.pdf`;
const bytes = new TextEncoder().encode("%PDF-1.7\nbody");
const sha256 = "3f972854841afd236b04b5d7435b73216bc5fa6e39a86aff6e492b744086189c";

describe("foundation template staging adapter without Dropbox credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memberships.mockResolvedValue([{ user_id: "owner-1", org_id: orgId, role: "owner" }]);
    mocks.credentials.mockResolvedValue(null);
    mocks.download.mockResolvedValue({
      data: new Blob([bytes], { type: "application/pdf" }),
      error: null,
    });
    mocks.remove.mockResolvedValue({ data: [{ name: storagePath }], error: null });
    mocks.rpc.mockResolvedValue({ data: sourceId, error: null });
    mocks.from.mockReset();
  });

  it("verifies and records a canonical private upload without loading credentials or constructing Dropbox", async () => {
    const orchestrator = await createFoundationTemplateOrchestrator();
    await expect(orchestrator.verifyStagedSource({
      stagingSourceId: sourceId,
      bucket: "esign-staging",
      storagePath,
      filename: "offer.pdf",
      size: bytes.byteLength,
      mimeType: "application/pdf",
      sha256,
    })).resolves.toEqual({ ok: true, data: { stagingSourceId: sourceId } });

    expect(mocks.download).toHaveBeenCalledWith("esign-staging", storagePath);
    expect(mocks.rpc).toHaveBeenCalledWith("record_verified_esign_template_source", expect.objectContaining({
      p_org_id: orgId,
      p_source_id: sourceId,
      p_storage_path: storagePath,
      p_source_sha256: sha256,
    }));
    expect(mocks.credentials).not.toHaveBeenCalled();
    expect(mocks.providerFactory).not.toHaveBeenCalled();
  });

  it("labels cleanup as placement restart only when a scoped replacement exists", async () => {
    const finalizedSourceId = "123e4567-e89b-42d3-a456-426614174099";
    const restartSourceId = "123e4567-e89b-42d3-a456-426614174098";
    function query(data: unknown[]) {
      const chain = {
        select: vi.fn(),
        eq: vi.fn(),
        or: vi.fn(),
        in: vi.fn(),
        is: vi.fn(),
        not: vi.fn(),
        order: vi.fn(),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(resolve({ data, error: null })),
      };
      for (const method of [
        chain.select,
        chain.eq,
        chain.or,
        chain.in,
        chain.is,
        chain.not,
        chain.order,
      ]) {
        method.mockReturnValue(chain);
      }
      return chain;
    }
    const activeQuery = query([]);
    const abandonedQuery = query([
          {
            id: "draft-1",
            org_id: orgId,
            name: "Offer",
            lifecycle_state: "abandoned",
            staging_source_id: sourceId,
            duplicate_of_template_id: null,
            supersedes_template_id: null,
          },
          {
            id: "finalized-1",
            org_id: orgId,
            name: "Finalized offer",
            lifecycle_state: "finalized",
            staging_source_id: finalizedSourceId,
            duplicate_of_template_id: null,
            supersedes_template_id: null,
          },
          {
            id: "restart-original-1",
            org_id: orgId,
            name: "Restarted offer",
            lifecycle_state: "abandoned",
            staging_source_id: restartSourceId,
            duplicate_of_template_id: null,
            supersedes_template_id: null,
          },
        ]);
    const stagesQuery = query([
      { id: sourceId },
      { id: finalizedSourceId },
      { id: restartSourceId },
    ]);
    const replacementsQuery = query([
      { staging_source_id: "restart-original-1" },
    ]);
    mocks.from
      .mockReturnValueOnce(activeQuery)
      .mockReturnValueOnce(abandonedQuery)
      .mockReturnValueOnce(stagesQuery)
      .mockReturnValueOnce(replacementsQuery);

    const orchestrator = await createFoundationTemplateOrchestrator();

    await expect(orchestrator.listPendingCopies()).resolves.toEqual({
      ok: true,
      data: [
        {
          id: "draft-1",
          orgId,
          name: "Offer",
          lifecycle: "cleanup_attention",
        },
        {
          id: "restart-original-1",
          orgId,
          name: "Restarted offer",
          lifecycle: "cleanup_attention",
          kind: "placement_restart",
        },
      ],
    });
    expect(activeQuery.or).toHaveBeenCalledTimes(1);
    expect(activeQuery.eq).toHaveBeenCalledWith("org_id", orgId);
    expect(activeQuery.in).toHaveBeenCalledWith("lifecycle_state", [
      "preparing",
      "editing",
    ]);
    expect(activeQuery.is).toHaveBeenCalledWith("deleted_at", null);
    expect(activeQuery.is).toHaveBeenCalledWith("abandoned_at", null);
    expect(abandonedQuery.or).not.toHaveBeenCalled();
    expect(abandonedQuery.eq).toHaveBeenCalledWith("org_id", orgId);
    expect(abandonedQuery.in).toHaveBeenCalledWith("lifecycle_state", [
      "abandoned",
      "finalized",
    ]);
    expect(abandonedQuery.not).toHaveBeenCalledWith(
      "staging_source_id",
      "is",
      null,
    );
    expect(abandonedQuery.is).toHaveBeenCalledWith("deleted_at", null);
    expect(stagesQuery.eq).toHaveBeenCalledWith("org_id", orgId);
    expect(stagesQuery.in).toHaveBeenCalledWith("id", [
      sourceId,
      finalizedSourceId,
      restartSourceId,
    ]);
    expect(stagesQuery.in).toHaveBeenCalledWith("cleanup_outcome", [
      "pending",
      "failed",
    ]);
    expect(replacementsQuery.eq).toHaveBeenCalledWith("org_id", orgId);
    expect(replacementsQuery.in).toHaveBeenCalledWith(
      "staging_source_id",
      ["draft-1", "finalized-1", "restart-original-1"],
    );
    expect(replacementsQuery.in).toHaveBeenCalledWith("lifecycle_state", [
      "preparing",
      "editing",
      "finalized",
    ]);
    expect(replacementsQuery.is).toHaveBeenCalledWith("deleted_at", null);
    expect(replacementsQuery.is).toHaveBeenCalledWith("abandoned_at", null);
  });

});

function query(result: { data: unknown; error: unknown }) {
  const chain = {
    select: vi.fn(),
    update: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    maybeSingle: vi.fn(),
    then: (
      resolve: (value: { data: unknown; error: unknown }) => unknown,
    ) => Promise.resolve(resolve(result)),
  };
  for (const method of [
    chain.select,
    chain.update,
    chain.eq,
    chain.is,
    chain.maybeSingle,
  ]) {
    method.mockReturnValue(chain);
  }
  return chain;
}

const draftRow = {
  id: "template-1",
  org_id: orgId,
  name: "Purchase agreement",
  document_type: "purchase_agreement",
  sign_template_id: "provider-1",
  provider_account_id: "account-1",
  seller_role: "Seller",
  signer_roles: [{ name: "Seller", order: 0 }],
  merge_field_names: [
    "seller_name",
    "property_address",
    "offer_price",
    "closing_date",
    "earnest_money",
  ],
  staging_source_id: null,
  supersedes_template_id: null,
  lifecycle_state: "editing",
};

function configureSuccessfulProvider() {
  mocks.credentials.mockResolvedValue({
    apiKey: { reveal: () => "redacted-test-value" },
    clientId: "client-1",
    providerAccountId: "account-1",
  });
  mocks.providerFactory.mockReturnValue({
    getTemplate: vi.fn().mockResolvedValue({
      providerTemplateId: "provider-1",
      localTemplateId: "template-1",
      title: "Purchase agreement",
      signerRoles: [{ name: "Seller", order: 0 }],
      mergeFieldNames: draftRow.merge_field_names,
    }),
  });
  mocks.rpc.mockResolvedValue({ data: "finalized", error: null });
}

describe("finish synchronization schema compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memberships.mockResolvedValue([
      { user_id: "owner-1", org_id: orgId, role: "owner" },
    ]);
    configureSuccessfulProvider();
  });

  it("finishes against a pre-migration schema without selecting or updating the missing column", async () => {
    const draftQuery = query({ data: draftRow, error: null });
    const capabilityQuery = query({
      data: null,
      error: {
        code: "PGRST204",
        message:
          "Could not find the 'provider_sync_started_at' column of 'esign_templates' in the schema cache",
      },
    });
    const legacyEditingQuery = query({
      data: { id: draftRow.id },
      error: null,
    });
    mocks.from
      .mockReturnValueOnce(draftQuery)
      .mockReturnValueOnce(capabilityQuery)
      .mockReturnValueOnce(legacyEditingQuery);

    const orchestrator = await createFoundationTemplateOrchestrator();

    await expect(orchestrator.finishSync(draftRow.id)).resolves.toMatchObject({
      ok: true,
    });
    expect(draftQuery.select).toHaveBeenCalledWith(
      expect.not.stringContaining("provider_sync_started_at"),
    );
    expect(capabilityQuery.select).toHaveBeenCalledWith(
      "provider_sync_started_at",
    );
    expect(legacyEditingQuery.select).toHaveBeenCalledWith("id");
    expect(legacyEditingQuery.update).not.toHaveBeenCalled();
  });

  it("fails closed on provider not_found when the old schema cannot persist the grace period", async () => {
    const draftQuery = query({ data: draftRow, error: null });
    const capabilityQuery = query({
      data: null,
      error: {
        code: "PGRST204",
        message:
          "Could not find the 'provider_sync_started_at' column of 'esign_templates' in the schema cache",
      },
    });
    const legacyEditingQuery = query({
      data: { id: draftRow.id },
      error: null,
    });
    const getTemplate = vi.fn().mockRejectedValue(new ProviderError(
      "template not found",
      "dropbox_sign",
      { statusCode: 404, providerCode: "not_found" },
    ));
    mocks.providerFactory.mockReturnValue({ getTemplate });
    mocks.from
      .mockReturnValueOnce(draftQuery)
      .mockReturnValueOnce(capabilityQuery)
      .mockReturnValueOnce(legacyEditingQuery);

    const orchestrator = await createFoundationTemplateOrchestrator();

    await expect(orchestrator.finishSync(draftRow.id)).resolves.toEqual({
      ok: false,
      error: {
        code: "PROVIDER_SYNC_FAILED",
        message: "Dropbox Sign template state could not be verified.",
      },
    });
    expect(getTemplate).toHaveBeenCalledTimes(1);
  });

  it("survives rollback between capability read and timestamp update", async () => {
    const draftQuery = query({ data: draftRow, error: null });
    const capabilityQuery = query({
      data: { provider_sync_started_at: null },
      error: null,
    });
    const updateQuery = query({
      data: null,
      error: {
        code: "PGRST204",
        message:
          "Could not find the 'provider_sync_started_at' column of 'esign_templates' in the schema cache",
      },
    });
    const legacyEditingQuery = query({
      data: { id: draftRow.id },
      error: null,
    });
    mocks.from
      .mockReturnValueOnce(draftQuery)
      .mockReturnValueOnce(capabilityQuery)
      .mockReturnValueOnce(updateQuery)
      .mockReturnValueOnce(legacyEditingQuery);

    const orchestrator = await createFoundationTemplateOrchestrator();

    await expect(orchestrator.finishSync(draftRow.id)).resolves.toMatchObject({
      ok: true,
    });
    expect(updateQuery.update).toHaveBeenCalledWith({
      provider_sync_started_at: expect.any(String),
    });
    expect(legacyEditingQuery.select).toHaveBeenCalledWith("id");
  });

  it("does not hide unrelated database failures", async () => {
    mocks.from
      .mockReturnValueOnce(query({ data: draftRow, error: null }))
      .mockReturnValueOnce(query({
        data: null,
        error: {
          code: "42501",
          message: "permission denied for provider_sync_started_at",
        },
      }));

    const orchestrator = await createFoundationTemplateOrchestrator();

    await expect(orchestrator.finishSync(draftRow.id)).resolves.toEqual({
      ok: false,
      error: {
        code: "TEMPLATE_READ_FAILED",
        message: "The template could not be loaded.",
      },
    });
  });
});

describe("Dropbox template-read error classifier", () => {
  it("admits only Dropbox Sign's structured not_found 404 as conversion-pending", () => {
    expect(classifyDropboxTemplateReadError(new ProviderError(
      "not found",
      "dropbox_sign",
      { statusCode: 404, providerCode: "not_found" },
    ))).toBe("not_found");
    expect(classifyDropboxTemplateReadError(new ProviderError(
      "template failed",
      "dropbox_sign",
      { statusCode: 404, providerCode: "template_error" },
    ))).toBe("terminal");
    expect(classifyDropboxTemplateReadError(new ProviderError(
      "unstructured",
      "dropbox_sign",
      { statusCode: 404 },
    ))).toBe("terminal");
    expect(classifyDropboxTemplateReadError({ statusCode: 404, providerCode: "not_found" })).toBe("terminal");
  });
});

describe("provider sync timestamp capability classifier", () => {
  it("accepts only missing-column diagnostics for the exact optional field", () => {
    expect(isMissingProviderSyncTimestampColumnError({
      code: "PGRST204",
      message:
        "Could not find the 'provider_sync_started_at' column of 'esign_templates' in the schema cache",
    })).toBe(true);
    expect(isMissingProviderSyncTimestampColumnError({
      code: "42703",
      message: 'column "provider_sync_started_at" does not exist',
    })).toBe(true);
    expect(isMissingProviderSyncTimestampColumnError({
      code: "PGRST204",
      message: "Could not find the 'different_column' column",
    })).toBe(false);
    expect(isMissingProviderSyncTimestampColumnError({
      code: "42501",
      message: "permission denied for provider_sync_started_at",
    })).toBe(false);
  });
});
