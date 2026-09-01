import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "@/lib/errors/classes";

const mocks = vi.hoisted(() => ({
  memberships: vi.fn(),
  credentials: vi.fn(),
  providerFactory: vi.fn(),
  rpc: vi.fn(),
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
