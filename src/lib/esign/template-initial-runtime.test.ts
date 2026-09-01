import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "@/lib/errors/classes";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  download: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  credentials: vi.fn(),
  providerFactory: vi.fn(),
  providerCreate: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/memberships", () => ({
  getCallerMemberships: async () => [
    { user_id: "owner-1", org_id: "org-1", role: "owner" },
  ],
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: mocks.rpc,
    from: mocks.from,
    storage: {
      from: () => ({
        download: mocks.download,
        upload: mocks.upload,
        remove: mocks.remove,
      }),
    },
  }),
}));
vi.mock("./credentials", () => ({
  configuredDropboxSignEmbeddedDomain: () => "example.com",
  getEsignCredentials: mocks.credentials,
}));
vi.mock("./dropbox-sign", () => ({
  createDropboxSignProvider: (...args: unknown[]) => {
    mocks.providerFactory(...args);
    return { createEmbeddedTemplateDraft: mocks.providerCreate };
  },
}));

import {
  createInitialTemplateRuntime,
  providerReconciliationCandidateMatches,
} from "./template-initial-runtime";

const sourceId = "123e4567-e89b-42d3-a456-426614174000";
const bytes = new TextEncoder().encode("%PDF-1.7\nbody");
const sha256 =
  "3f972854841afd236b04b5d7435b73216bc5fa6e39a86aff6e492b744086189c";
const source = {
  stagingSourceId: sourceId,
  bucket: "esign-staging" as const,
  storagePath: `org-1/${sourceId}.pdf`,
  filename: "offer.pdf",
  size: bytes.length,
  mimeType: "application/pdf" as const,
  sha256,
};
const initialEditorSession = {
  providerTemplateId: "provider-1",
  editUrl: "https://app.hellosign.com/editor/initial",
  expiresAt: 123,
  clientId: "client",
};
const retireOriginal = vi.fn().mockResolvedValue({
  ok: true,
  data: { cleanupAttention: false },
});

function restartableDraft(templateId: string) {
  return {
    id: templateId,
    org_id: "org-1",
    name: "Offer",
    document_type: "Purchase agreement",
    seller_role: "Seller",
    signer_roles: [{ name: "Seller", order: 0 }],
    merge_field_names: [
      "seller_name",
      "property_address",
      "offer_price",
      "closing_date",
      "earnest_money",
    ],
    sign_template_id: "provider-stuck",
    staging_source_id: sourceId,
    source_filename: "offer.pdf",
    source_size_bytes: bytes.length,
    source_content_type: "application/pdf",
    source_sha256: sha256,
    staging_path: source.storagePath,
    staging_deleted_at: null,
    lifecycle_state: "editing",
    provider_create_state: "attached",
    duplicate_of_template_id: null,
    supersedes_template_id: null,
    finalized_at: null,
    deleted_at: null,
    abandoned_at: null,
  };
}

function retryableProviderDraft(templateId: string) {
  return {
    ...restartableDraft(templateId),
    sign_template_id: null,
    lifecycle_state: "preparing",
    provider_create_state: "unstarted",
    provider_create_last_released_token_hash: "released-token-hash",
  };
}

