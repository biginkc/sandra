import { describe, expect, it, vi } from "vitest";

import { runInitialProviderCreate, type InitialProviderCreatePorts } from "./initial-template-provider-create";

const input = { orgId: "org-1", templateId: "template-1", sourceId: "source-1", actorId: "owner-1" };

function ports(): InitialProviderCreatePorts {
  return {
    claim: vi.fn().mockResolvedValue({ outcome: "claimed", templateId: input.templateId, providerCreateState: "claimed", claimToken: "claim-1", providerTemplateId: null, providerAccountId: "account-1", createdBy: input.actorId }),
    begin: vi.fn().mockResolvedValue({ outcome: "started", templateId: input.templateId, providerCreateState: "invoking", createdBy: input.actorId }),
    release: vi.fn().mockResolvedValue({ outcome: "released", templateId: input.templateId, createdBy: input.actorId }),
    markUnknown: vi.fn().mockResolvedValue({ outcome: "recorded_unknown", templateId: input.templateId, createdBy: input.actorId }),
    complete: vi.fn().mockResolvedValue({ outcome: "attached", templateId: input.templateId, providerTemplateId: "provider-1", createdBy: input.actorId }),
    provider: { loadAccountIdentity: vi.fn().mockResolvedValue({ providerAccountId: "account-1" }), invoke: vi.fn().mockResolvedValue({ providerTemplateId: "provider-1" }) },
  };
}

