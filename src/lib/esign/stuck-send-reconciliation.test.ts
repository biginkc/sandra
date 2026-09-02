import { describe, expect, it, vi } from "vitest";

import { reconcileStuckEsignSends } from "./stuck-send-reconciliation";

describe("stuck eSign send reconciliation", () => {
  it("marks a stale send failed only after a complete zero-result provider lookup", async () => {
    const markOutcome = vi.fn().mockResolvedValue(undefined);
    const listCandidates = vi.fn().mockResolvedValue([
      { id: "request-zero", orgId: "org-1" },
      { id: "request-found", orgId: "org-1" },
      { id: "request-incomplete", orgId: "org-1" },
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
    ).resolves.toEqual({ checked: 3, failed: 1, unknown: 1, deferred: 1 });
    expect(listCandidates).toHaveBeenCalledWith({
      staleBefore: new Date("2026-09-02T00:15:00.000Z"),
      limit: 10,
    });
    expect(markOutcome).toHaveBeenNthCalledWith(1, {
      id: "request-zero",
      orgId: "org-1",
      deliveryState: "failed",
      safeErrorMessage: "STALE_NO_PROVIDER_REQUEST",
    });
    expect(markOutcome).toHaveBeenNthCalledWith(2, {
      id: "request-found",
      orgId: "org-1",
      deliveryState: "send_unknown",
      safeErrorMessage: null,
    });
  });
});
