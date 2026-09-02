import { describe, expect, it, vi } from "vitest";

import {
  ESIGN_UNKNOWN_SEND_RESOLUTION_MIN_AGE_MS,
  lookupAfterVerifiedProviderProbe,
  reconcileStuckEsignSends,
  type StuckEsignSend,
} from "./stuck-send-reconciliation";

function candidate(
  overrides: Partial<StuckEsignSend> = {},
): StuckEsignSend {
  return {
    id: "request-1",
    orgId: "org-1",
    propertyId: "property-1",
    testMode: true,
    deliveryState: "sending",
    updatedAt: new Date("2026-09-02T00:00:00.000Z"),
    ...overrides,
  };
}

describe("stuck eSign send reconciliation", () => {
  it("fences zero-result sends as unknown and repairs provider-found sends", async () => {
    const markOutcome = vi.fn().mockResolvedValue("updated");
    const listCandidates = vi.fn().mockResolvedValue([
      candidate({ id: "request-zero" }),
      candidate({ id: "request-found" }),
      candidate({ id: "request-incomplete" }),
    ]);
    const recordZeroResult = vi.fn().mockResolvedValue({
      consecutiveCompleteZeroCount: 1,
      firstObservedAt: new Date("2026-09-02T00:30:00.000Z"),
    });
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
        {
          listCandidates,
          lookupProviderRequest,
          markOutcome,
          recordZeroResult,
        },
        new Date("2026-09-02T00:30:00.000Z"),
      ),
    ).resolves.toEqual({
      checked: 3,
      sent: 1,
      failed: 0,
      unknown: 1,
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
      propertyId: "property-1",
      testMode: true,
      updatedAt: new Date("2026-09-02T00:00:00.000Z"),
      deliveryState: "send_unknown",
      safeErrorMessage: null,
    });
    expect(markOutcome).toHaveBeenNthCalledWith(2, {
      id: "request-found",
      orgId: "org-1",
      propertyId: "property-1",
      testMode: true,
      updatedAt: new Date("2026-09-02T00:00:00.000Z"),
      deliveryState: "sent",
      providerRequestId: "provider-1",
      resolutionSource: "automatic",
      evidence: expect.objectContaining({
        providerRequestId: "provider-1",
        positiveControl: "passed",
      }),
    });
  });

  it("keeps a Dropbox index-lag zero lookup non-retryable before a later present lookup repairs it", async () => {
    const lagged = candidate({ id: "lagged-request", deliveryState: "send_unknown" });
    const markOutcome = vi.fn().mockResolvedValue("updated");
    const ports = {
      listCandidates: vi.fn().mockResolvedValue([lagged]),
      lookupProviderRequest: vi
        .fn()
        .mockResolvedValueOnce({ complete: true, providerRequestIds: [] })
        .mockResolvedValueOnce({
          complete: true,
          providerRequestIds: ["provider-after-index"],
        }),
      markOutcome,
      recordZeroResult: vi.fn().mockResolvedValue({
        consecutiveCompleteZeroCount: 1,
        firstObservedAt: new Date("2026-09-02T00:30:00.000Z"),
      }),
    };

    await expect(
      reconcileStuckEsignSends(ports, new Date("2026-09-02T00:30:00.000Z")),
    ).resolves.toMatchObject({ failed: 0, unknown: 0, deferred: 1 });
    await expect(
      reconcileStuckEsignSends(ports, new Date("2026-09-02T00:45:00.000Z")),
    ).resolves.toMatchObject({ failed: 0, sent: 1, unknown: 0 });
    expect(markOutcome).toHaveBeenCalledTimes(1);
    expect(markOutcome).toHaveBeenNthCalledWith(1, {
      ...lagged,
      deliveryState: "sent",
      providerRequestId: "provider-after-index",
      resolutionSource: "automatic",
      evidence: expect.objectContaining({
        providerRequestId: "provider-after-index",
      }),
    });
  });

  it("marks a genuinely lost send failed after repeated complete zeros with controls over the resolution window", async () => {
    const unknown = candidate({
      id: "lost-request",
      deliveryState: "send_unknown",
      updatedAt: new Date("2026-09-02T00:00:00.000Z"),
    });
    const observedAt = new Date(
      unknown.updatedAt.getTime() + ESIGN_UNKNOWN_SEND_RESOLUTION_MIN_AGE_MS,
    );
    const markOutcome = vi.fn().mockResolvedValue("updated");

    await expect(reconcileStuckEsignSends({
      listCandidates: vi.fn().mockResolvedValue([unknown]),
      lookupProviderRequest: vi.fn().mockResolvedValue({
        complete: true,
        providerRequestIds: [],
      }),
      recordZeroResult: vi.fn().mockResolvedValue({
        consecutiveCompleteZeroCount: 3,
        firstObservedAt: unknown.updatedAt,
      }),
      markOutcome,
    }, observedAt)).resolves.toMatchObject({
      checked: 1,
      sent: 0,
      failed: 1,
      unknown: 0,
    });

    expect(markOutcome).toHaveBeenCalledWith({
      ...unknown,
      deliveryState: "failed",
      safeErrorMessage: "PROVIDER_SEND_NOT_FOUND",
      resolutionSource: "automatic",
      evidence: expect.objectContaining({
        zeroObservationThreshold: 3,
        consecutiveCompleteZeroCount: 3,
        minimumUnknownAgeMs: ESIGN_UNKNOWN_SEND_RESOLUTION_MIN_AGE_MS,
        positiveControl: "passed",
      }),
    });
  });

  it("reports lookup exceptions separately from index deferrals", async () => {
    const lookupError = new Error("provider search unavailable");
    const reportLookupError = vi.fn();
    const candidates = [
      candidate({ id: "throws" }),
      candidate({ id: "incomplete" }),
    ];

    await expect(reconcileStuckEsignSends({
      listCandidates: vi.fn().mockResolvedValue(candidates),
      lookupProviderRequest: vi.fn()
        .mockRejectedValueOnce(lookupError)
        .mockResolvedValueOnce({ complete: false, providerRequestIds: [] }),
      markOutcome: vi.fn(),
      recordZeroResult: vi.fn(),
      reportLookupError,
    })).resolves.toEqual({
      checked: 2,
      sent: 0,
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
      candidate({ id: "raced" }),
      candidate({ id: "not-started" }),
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
      recordZeroResult: vi.fn(),
      shouldContinue,
    })).resolves.toEqual({
      checked: 1,
      sent: 0,
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
      candidate({ id: "write-error" }),
      candidate({ id: "continues" }),
    ];

    await expect(reconcileStuckEsignSends({
      listCandidates: vi.fn().mockResolvedValue(candidates),
      lookupProviderRequest: vi.fn().mockResolvedValue({
        complete: true,
        providerRequestIds: [],
      }),
      markOutcome,
      recordZeroResult: vi.fn().mockResolvedValue({
        consecutiveCompleteZeroCount: 1,
        firstObservedAt: new Date("2026-09-02T00:30:00.000Z"),
      }),
      reportOutcomeError,
    })).resolves.toEqual({
      checked: 2,
      sent: 0,
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
    const stuck = candidate({ id: "stuck-request", testMode: false });
    const find = vi.fn()
      .mockResolvedValueOnce({ complete: true, providerRequestIds: [] });

    await expect(lookupAfterVerifiedProviderProbe({
      candidate: stuck,
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
    const stuck = candidate({ id: "stuck-request", testMode: true });
    const find = vi.fn()
      .mockResolvedValueOnce({
        complete: true,
        providerRequestIds: ["known-provider-request"],
      })
      .mockResolvedValueOnce({ complete: true, providerRequestIds: [] });

    await expect(lookupAfterVerifiedProviderProbe({
      candidate: stuck,
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
