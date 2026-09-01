import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { createFoundationTemplateOrchestrator } from "./template-foundation-adapter";

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
