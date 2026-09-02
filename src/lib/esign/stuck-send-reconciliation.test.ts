import { describe, expect, it, vi } from "vitest";

import {
  lookupAfterVerifiedProviderProbe,
  reconcileStuckEsignSends,
} from "./stuck-send-reconciliation";

describe("stuck eSign send reconciliation", () => {
  it("marks every complete provider lookup send_unknown, including zero-result Dropbox search lag", async () => {
    const markOutcome = vi.fn().mockResolvedValue("updated");
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
    ).resolves.toEqual({
      checked: 3,
      failed: 0,
      unknown: 2,
      deferred: 1,
      lookupErrors: 0,
      raced: 0,
      errors: 0,
    });
    expect(listCandidates).toHaveBeenCalledWith({
      staleBefore: new Date("2026-09-02T00:15:00.000Z"),
      limit: 10,
    });
    expect(markOutcome).toHaveBeenNthCalledWith(1, {
      id: "request-zero",
      orgId: "org-1",
      testMode: true,
      deliveryState: "send_unknown",
      safeErrorMessage: null,
    });
    expect(markOutcome).toHaveBeenNthCalledWith(2, {
      id: "request-found",
      orgId: "org-1",
      testMode: true,
      deliveryState: "send_unknown",
      safeErrorMessage: null,
    });
  });

  it("keeps a Dropbox index-lag zero lookup non-retryable before a later present lookup", async () => {
    const candidate = { id: "lagged-request", orgId: "org-1", testMode: true };
    const markOutcome = vi.fn().mockResolvedValue("updated");
    const ports = {
      listCandidates: vi.fn().mockResolvedValue([candidate]),
      lookupProviderRequest: vi
        .fn()
        .mockResolvedValueOnce({ complete: true, providerRequestIds: [] })
        .mockResolvedValueOnce({
          complete: true,
          providerRequestIds: ["provider-after-index"],
        }),
      markOutcome,
    };

    await expect(
      reconcileStuckEsignSends(ports, new Date("2026-09-02T00:30:00.000Z")),
    ).resolves.toMatchObject({ failed: 0, unknown: 1 });
    await expect(
      reconcileStuckEsignSends(ports, new Date("2026-09-02T00:45:00.000Z")),
    ).resolves.toMatchObject({ failed: 0, unknown: 1 });
    expect(markOutcome).toHaveBeenCalledTimes(2);
    expect(markOutcome).toHaveBeenNthCalledWith(1, {
      ...candidate,
      deliveryState: "send_unknown",
      safeErrorMessage: null,
    });
    expect(markOutcome).toHaveBeenNthCalledWith(2, {
      ...candidate,
      deliveryState: "send_unknown",
      safeErrorMessage: null,
    });
  });

  it("reports lookup exceptions separately from index deferrals", async () => {
    const lookupError = new Error("provider search unavailable");
    const reportLookupError = vi.fn();
    const candidates = [
      { id: "throws", orgId: "org-1", testMode: true },
      { id: "incomplete", orgId: "org-1", testMode: true },
    ];

    await expect(reconcileStuckEsignSends({
      listCandidates: vi.fn().mockResolvedValue(candidates),
      lookupProviderRequest: vi.fn()
        .mockRejectedValueOnce(lookupError)
        .mockResolvedValueOnce({ complete: false, providerRequestIds: [] }),
      markOutcome: vi.fn(),
      reportLookupError,
    })).resolves.toEqual({
      checked: 2,
      failed: 0,
      unknown: 0,
      deferred: 1,
      lookupErrors: 1,
      raced: 0,
      errors: 0,
    });
    expect(reportLookupError).toHaveBeenCalledWith(lookupError, candidates[0]);
  });

  it("isolates outcome races and stops at the cron deadline", async () => {
    const candidates = [
      { id: "raced", orgId: "org-1", testMode: true },
      { id: "not-started", orgId: "org-1", testMode: true },
    ];
    const shouldContinue = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const markOutcome = vi.fn().mockResolvedValue("raced");

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
      lookupErrors: 0,
      raced: 1,
      errors: 0,
    });
  });

  it("reports a genuine outcome write error and continues the batch", async () => {
    const reportOutcomeError = vi.fn();
    const writeError = new Error("database unavailable");
    const markOutcome = vi.fn()
      .mockRejectedValueOnce(writeError)
      .mockResolvedValueOnce("updated");
    const candidates = [
      { id: "write-error", orgId: "org-1", testMode: true },
      { id: "continues", orgId: "org-1", testMode: true },
    ];

    await expect(reconcileStuckEsignSends({
      listCandidates: vi.fn().mockResolvedValue(candidates),
      lookupProviderRequest: vi.fn().mockResolvedValue({
        complete: true,
        providerRequestIds: [],
      }),
      markOutcome,
      reportOutcomeError,
    })).resolves.toEqual({
      checked: 2,
      failed: 0,
      unknown: 1,
      deferred: 0,
      lookupErrors: 0,
      raced: 0,
      errors: 1,
    });
    expect(reportOutcomeError).toHaveBeenCalledWith(writeError, candidates[0]);
    expect(markOutcome).toHaveBeenCalledTimes(2);
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