function successfulRpc(name: string, args: Record<string, unknown>) {
  if (name === "prepare_esign_template_source_upload")
    return {
      data: [
        {
          outcome: "prepared",
          source_id: args.p_source_id,
          storage_bucket: "esign-staging",
          storage_path: `org-1/${String(args.p_source_id)}.pdf`,
          verification_state: "prepared",
        },
      ],
      error: null,
    };
  if (name === "verify_esign_template_source_upload")
    return {
      data: [
        {
          outcome: "verified",
          source_id: sourceId,
          verification_state: "verified",
        },
      ],
      error: null,
    };
  if (name === "consume_esign_template_source_draft")
    return {
      data: [{ outcome: "created", template_id: "template-1" }],
      error: null,
    };
  if (name === "claim_esign_template_provider_create")
    return {
      data: [
        {
          outcome: "claimed",
          template_id: "template-1",
          provider_create_state: "claimed",
          claim_token: "claim-1",
          provider_template_id: null,
          provider_account_id: "account-1",
          created_by: "owner-1",
        },
      ],
      error: null,
    };
  if (name === "begin_esign_template_provider_create")
    return {
      data: [
        {
          outcome: "started",
          template_id: "template-1",
          provider_create_state: "invoking",
          created_by: "owner-1",
        },
      ],
      error: null,
    };
  if (name === "complete_esign_template_provider_create")
    return {
      data: [
        {
          outcome: "attached",
          template_id: "template-1",
          provider_template_id: "provider-1",
          created_by: "owner-1",
        },
      ],
      error: null,
    };
  if (name === "release_esign_template_provider_create_claim")
    return {
      data: [
        {
          outcome: "released",
          template_id: "template-1",
          created_by: "owner-1",
        },
      ],
      error: null,
    };
  if (name === "mark_esign_template_provider_create_unknown")
    return {
      data: [
        {
          outcome: "recorded_unknown",
          template_id: "template-1",
          created_by: "owner-1",
        },
      ],
      error: null,
    };
  if (name === "record_definitive_esign_template_provider_create_failure")
    return {
      data: [
        {
          outcome: "recorded_failure",
          template_id: "template-1",
          created_by: "owner-1",
        },
      ],
      error: null,
    };
  if (
    name === "list_pending_esign_template_source_uploads" ||
    name === "list_pending_esign_template_provider_creates"
  )
    return { data: [], error: null };
  throw new Error(`unexpected RPC ${name}`);
}

