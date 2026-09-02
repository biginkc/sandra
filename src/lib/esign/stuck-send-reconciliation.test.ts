import { describe, expect, it, vi } from "vitest";

import {
  lookupAfterVerifiedProviderProbe,
  reconcileStuckEsignSends,
} from "./stuck-send-reconciliation";

describe("stuck eSign send reconciliation", () => {
  it("marks a stale send failed only after a complete zero-result provider lookup", async () => {
    const markOutcome = vi.fn().mockResolvedValue(undefined);
    const listCandidates = vi.fn().mockResolvedValue([
      { id: "request-zero", orgId: "org-1", testMode: true },
      { id: "request-found", orgId: "org-1", testMode: true },
      { id: "request-incomplete", orgId: "org-1", testMode: true },
    ]);
    const lookupProviderRequest = vi
      .fn()
      .mockResolvedValueOnce({ complete: true, providerRequestIds: [] })
      .mockResolvedValueOnce({
        complete: true,
        providerRequestIds: ["provider-1"],
      })
      .mockResolvedValueOnce({ complete: false, providerRequestIds: [] });

    await expect(
      reconcileStuckEsignSends(
        { listCandidates, lookupProviderRequest, markOutcome },
        new Date("2026-09-02T00:30:00.000Z"),
      ),
    ).resolves.toEqual({ checked: 3, failed: 1, unknown: 1, deferred: 1, raced: 0 });
    expect(listCandidates).toHaveBeenCalledWith({
      staleBefore: new Date("2026-09-02T00:15:00.000Z"),
      limit: 10,
    });
    expect(markOutcome).toHaveBeenNthCalledWith(1, {
      id: "request-zero",
      orgId: "org-1",
      testMode: true,
      deliveryState: "failed",
      safeErrorMessage: "STALE_NO_PROVIDER_REQUEST",
    });
    expect(markOutcome).toHaveBeenNthCalledWith(2, {
      id: "request-found",
      orgId: "org-1",
      testMode: true,
      deliveryState: "send_unknown",
      safeErrorMessage: null,
    });
  });

  it("isolates outcome races and stops at the cron deadline", async () => {
    const candidates = [
      { id: "raced", orgId: "org-1", testMode: true },
      { id: "not-started", orgId: "org-1", testMode: true },
    ];
    const shouldContinue = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const markOutcome = vi.fn().mockRejectedValue(new Error("state changed"));

    await expect(reconcileStuckEsignSends({
      listCandidates: vi.fn().mockResolvedValue(candidates),
      lookupProviderRequest: vi.fn().mockResolvedValue({
        complete: true,
        providerRequestIds: ["provider-1"],
      }),
      markOutcome,
      shouldContinue,
    })).resolves.toEqual({
      checked: 1,
      failed: 0,
      unknown: 0,
      deferred: 0,
      raced: 1,
    });
  });

  it("requires a known provider request to prove the zero-result query works", async () => {
    const candidate = { id: "stuck-request", orgId: "org-1", testMode: false };
    const find = vi.fn()
      .mockResolvedValueOnce({ complete: true, providerRequestIds: [] });

    await expect(lookupAfterVerifiedProviderProbe({
      candidate,
      reference: {
        localRequestId: "known-local-request",
        providerRequestId: "known-provider-request",
      },
      find,
    })).resolves.toEqual({ complete: false, providerRequestIds: [] });
    expect(find).toHaveBeenCalledOnce();
    expect(find).toHaveBeenCalledWith("known-local-request", false);
  });

  it("queries the stranded request only after the control probe matches", async () => {
    const candidate = { id: "stuck-request", orgId: "org-1", testMode: true };
    const find = vi.fn()
      .mockResolvedValueOnce({
        complete: true,
        providerRequestIds: ["known-provider-request"],
      })
      .mockResolvedValueOnce({ complete: true, providerRequestIds: [] });

    await expect(lookupAfterVerifiedProviderProbe({
      candidate,
      reference: {
        localRequestId: "known-local-request",
        providerRequestId: "known-provider-request",
      },
      find,
    })).resolves.toEqual({ complete: true, providerRequestIds: [] });
    expect(find).toHaveBeenNthCalledWith(1, "known-local-request", true);
    expect(find).toHaveBeenNthCalledWith(2, "stuck-request", true);
  });
});
