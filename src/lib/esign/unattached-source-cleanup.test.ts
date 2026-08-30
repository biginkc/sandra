import { describe, expect, it, vi } from "vitest";

import { cleanupUnattachedSource, type UnattachedSourceCleanupPorts } from "./unattached-source-cleanup";

const input = { orgId: "org-1", sourceId: "source-1", storagePath: "org-1/source-1.pdf", actorId: "owner-2" };

function ports(): UnattachedSourceCleanupPorts {
  return {
    claim: vi.fn().mockResolvedValue({ outcome: "claimed", sourceId: input.sourceId, cleanupToken: "cleanup-1", createdBy: "former-owner" }),
    deletePrivate: vi.fn().mockResolvedValue("deleted"),
    complete: vi.fn().mockResolvedValue({ outcome: "deleted", sourceId: input.sourceId, createdBy: "former-owner" }),
  };
}

describe("unattached source cleanup CAS", () => {
  it("claims under row lock before deleting and completes with the exact token", async () => {
    const p = ports();
    const order: string[] = [];
    vi.mocked(p.claim).mockImplementation(async () => { order.push("claim"); return { outcome: "claimed", sourceId: input.sourceId, cleanupToken: "cleanup-1", createdBy: "former-owner" }; });
    vi.mocked(p.deletePrivate).mockImplementation(async () => { order.push("delete"); return "deleted"; });
    vi.mocked(p.complete).mockImplementation(async () => { order.push("complete"); return { outcome: "deleted", sourceId: input.sourceId, createdBy: "former-owner" }; });
    await expect(cleanupUnattachedSource(input, p)).resolves.toEqual({ ok: true, data: null });
    expect(order).toEqual(["claim", "delete", "complete"]);
    expect(p.complete).toHaveBeenCalledWith({ ...input, cleanupToken: "cleanup-1", outcome: "deleted", errorCode: null });
  });

  it("never deletes for already-in-progress, cross-org, attached, or rejected claims", async () => {
    const p = ports();
    vi.mocked(p.claim).mockResolvedValue({ outcome: "already_in_progress", sourceId: input.sourceId, cleanupToken: null, createdBy: "former-owner" });
    await expect(cleanupUnattachedSource(input, p)).resolves.toMatchObject({ ok: false, error: { code: "SOURCE_CLEANUP_IN_PROGRESS" } });
    expect(p.deletePrivate).not.toHaveBeenCalled();

    vi.mocked(p.claim).mockRejectedValue(new Error("cross-org or attached"));
    await expect(cleanupUnattachedSource(input, p)).resolves.toMatchObject({ ok: false, error: { code: "SOURCE_CLEANUP_CLAIM_FAILED" } });
    expect(p.deletePrivate).not.toHaveBeenCalled();
  });

  it("keeps a pre-expiry cleanup lease single-owner and permits an exact-expiry reclaim with a fresh token", async () => {
    const p = ports();
    vi.mocked(p.claim)
      .mockResolvedValueOnce({ outcome: "already_in_progress", sourceId: input.sourceId, cleanupToken: null, createdBy: "original-owner" })
      .mockResolvedValueOnce({ outcome: "claimed", sourceId: input.sourceId, cleanupToken: "cleanup-reclaimed", createdBy: "original-owner" });

    await expect(cleanupUnattachedSource({ ...input, actorId: "replacement-owner" }, p)).resolves.toMatchObject({
      ok: false,
      error: { code: "SOURCE_CLEANUP_IN_PROGRESS" },
    });
    expect(p.deletePrivate).not.toHaveBeenCalled();
    expect(p.complete).not.toHaveBeenCalled();

    await expect(cleanupUnattachedSource({ ...input, actorId: "replacement-owner" }, p)).resolves.toEqual({ ok: true, data: null });
    expect(p.deletePrivate).toHaveBeenCalledTimes(1);
    expect(p.complete).toHaveBeenCalledWith({
      ...input,
      actorId: "replacement-owner",
      cleanupToken: "cleanup-reclaimed",
      outcome: "deleted",
      errorCode: null,
    });
    expect(p.complete).not.toHaveBeenCalledWith(expect.objectContaining({ cleanupToken: "cleanup-1" }));
  });

  it("converges an already-deleted replay without deleting again", async () => {
    const p = ports();
    vi.mocked(p.claim).mockResolvedValue({ outcome: "already_deleted", sourceId: input.sourceId, cleanupToken: null, createdBy: "former-owner" });
    await expect(cleanupUnattachedSource(input, p)).resolves.toEqual({ ok: true, data: null });
    expect(p.deletePrivate).not.toHaveBeenCalled();
    expect(p.complete).not.toHaveBeenCalled();
  });

  it("accepts already-absent Storage and records deleted", async () => {
    const p = ports();
    vi.mocked(p.deletePrivate).mockResolvedValue("already_absent");
    await expect(cleanupUnattachedSource(input, p)).resolves.toEqual({ ok: true, data: null });
    expect(p.complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: "deleted", cleanupToken: "cleanup-1" }));
  });

  it("replays only the completion after a lost deleted response", async () => {
    const p = ports();
    vi.mocked(p.complete)
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({ outcome: "already_deleted", sourceId: input.sourceId, createdBy: "former-owner" });
    await expect(cleanupUnattachedSource(input, p)).resolves.toEqual({ ok: true, data: null });
    expect(p.deletePrivate).toHaveBeenCalledTimes(1);
    expect(p.complete).toHaveBeenCalledTimes(2);
  });

  it("records bounded failed cleanup and allows a later owner retry through a fresh claim", async () => {
    const p = ports();
    vi.mocked(p.deletePrivate).mockRejectedValueOnce(new Error("private storage detail"));
    await expect(cleanupUnattachedSource(input, p)).resolves.toMatchObject({ ok: false, error: { code: "SOURCE_CLEANUP_FAILED" } });
    expect(p.complete).toHaveBeenCalledWith({ ...input, cleanupToken: "cleanup-1", outcome: "failed", errorCode: "STORAGE_DELETE_FAILED" });

    vi.mocked(p.claim).mockResolvedValue({ outcome: "claimed", sourceId: input.sourceId, cleanupToken: "cleanup-2", createdBy: "former-owner" });
    vi.mocked(p.deletePrivate).mockResolvedValue("already_absent");
    vi.mocked(p.complete).mockResolvedValue({ outcome: "deleted", sourceId: input.sourceId, createdBy: "former-owner" });
    await expect(cleanupUnattachedSource({ ...input, actorId: "replacement-owner" }, p)).resolves.toEqual({ ok: true, data: null });
    expect(p.complete).toHaveBeenLastCalledWith(expect.objectContaining({ actorId: "replacement-owner", cleanupToken: "cleanup-2", outcome: "deleted" }));
  });
});