describe("foundation initial-template runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    retireOriginal.mockResolvedValue({
      ok: true,
      data: { cleanupAttention: false },
    });
    mocks.rpc.mockImplementation(successfulRpc);
    mocks.download.mockResolvedValue({
      data: new Blob([bytes], { type: "application/pdf" }),
      error: null,
    });
    mocks.upload.mockResolvedValue({ data: { path: "copied.pdf" }, error: null });
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn(),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.maybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.from.mockReturnValue(query);
    mocks.credentials.mockResolvedValue({
      apiKey: "secret",
      clientId: "client",
      providerAccountId: "account-1",
    });
    mocks.providerCreate.mockResolvedValue(initialEditorSession);
  });

  it("persists the reservation before upload and returns only its canonical path", async () => {
    const result = await (
      await createInitialTemplateRuntime()
    ).prepare({
      stagingSourceId: "123e4567-e89b-42d3-a456-426614174000",
      filename: "offer.pdf",
      size: bytes.length,
      mimeType: "application/pdf",
      sha256,
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        bucket: "esign-staging",
        storagePath: expect.stringMatching(/^org-1\/.+\.pdf$/),
      },
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "prepare_esign_template_source_upload",
      expect.objectContaining({
        p_source_id: "123e4567-e89b-42d3-a456-426614174000",
        p_source_filename: "offer.pdf",
        p_source_size_bytes: bytes.length,
        p_source_sha256: sha256,
      }),
    );
    expect(mocks.credentials).not.toHaveBeenCalled();
    expect(mocks.providerFactory).not.toHaveBeenCalled();
  });

  it("accepts Foundation's exact existing_same_contract prepare replay", async () => {
    mocks.rpc.mockImplementation(
      async (name: string, args: Record<string, unknown>) => {
        if (name === "prepare_esign_template_source_upload") {
          return {
            data: [
              {
                outcome: "existing_same_contract",
                source_id: args.p_source_id,
                storage_bucket: "esign-staging",
                storage_path: `org-1/${String(args.p_source_id)}.pdf`,
                verification_state: "prepared",
              },
            ],
            error: null,
          };
        }
        return successfulRpc(name, args);
      },
    );
    const input = {
      stagingSourceId: "123e4567-e89b-42d3-a456-426614174000",
      filename: "offer.pdf",
      size: bytes.length,
      mimeType: "application/pdf" as const,
      sha256,
    };
    await expect(
      (await createInitialTemplateRuntime()).prepare(input),
    ).resolves.toMatchObject({
      ok: true,
      data: { stagingSourceId: input.stagingSourceId },
    });
    await expect(
      (await createInitialTemplateRuntime()).prepare(input),
    ).resolves.toMatchObject({
      ok: true,
      data: { stagingSourceId: input.stagingSourceId },
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it("promotes an exact stale invoking recovery to unknown without constructing Dropbox", async () => {
    const templateId = "123e4567-e89b-42d3-a456-426614174111";
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "list_pending_esign_template_provider_creates")
        return {
          data: [
            {
              template_id: templateId,
              source_id: sourceId,
              name: "Offer",
              provider_create_state: "invoking",
              created_by: "owner-1",
              created_at: "2026-08-30T00:00:00Z",
            },
          ],
          error: null,
        };
      if (name === "mark_stale_esign_template_provider_create_unknown")
        return {
          data: [
            {
              outcome: "recorded_unknown",
              template_id: templateId,
              provider_create_state: "unknown",
              created_by: "owner-1",
            },
          ],
          error: null,
        };
      return successfulRpc(name, {});
    });
    await expect(
      (await createInitialTemplateRuntime()).promoteStaleProviderCreate(
        templateId,
      ),
    ).resolves.toEqual({
      ok: true,
      data: { templateId, providerCreateState: "unknown" },
    });
    expect(mocks.providerFactory).not.toHaveBeenCalled();
    expect(mocks.providerCreate).not.toHaveBeenCalled();
  });

  it("keeps pre-expiry invoking recovery fail-closed", async () => {
    const templateId = "123e4567-e89b-42d3-a456-426614174111";
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "list_pending_esign_template_provider_creates")
        return {
          data: [
            {
              template_id: templateId,
              source_id: sourceId,
              name: "Offer",
              provider_create_state: "invoking",
            },
          ],
          error: null,
        };
      if (name === "mark_stale_esign_template_provider_create_unknown")
        return {
          data: null,
          error: new Error(
            "provider invocation recovery lease has not expired",
          ),
        };
      return successfulRpc(name, {});
    });
    await expect(
      (await createInitialTemplateRuntime()).promoteStaleProviderCreate(
        templateId,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "PROVIDER_RECOVERY_NOT_STALE" },
    });
    expect(mocks.providerFactory).not.toHaveBeenCalled();
  });

  it("rediscovers attached unfinished ordinary drafts for continue-setup routing", async () => {
    const templateId = "123e4567-e89b-42d3-a456-426614174111";
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "list_pending_esign_template_source_uploads")
        return { data: [], error: null };
      if (name === "list_pending_esign_template_provider_creates")
        return {
          data: [
            {
              template_id: templateId,
              source_id: sourceId,
              name: "Offer",
              provider_create_state: "attached",
              created_by: "owner-1",
              created_at: "2026-08-30T00:00:00Z",
            },
          ],
          error: null,
        };
      return successfulRpc(name, {});
    });
    await expect(
      (await createInitialTemplateRuntime()).listRecoveries(),
    ).resolves.toEqual({
      ok: true,
      data: [
        {
          id: templateId,
          name: "Offer",
          lifecycle: "provider_attention",
          kind: "provider_create",
          providerCreateState: "attached",
        },
      ],
    });
  });

  it("rediscovers a definitively rejected provider create as safely retryable", async () => {
    const templateId = "123e4567-e89b-42d3-a456-426614174111";
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "list_pending_esign_template_source_uploads") return { data: [], error: null };
      if (name === "list_pending_esign_template_provider_creates") return {
        data: [{ template_id: templateId, source_id: sourceId, name: "Offer", provider_create_state: "unstarted" }],
        error: null,
      };
      return successfulRpc(name, {});
    });
    await expect((await createInitialTemplateRuntime()).listRecoveries()).resolves.toEqual({
      ok: true,
      data: [{ id: templateId, name: "Offer", lifecycle: "provider_attention", kind: "provider_create", providerCreateState: "unstarted" }],
    });
  });

  it("revalidates the released draft and retained PDF before retrying provider creation", async () => {
    const templateId = "123e4567-e89b-42d3-a456-426614174111";
    const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.maybeSingle.mockResolvedValue({ data: retryableProviderDraft(templateId), error: null });
    mocks.from.mockReturnValue(query);
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "list_pending_esign_template_provider_creates") return {
        data: [{ template_id: templateId, source_id: sourceId, provider_create_state: "unstarted" }],
        error: null,
      };
      const result = successfulRpc(name, args);
      if (["claim_esign_template_provider_create", "begin_esign_template_provider_create", "complete_esign_template_provider_create"].includes(name)) {
        return { ...result, data: result.data?.map((row) => ({ ...row, template_id: templateId })) };
      }
      return result;
    });
    await expect((await createInitialTemplateRuntime()).retryProviderCreate(templateId)).resolves.toEqual({ ok: true, data: { templateId } });
    expect(mocks.download).toHaveBeenCalledWith(source.storagePath);
    expect(mocks.providerCreate).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("claim_esign_template_provider_create", expect.objectContaining({ p_template_id: templateId, p_source_id: sourceId }));
  });

  it("refuses an unstarted draft without a durable released-attempt fence", async () => {
    const templateId = "123e4567-e89b-42d3-a456-426614174111";
    const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.maybeSingle.mockResolvedValue({ data: { ...retryableProviderDraft(templateId), provider_create_last_released_token_hash: null }, error: null });
    mocks.from.mockReturnValue(query);
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "list_pending_esign_template_provider_creates") return {
        data: [{ template_id: templateId, source_id: sourceId, provider_create_state: "unstarted" }],
        error: null,
      };
      return successfulRpc(name, {});
    });
    await expect((await createInitialTemplateRuntime()).retryProviderCreate(templateId)).resolves.toMatchObject({
      ok: false,
      error: { code: "PROVIDER_RETRY_CONTRACT_MISMATCH" },
    });
    expect(mocks.providerCreate).not.toHaveBeenCalled();
  });

  it("copies the retained private PDF into the fenced initial-create path", async () => {
    const templateId = "123e4567-e89b-42d3-a456-426614174111";
    const query = mocks.from() as {
      maybeSingle: ReturnType<typeof vi.fn>;
    };
    query.maybeSingle.mockResolvedValue({
      data: restartableDraft(templateId),
      error: null,
    });
    mocks.rpc.mockImplementation(
      async (name: string, args: Record<string, unknown>) => {
        if (name === "verify_esign_template_source_upload") {
          return {
            data: [
              {
                outcome: "verified",
                source_id: args.p_source_id,
                verification_state: "verified",
              },
            ],
            error: null,
          };
        }
        return successfulRpc(name, args);
      },
    );

    const result = await (
      await createInitialTemplateRuntime()
    ).createReplacementFromRetainedSource(templateId, retireOriginal);

    expect(result).toEqual({
      ok: true,
      data: {
        templateId: "template-1",
        initialEditorSession,
        cleanupAttention: false,
      },
    });
    expect(mocks.upload).toHaveBeenCalledWith(
      `org-1/${templateId}.pdf`,
      bytes,
      { contentType: "application/pdf", upsert: false },
    );
    expect(mocks.upload.mock.calls[0]?.[0]).not.toBe(source.storagePath);
    expect(mocks.providerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        localTemplateId: "template-1",
        title: "Offer",
      }),
    );
    expect(retireOriginal).toHaveBeenCalledWith("template-1");
    expect(retireOriginal.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.providerCreate.mock.invocationCallOrder[0]!,
    );
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain(
      initialEditorSession.editUrl,
    );
  });

  it("reconciles a concurrent restart onto the same durable source reservation", async () => {
    const templateId = "123e4567-e89b-42d3-a456-426614174111";
    const query = mocks.from() as {
      maybeSingle: ReturnType<typeof vi.fn>;
    };
    query.maybeSingle.mockResolvedValue({
      data: restartableDraft(templateId),
      error: null,
    });
    mocks.upload.mockResolvedValueOnce({
      data: null,
      error: new Error("object already exists"),
    });
    mocks.rpc.mockImplementation(
      (name: string, args: Record<string, unknown>) =>
        name === "verify_esign_template_source_upload"
          ? {
              data: [
                {
                  outcome: "already_verified",
                  source_id: args.p_source_id,
                  verification_state: "verified",
                },
              ],
              error: null,
            }
          : successfulRpc(name, args),
    );

    let claimCount = 0;
    const baseImplementation = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(
      async (name: string, args: Record<string, unknown>) => {
        if (name === "claim_esign_template_provider_create") {
          claimCount += 1;
          if (claimCount === 2) {
            return {
              data: [
                {
                  outcome: "already_in_progress",
                  template_id: "template-1",
                  provider_create_state: "invoking",
                  claim_token: null,
                  provider_template_id: null,
                  provider_account_id: "account-1",
                  created_by: "owner-1",
                },
              ],
              error: null,
            };
          }
        }
        return baseImplementation(name, args);
      },
    );
    const runtime = await createInitialTemplateRuntime();
    const results = await Promise.all([
      runtime.createReplacementFromRetainedSource(templateId, retireOriginal),
      runtime.createReplacementFromRetainedSource(templateId, retireOriginal),
    ]);

    expect(results).toContainEqual({
      ok: true,
      data: {
        templateId: "template-1",
        initialEditorSession,
        cleanupAttention: false,
      },
    });
    expect(results).toContainEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "PROVIDER_CREATE_IN_PROGRESS" }),
      }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "prepare_esign_template_source_upload",
      expect.objectContaining({ p_source_id: templateId }),
    );
    expect(retireOriginal).toHaveBeenCalledTimes(2);
    expect(mocks.providerCreate).toHaveBeenCalledTimes(1);
  });

  it("rejects a conflicting object at the durable restart reservation", async () => {
    const templateId = "123e4567-e89b-42d3-a456-426614174111";
    const query = mocks.from() as {
      maybeSingle: ReturnType<typeof vi.fn>;
    };
    query.maybeSingle.mockResolvedValue({
      data: restartableDraft(templateId),
      error: null,
    });
    mocks.download
      .mockResolvedValueOnce({
        data: new Blob([bytes], { type: "application/pdf" }),
        error: null,
      })
      .mockResolvedValueOnce({
        data: new Blob([new TextEncoder().encode("%PDF-conflict")], {
          type: "application/pdf",
        }),
        error: null,
      });
    mocks.upload.mockResolvedValueOnce({
      data: null,
      error: new Error("object already exists"),
    });
    mocks.rpc.mockImplementation(
      async (name: string, args: Record<string, unknown>) => {
        if (name === "verify_esign_template_source_upload") {
          return {
            data: [
              {
                outcome: "already_verified",
                source_id: args.p_source_id,
                verification_state: "verified",
              },
            ],
            error: null,
          };
        }
        return successfulRpc(name, args);
      },
    );

    const result = await (
      await createInitialTemplateRuntime()
    ).createReplacementFromRetainedSource(templateId, retireOriginal);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PLACEMENT_RESTART_COPY_FAILED" },
    });
    expect(mocks.providerCreate).not.toHaveBeenCalled();
  });

  it("resumes the same replacement reservation after the original was retired", async () => {
    const templateId = "123e4567-e89b-42d3-a456-426614174111";
    const query = mocks.from() as {
      maybeSingle: ReturnType<typeof vi.fn>;
    };
    query.maybeSingle.mockResolvedValue({
      data: {
        ...restartableDraft(templateId),
        lifecycle_state: "abandoned",
        abandoned_at: "2026-09-01T18:00:00Z",
        staging_deleted_at: "2026-09-01T18:00:00Z",
      },
      error: null,
    });
    mocks.upload.mockResolvedValueOnce({
      data: null,
      error: new Error("object already exists"),
    });
    mocks.rpc.mockImplementation(
      async (name: string, args: Record<string, unknown>) => {
        if (name === "verify_esign_template_source_upload") {
          return {
            data: [
              {
                outcome: "already_verified",
                source_id: args.p_source_id,
                verification_state: "verified",
              },
            ],
            error: null,
          };
        }
        return successfulRpc(name, args);
      },
    );

    const result = await (
      await createInitialTemplateRuntime()
    ).createReplacementFromRetainedSource(templateId, retireOriginal);

    expect(result).toMatchObject({
      ok: true,
      data: { templateId: "template-1", cleanupAttention: false },
    });
    expect(mocks.download).toHaveBeenNthCalledWith(
      1,
      `org-1/${templateId}.pdf`,
    );
    expect(retireOriginal).toHaveBeenCalledWith("template-1");
    expect(mocks.providerCreate).toHaveBeenCalledTimes(1);
  });

  it("refuses to copy a draft that is no longer in the unfinished editing state", async () => {
    const templateId = "123e4567-e89b-42d3-a456-426614174111";
    const query = mocks.from() as {
      maybeSingle: ReturnType<typeof vi.fn>;
    };
    query.maybeSingle.mockResolvedValue({
      data: { ...restartableDraft(templateId), lifecycle_state: "finalized" },
      error: null,
    });

    const result = await (
      await createInitialTemplateRuntime()
    ).createReplacementFromRetainedSource(templateId, retireOriginal);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PLACEMENT_RESTART_UNAVAILABLE" },
    });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.providerCreate).not.toHaveBeenCalled();
  });

  it("constructs and invokes Dropbox only after a successful token-fenced begin", async () => {
    const order: string[] = [];
    mocks.rpc.mockImplementation(
      async (name: string, args: Record<string, unknown>) => {
        if (name === "begin_esign_template_provider_create")
          order.push("begin");
        return successfulRpc(name, args);
      },
    );
    mocks.providerFactory.mockImplementation(() => {
      order.push("construct");
    });
    mocks.providerCreate.mockImplementation(async () => {
      order.push("invoke");
      return initialEditorSession;
    });
    const result = await (
      await createInitialTemplateRuntime()
    ).create({
      source,
      name: "Offer",
      documentType: "Purchase agreement",
      signerRoles: [{ name: "Seller", order: 0 }],
      sellerRoleName: "Seller",
    });
    expect(result).toEqual({
      ok: true,
      data: { templateId: "template-1", initialEditorSession },
    });
    expect(order).toEqual(["begin", "construct", "invoke"]);
    expect(mocks.providerCreate).toHaveBeenCalledWith(
      expect.objectContaining({ localTemplateId: "template-1" }),
    );
  });

  it("releases an old-account claim before begin and never constructs Dropbox", async () => {
    mocks.credentials.mockResolvedValue({
      apiKey: "secret",
      clientId: "client",
      providerAccountId: "account-2",
    });
    const result = await (
      await createInitialTemplateRuntime()
    ).create({
      source,
      name: "Offer",
      documentType: "Purchase agreement",
      signerRoles: [{ name: "Seller", order: 0 }],
      sellerRoleName: "Seller",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PROVIDER_ACCOUNT_MISMATCH" },
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "release_esign_template_provider_create_claim",
      expect.objectContaining({ p_claim_token: "claim-1" }),
    );
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "begin_esign_template_provider_create",
      expect.anything(),
    );
    expect(mocks.providerFactory).not.toHaveBeenCalled();
  });

  it("does not load credentials or invoke for an in-progress concurrent claim", async () => {
    mocks.rpc.mockImplementation(
      (name: string, args: Record<string, unknown>) =>
        name === "claim_esign_template_provider_create"
          ? {
              data: [
                {
                  outcome: "already_in_progress",
                  template_id: "template-1",
                  provider_create_state: "invoking",
                  claim_token: null,
                  provider_template_id: null,
                  provider_account_id: "account-1",
                  created_by: "owner-1",
                },
              ],
              error: null,
            }
          : successfulRpc(name, args),
    );
    const result = await (
      await createInitialTemplateRuntime()
    ).create({
      source,
      name: "Offer",
      documentType: "Purchase agreement",
      signerRoles: [{ name: "Seller", order: 0 }],
      sellerRoleName: "Seller",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PROVIDER_CREATE_IN_PROGRESS" },
    });
    expect(mocks.credentials).not.toHaveBeenCalled();
    expect(mocks.providerFactory).not.toHaveBeenCalled();
  });

  it("marks unknown after completion response loss and never invokes twice", async () => {
    mocks.rpc.mockImplementation(
      (name: string, args: Record<string, unknown>) =>
        name === "complete_esign_template_provider_create"
          ? { data: null, error: new Error("response lost") }
          : successfulRpc(name, args),
    );
    const result = await (
      await createInitialTemplateRuntime()
    ).create({
      source,
      name: "Offer",
      documentType: "Purchase agreement",
      signerRoles: [{ name: "Seller", order: 0 }],
      sellerRoleName: "Seller",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PROVIDER_CREATE_UNKNOWN" },
    });
    expect(mocks.providerCreate).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "mark_esign_template_provider_create_unknown",
      expect.objectContaining({ p_error_code: "PROVIDER_ATTACH_UNKNOWN" }),
    );
  });

  it("returns a definitive provider 4xx to retryable state instead of manual reconciliation", async () => {
    mocks.providerCreate.mockRejectedValueOnce(
      new ProviderError("Template quota reached", "dropbox_sign", {
        statusCode: 400,
        providerCode: "bad_request",
        retryable: false,
      }),
    );

    const result = await (
      await createInitialTemplateRuntime()
    ).create({
      source,
      name: "Offer",
      documentType: "Purchase agreement",
      signerRoles: [{ name: "Seller", order: 0 }],
      sellerRoleName: "Seller",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PROVIDER_CREATE_REJECTED" },
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_definitive_esign_template_provider_create_failure",
      expect.objectContaining({
        p_claim_token: "claim-1",
        p_error_code: "PROVIDER_REQUEST_REJECTED",
      }),
    );
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "mark_esign_template_provider_create_unknown",
      expect.anything(),
    );
  });

  it("keeps an ambiguous provider create fenced for manual reconciliation", async () => {
    mocks.providerCreate.mockRejectedValueOnce(new Error("connection reset"));

    const result = await (
      await createInitialTemplateRuntime()
    ).create({
      source,
      name: "Offer",
      documentType: "Purchase agreement",
      signerRoles: [{ name: "Seller", order: 0 }],
      sellerRoleName: "Seller",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PROVIDER_CREATE_UNKNOWN" },
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "mark_esign_template_provider_create_unknown",
      expect.objectContaining({ p_error_code: "PROVIDER_RESPONSE_UNKNOWN" }),
    );
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "record_definitive_esign_template_provider_create_failure",
      expect.anything(),
    );
  });
});