describe("initial template provider-create CAS", () => {
  it("allows only a fresh claim to begin and invoke Dropbox once", async () => {
    const p = ports();
    await expect(runInitialProviderCreate(input, p)).resolves.toEqual({ ok: true, data: { templateId: "template-1", providerTemplateId: "provider-1" } });
    expect(p.provider.loadAccountIdentity).toHaveBeenCalledTimes(1);
    expect(p.begin).toHaveBeenCalledWith({ ...input, claimToken: "claim-1" });
    expect(p.provider.invoke).toHaveBeenCalledTimes(1);
    expect(p.complete).toHaveBeenCalledWith({ ...input, claimToken: "claim-1", providerTemplateId: "provider-1", providerAccountId: "account-1" });
  });

  it("allows a replacement current org owner to continue the immutable draft while preserving creator provenance", async () => {
    const p = ports();
    const replacementInput = { ...input, actorId: "replacement-owner" };
    vi.mocked(p.claim).mockResolvedValue({
      outcome: "claimed",
      templateId: input.templateId,
      providerCreateState: "claimed",
      claimToken: "claim-replacement",
      providerTemplateId: null,
      providerAccountId: "account-1",
      createdBy: "original-owner",
    });

    await expect(runInitialProviderCreate(replacementInput, p)).resolves.toEqual({
      ok: true,
      data: { templateId: "template-1", providerTemplateId: "provider-1" },
    });
    expect(p.begin).toHaveBeenCalledWith({ ...replacementInput, claimToken: "claim-replacement" });
    expect(p.complete).toHaveBeenCalledWith({
      ...replacementInput,
      claimToken: "claim-replacement",
      providerTemplateId: "provider-1",
      providerAccountId: "account-1",
    });
  });

  it("never invokes for concurrent/replayed already-in-progress claims", async () => {
    const p = ports();
    vi.mocked(p.claim).mockResolvedValue({ outcome: "already_in_progress", templateId: input.templateId, providerCreateState: "invoking", claimToken: null, providerTemplateId: null, providerAccountId: "account-1", createdBy: input.actorId });
    await expect(runInitialProviderCreate(input, p)).resolves.toMatchObject({ ok: false, error: { code: "PROVIDER_CREATE_IN_PROGRESS" } });
    expect(p.provider.loadAccountIdentity).not.toHaveBeenCalled();
    expect(p.begin).not.toHaveBeenCalled();
    expect(p.provider.invoke).not.toHaveBeenCalled();
  });

  it("reconciles an already-attached replay without constructing or invoking Dropbox", async () => {
    const p = ports();
    vi.mocked(p.claim).mockResolvedValue({ outcome: "already_attached", templateId: input.templateId, providerCreateState: "attached", claimToken: null, providerTemplateId: "provider-1", providerAccountId: "account-1", createdBy: "former-owner" });
    await expect(runInitialProviderCreate({ ...input, actorId: "replacement-owner" }, p)).resolves.toEqual({ ok: true, data: { templateId: "template-1", providerTemplateId: "provider-1" } });
    expect(p.provider.loadAccountIdentity).not.toHaveBeenCalled();
    expect(p.provider.invoke).not.toHaveBeenCalled();
  });

  it("releases the exact token on a safe credential failure before begin", async () => {
    const p = ports();
    vi.mocked(p.provider.loadAccountIdentity).mockRejectedValue(new Error("disconnected"));
    await expect(runInitialProviderCreate(input, p)).resolves.toMatchObject({ ok: false, error: { code: "PROVIDER_CONFIGURATION_FAILED" } });
    expect(p.release).toHaveBeenCalledWith({ ...input, claimToken: "claim-1" });
    expect(p.begin).not.toHaveBeenCalled();
    expect(p.provider.invoke).not.toHaveBeenCalled();
  });

  it("releases a still-claimed token and never calls Dropbox when reconnect changes the account before begin", async () => {
    const p = ports();
    vi.mocked(p.provider.loadAccountIdentity).mockResolvedValue({ providerAccountId: "account-2" });
    await expect(runInitialProviderCreate(input, p)).resolves.toMatchObject({
      ok: false,
      error: { code: "PROVIDER_ACCOUNT_MISMATCH" },
    });
    expect(p.release).toHaveBeenCalledWith({ ...input, claimToken: "claim-1" });
    expect(p.begin).not.toHaveBeenCalled();
    expect(p.provider.invoke).not.toHaveBeenCalled();
    expect(p.complete).not.toHaveBeenCalled();
  });

  it("completes a begun invocation against the immutable claimed account snapshot", async () => {
    const p = ports();
    await expect(runInitialProviderCreate(input, p)).resolves.toMatchObject({ ok: true });
    expect(p.begin).toHaveBeenCalledBefore(vi.mocked(p.provider.invoke));
    expect(p.complete).toHaveBeenCalledWith(expect.objectContaining({
      providerAccountId: "account-1",
      providerTemplateId: "provider-1",
      claimToken: "claim-1",
    }));
    expect(p.release).not.toHaveBeenCalled();
  });

  it("does not invoke when begin is an already-started replay", async () => {
    const p = ports();
    vi.mocked(p.begin).mockResolvedValue({ outcome: "already_started", templateId: input.templateId, providerCreateState: "invoking", createdBy: input.actorId });
    await expect(runInitialProviderCreate(input, p)).resolves.toMatchObject({ ok: false, error: { code: "PROVIDER_CREATE_IN_PROGRESS" } });
    expect(p.provider.invoke).not.toHaveBeenCalled();
    expect(p.release).not.toHaveBeenCalled();
  });

  it("uses only an exact-expiry reclaimed token and never the stale claim token", async () => {
    const p = ports();
    vi.mocked(p.claim).mockResolvedValue({
      outcome: "claimed",
      templateId: input.templateId,
      providerCreateState: "claimed",
      claimToken: "claim-reclaimed",
      providerTemplateId: null,
      providerAccountId: "account-1",
      createdBy: "original-owner",
    });
    await expect(runInitialProviderCreate({ ...input, actorId: "replacement-owner" }, p)).resolves.toMatchObject({ ok: true });
    expect(p.begin).toHaveBeenCalledWith(expect.objectContaining({ claimToken: "claim-reclaimed" }));
    expect(p.complete).toHaveBeenCalledWith(expect.objectContaining({ claimToken: "claim-reclaimed" }));
    expect(p.begin).not.toHaveBeenCalledWith(expect.objectContaining({ claimToken: "claim-1" }));
  });

  it("fails a stale token at begin without constructing or invoking Dropbox", async () => {
    const p = ports();
    vi.mocked(p.begin).mockRejectedValue(new Error("stale claim token"));
    await expect(runInitialProviderCreate(input, p)).resolves.toMatchObject({
      ok: false,
      error: { code: "PROVIDER_CREATE_BEGIN_FAILED" },
    });
    expect(p.provider.invoke).not.toHaveBeenCalled();
    expect(p.complete).not.toHaveBeenCalled();
    expect(p.release).not.toHaveBeenCalled();
  });

  it("marks unknown after invocation ambiguity and never deletes or retries provider", async () => {
    const p = ports();
    vi.mocked(p.provider.invoke).mockRejectedValue(new Error("response lost"));
    await expect(runInitialProviderCreate(input, p)).resolves.toMatchObject({ ok: false, error: { code: "PROVIDER_CREATE_UNKNOWN" } });
    expect(p.provider.invoke).toHaveBeenCalledTimes(1);
    expect(p.markUnknown).toHaveBeenCalledWith({ ...input, claimToken: "claim-1", errorCode: "PROVIDER_RESPONSE_UNKNOWN" });
    expect(p.release).not.toHaveBeenCalled();
  });

  it("marks unknown when provider returns no stable ID", async () => {
    const p = ports();
    vi.mocked(p.provider.invoke).mockResolvedValue({ providerTemplateId: "" });
    await expect(runInitialProviderCreate(input, p)).resolves.toMatchObject({ ok: false, error: { code: "PROVIDER_CREATE_UNKNOWN" } });
    expect(p.markUnknown).toHaveBeenCalledWith({ ...input, claimToken: "claim-1", errorCode: "PROVIDER_ID_MISSING" });
    expect(p.complete).not.toHaveBeenCalled();
  });

  it("converges when attach committed but its response was lost", async () => {
    const p = ports();
    vi.mocked(p.complete).mockRejectedValue(new Error("response lost after commit"));
    vi.mocked(p.markUnknown).mockResolvedValue({
      outcome: "already_attached",
      templateId: input.templateId,
      createdBy: input.actorId,
    });
    vi.mocked(p.claim)
      .mockResolvedValueOnce({ outcome: "claimed", templateId: input.templateId, providerCreateState: "claimed", claimToken: "claim-1", providerTemplateId: null, providerAccountId: "account-1", createdBy: input.actorId })
      .mockResolvedValueOnce({ outcome: "already_attached", templateId: input.templateId, providerCreateState: "attached", claimToken: null, providerTemplateId: "provider-1", providerAccountId: "account-1", createdBy: input.actorId });

    await expect(runInitialProviderCreate(input, p)).resolves.toEqual({
      ok: true,
      data: { templateId: "template-1", providerTemplateId: "provider-1" },
    });
    expect(p.provider.invoke).toHaveBeenCalledTimes(1);
    expect(p.claim).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a committed-loss replay reports a conflicting provider ID", async () => {
    const p = ports();
    vi.mocked(p.complete).mockRejectedValue(new Error("response lost after commit"));
    vi.mocked(p.markUnknown).mockResolvedValue({ outcome: "already_attached", templateId: input.templateId, createdBy: input.actorId });
    vi.mocked(p.claim)
      .mockResolvedValueOnce({ outcome: "claimed", templateId: input.templateId, providerCreateState: "claimed", claimToken: "claim-1", providerTemplateId: null, providerAccountId: "account-1", createdBy: input.actorId })
      .mockResolvedValueOnce({ outcome: "already_attached", templateId: input.templateId, providerCreateState: "attached", claimToken: null, providerTemplateId: "provider-conflict", providerAccountId: "account-1", createdBy: input.actorId });
    await expect(runInitialProviderCreate(input, p)).resolves.toMatchObject({ ok: false, error: { code: "PROVIDER_CREATE_COMPLETE_MISMATCH" } });
    expect(p.provider.invoke).toHaveBeenCalledTimes(1);
  });
});
