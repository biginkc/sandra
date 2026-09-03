import { describe, expect, it, vi } from "vitest";

import {
  createEsignTemplateSnapshotDatabaseAdapter,
  ESIGN_DOCUMENTS_BUCKET,
  EsignTemplateSnapshotError,
  type TemplateSnapshotDatabaseClient,
} from "./database-adapter";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const TEMPLATE_ID = "22222222-2222-4222-8222-222222222222";
const PDF = Buffer.from("%PDF-template-snapshot");
const LAYOUT = {
  version: 1 as const,
  signerRoles: [{ name: "Seller", order: 0 }],
  mergeFieldNames: ["seller_name"],
  documents: [],
};

function fakeClient(input: {
  updated?: { id: string } | null;
  updateError?: { code: string } | null;
  removeError?: { code: string } | null;
}) {
  const upload = vi.fn().mockResolvedValue({ data: { path: "ignored" }, error: null });
  const remove = vi.fn().mockImplementation(async (paths: string[]) => ({
    data: input.removeError ? null : [{ name: paths[0] }],
    error: input.removeError ?? null,
  }));
  const maybeSingle = vi.fn().mockResolvedValue({
    data: input.updated === undefined ? { id: TEMPLATE_ID } : input.updated,
    error: input.updateError ?? null,
  });
  const select = vi.fn(() => ({ maybeSingle }));
  const is = vi.fn(() => ({ select }));
  const eqTemplate = vi.fn(() => ({ is }));
  const eqOrg = vi.fn(() => ({ eq: eqTemplate }));
  const update = vi.fn(() => ({ eq: eqOrg }));
  const storageFrom = vi.fn(() => ({ upload, remove }));
  const from = vi.fn(() => ({ update }));
  const client = {
    storage: { from: storageFrom },
    from,
  } as unknown as TemplateSnapshotDatabaseClient;
  return { client, upload, remove, update, maybeSingle, storageFrom };
}

describe("eSign template snapshot persistence", () => {
  it("uploads a private PDF and records the layout and digest in one round trip", async () => {
    const fakes = fakeClient({});
    const adapter = createEsignTemplateSnapshotDatabaseAdapter(fakes.client);

    await expect(
      adapter.storeTemplateSnapshot({
        orgId: ORG_ID,
        templateId: TEMPLATE_ID,
        pdf: PDF,
        sha256: "a".repeat(64),
        layout: LAYOUT,
      }),
    ).resolves.toBeUndefined();

    expect(fakes.storageFrom).toHaveBeenCalledWith(ESIGN_DOCUMENTS_BUCKET);
    const path = fakes.upload.mock.calls[0][0] as string;
    expect(path).toMatch(new RegExp(`^${ORG_ID}/[0-9a-f-]{36}\\.pdf$`));
    expect(fakes.upload).toHaveBeenCalledWith(path, PDF, {
      contentType: "application/pdf",
      upsert: false,
    });
    expect(fakes.update).toHaveBeenCalledWith(
      expect.objectContaining({
        document_storage_bucket: ESIGN_DOCUMENTS_BUCKET,
        document_storage_path: path,
        field_layout: LAYOUT,
        export_sha256: "a".repeat(64),
        layout_exported_at: expect.any(String),
      }),
    );
    expect(fakes.remove).not.toHaveBeenCalled();
  });

  it("deletes the uploaded object when the template row update fails", async () => {
    const fakes = fakeClient({ updated: null, updateError: { code: "DB_FAIL" } });
    const adapter = createEsignTemplateSnapshotDatabaseAdapter(fakes.client);

    await expect(
      adapter.storeTemplateSnapshot({
        orgId: ORG_ID,
        templateId: TEMPLATE_ID,
        pdf: PDF,
        sha256: "b".repeat(64),
        layout: LAYOUT,
      }),
    ).rejects.toMatchObject({
      code: "UPDATE_FAILED",
      message: "The eSign template snapshot operation failed.",
    });
    expect(fakes.remove).toHaveBeenCalledWith([fakes.upload.mock.calls[0][0]]);
  });

  it("reports cleanup failure without leaking storage or database error text", async () => {
    const fakes = fakeClient({
      updated: null,
      updateError: { code: "SECRET_DATABASE_DETAIL" },
      removeError: { code: "SECRET_STORAGE_DETAIL" },
    });
    const adapter = createEsignTemplateSnapshotDatabaseAdapter(fakes.client);

    let caught: unknown;
    try {
      await adapter.storeTemplateSnapshot({
        orgId: ORG_ID,
        templateId: TEMPLATE_ID,
        pdf: PDF,
        sha256: "c".repeat(64),
        layout: LAYOUT,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EsignTemplateSnapshotError);
    expect(caught).toMatchObject({ code: "UPDATE_AND_CLEANUP_FAILED" });
    expect(JSON.stringify(caught)).not.toMatch(/SECRET_/);
  });
});