describe("manual provider reconciliation candidate", () => {
  const roles = [
    { name: "Seller", order: 0 },
    { name: "Buyer", order: 1 },
  ];
  const fields = [
    "seller_name",
    "property_address",
    "offer_price",
    "closing_date",
    "earnest_money",
  ];
  const valid = {
    expectedProviderTemplateId: "provider-1",
    expectedLocalTemplateId: sourceId,
    expectedTitle: "Offer",
    expectedRoles: roles,
    sellerRoleName: "Seller",
    expectedMergeFields: fields,
    candidate: {
      providerTemplateId: "provider-1",
      localTemplateId: sourceId,
      title: "Offer",
      signerRoles: roles,
      mergeFieldNames: fields,
    },
  };

  it("accepts only the exact authoritative identity and contract", () => {
    expect(providerReconciliationCandidateMatches(valid)).toBe(true);
  });

  it.each([
    ["wrong provider ID", { providerTemplateId: "provider-other" }],
    [
      "wrong Sandra identity",
      { localTemplateId: "123e4567-e89b-42d3-a456-426614174999" },
    ],
    ["wrong title", { title: "Other" }],
    ["wrong ordered roles", { signerRoles: [...roles].reverse() }],
    ["missing canonical field", { mergeFieldNames: fields.slice(0, 4) }],
  ])("rejects %s", (_label, candidatePatch) => {
    expect(
      providerReconciliationCandidateMatches({
        ...valid,
        candidate: { ...valid.candidate, ...candidatePatch },
      }),
    ).toBe(false);
  });
});
