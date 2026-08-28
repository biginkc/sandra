import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CoachCallContext } from "./types";

const { loadCoachCallContext } = vi.hoisted(() => ({ loadCoachCallContext: vi.fn() }));

vi.mock("./coach-context-actions", () => ({ loadCoachCallContext }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getSession: () => Promise.resolve({ data: { session: null } }) },
    realtime: { setAuth: vi.fn() },
    channel: () => ({
      on() {
        return this;
      },
      subscribe() {
        return this;
      },
    }),
    removeChannel: vi.fn(),
  }),
}));

import { useCoachSession } from "./use-coach-session";

const sampleContext: CoachCallContext = {
  sellerName: "Jane",
  propertyAddress: "1 Main St",
  propertyCounty: "Jackson",
  repName: "Alex",
  repPhoneE164: "+18165551234",
  motivation: null,
  leadId: "lead-1",
  sellerPhoneE164: "+18165559876",
  coldCallerName: null,
  yearBuilt: null,
  leadSource: null,
  occupancy: null,
};

describe("useCoachSession", () => {
  beforeEach(() => {
    loadCoachCallContext.mockReset().mockResolvedValue(sampleContext);
  });

  it("loads context once and exposes it as ready", async () => {
    const { result } = renderHook(() => useCoachSession("call-1", "lead-1", "+18165559876", "+18165551234"));
    expect(result.current.contextLoad.status).toBe("loading");
    await waitFor(() => expect(result.current.contextLoad.status).toBe("ready"));
    expect(loadCoachCallContext).toHaveBeenCalledWith({
      propertyId: "lead-1",
      sellerPhoneE164: "+18165559876",
      repPhoneE164: "+18165551234",
    });
  });

  it("fills missing seller and address tokens from the already-prepared call target", async () => {
    loadCoachCallContext.mockResolvedValue({
      ...sampleContext,
      sellerName: null,
      propertyAddress: null,
    });
    const { result } = renderHook(() =>
      useCoachSession(
        "call-1",
        "lead-1",
        "+18165559876",
        "+18165551234",
        true,
        {
          sellerName: "Prepared Homeowner",
          propertyAddress: "55 Oak Ave",
          sellerPhoneE164: "+18165559876",
          maskedSellerPhone: "+1 (816) 555-9876",
        },
      ),
    );

    await waitFor(() => expect(result.current.contextLoad.status).toBe("ready"));
    expect(result.current.contextLoad).toEqual({
      status: "ready",
      context: expect.objectContaining({
        sellerName: "Prepared Homeowner",
        propertyAddress: "55 Oak Ave",
      }),
    });
  });

  it("keeps the trusted property context ahead of prepared-target fallbacks", async () => {
    const { result } = renderHook(() =>
      useCoachSession(
        "call-1",
        "lead-1",
        null,
        null,
        true,
        {
          sellerName: "Stale Name",
          propertyAddress: "Old Address",
          sellerPhoneE164: null,
          maskedSellerPhone: null,
        },
      ),
    );

    await waitFor(() => expect(result.current.contextLoad.status).toBe("ready"));
    expect(result.current.contextLoad).toEqual({
      status: "ready",
      context: expect.objectContaining({
        sellerName: "Jane",
        propertyAddress: "1 Main St",
      }),
    });
  });

  it("does not turn a manual-dial phone-number label into a homeowner token", async () => {
    loadCoachCallContext.mockResolvedValue({
      ...sampleContext,
      sellerName: null,
      propertyAddress: null,
    });
    const { result } = renderHook(() =>
      useCoachSession(
        "call-1",
        null,
        null,
        null,
        true,
        {
          sellerName: "+1 (816) 555-9876",
          propertyAddress: null,
          sellerPhoneE164: "+18165559876",
          maskedSellerPhone: "+1 (816) 555-9876",
        },
      ),
    );

    await waitFor(() => expect(result.current.contextLoad.status).toBe("ready"));
    expect(result.current.contextLoad).toEqual({
      status: "ready",
      context: expect.objectContaining({ sellerName: null, propertyAddress: null }),
    });
  });

  it("replaces prepared-target fallbacks when a second call starts", async () => {
    loadCoachCallContext.mockResolvedValue({
      ...sampleContext,
      sellerName: null,
      propertyAddress: null,
    });
    const { result, rerender } = renderHook(
      ({ callId, name, address }: { callId: string; name: string; address: string }) =>
        useCoachSession(
          callId,
          "lead-1",
          null,
          null,
          true,
          {
            sellerName: name,
            propertyAddress: address,
            sellerPhoneE164: null,
            maskedSellerPhone: null,
          },
        ),
      { initialProps: { callId: "call-1", name: "Seller One", address: "1 First St" } },
    );

    await waitFor(() => expect(result.current.contextLoad).toEqual({
      status: "ready",
      context: expect.objectContaining({ sellerName: "Seller One", propertyAddress: "1 First St" }),
    }));

    rerender({ callId: "call-2", name: "Seller Two", address: "2 Second St" });
    await waitFor(() => expect(result.current.contextLoad).toEqual({
      status: "ready",
      context: expect.objectContaining({ sellerName: "Seller Two", propertyAddress: "2 Second St" }),
    }));
  });

  it("moves to error state when context loading rejects, and retryContext re-fetches", async () => {
    loadCoachCallContext.mockReset().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(sampleContext);
    const { result } = renderHook(() => useCoachSession(
      "call-1",
      "lead-1",
      "+18165559876",
      "+18165551234",
      true,
      {
        sellerName: "Prepared Homeowner",
        propertyAddress: "55 Oak Ave",
        sellerPhoneE164: "+18165559876",
        maskedSellerPhone: "+1 (816) 555-9876",
      },
    ));
    await waitFor(() => expect(result.current.contextLoad.status).toBe("error"));
    expect(result.current.contextLoad).toEqual({
      status: "error",
      context: expect.objectContaining({
        sellerName: "Prepared Homeowner",
        propertyAddress: "55 Oak Ave",
        leadId: "lead-1",
        sellerPhoneE164: "+18165559876",
        repPhoneE164: "+18165551234",
      }),
    });

    act(() => result.current.retryContext());
    await waitFor(() => expect(result.current.contextLoad.status).toBe("ready"));
    expect(loadCoachCallContext).toHaveBeenCalledTimes(2);
  });

  it("tracks branch variant overrides via selectVariant", async () => {
    const { result } = renderHook(() => useCoachSession("call-1", "lead-1", null, null));
    await waitFor(() => expect(result.current.contextLoad.status).toBe("ready"));
    expect(result.current.branchOverrides).toEqual({});
    act(() => result.current.selectVariant("Opener", "fsbo"));
    expect(result.current.branchOverrides).toEqual({ Opener: "fsbo" });
  });

  it("owns manual section navigation independently of realtime state", async () => {
    const { result } = renderHook(() => useCoachSession("call-1", "lead-1", null, null));
    await waitFor(() => expect(result.current.contextLoad.status).toBe("ready"));

    const firstSectionId = result.current.activeSectionId;
    expect(result.current.canGoPrevious).toBe(false);
    expect(result.current.canGoNext).toBe(true);

    act(() => result.current.goNextSection());
    const manuallySelectedSectionId = result.current.activeSectionId;
    expect(manuallySelectedSectionId).not.toBe(firstSectionId);
    expect(result.current.canGoPrevious).toBe(true);

    act(() => result.current.dispatch({
      type: "phase",
      phaseId: "close",
      scriptVersion: "1.0.2",
      matcherVersion: "1.0.0",
      ts: "t1",
    }));
    expect(result.current.activeSectionId).toBe(manuallySelectedSectionId);

    act(() => result.current.goPreviousSection());
    expect(result.current.activeSectionId).toBe(firstSectionId);
  });

  it("supports deliberate phase jumps through the phase's first manual section", async () => {
    const { result } = renderHook(() => useCoachSession("call-1", "lead-1", null, null));
    await waitFor(() => expect(result.current.contextLoad.status).toBe("ready"));

    act(() => result.current.goToPhase("reveal"));
    expect(result.current.activeSectionId).toBe("reveal.situation-rundown");
  });

  it("ignores an unknown section id instead of stranding navigation", async () => {
    const { result } = renderHook(() => useCoachSession("call-1", "lead-1", null, null));
    await waitFor(() => expect(result.current.contextLoad.status).toBe("ready"));
    act(() => result.current.goNextSection());
    const currentSectionId = result.current.activeSectionId;

    act(() => result.current.goToSection("stale.or.invalid"));

    expect(result.current.activeSectionId).toBe(currentSectionId);
    expect(result.current.canGoPrevious).toBe(true);
    expect(result.current.canGoNext).toBe(true);
  });

  it("resets context, branch overrides, and manual section for a new callId", async () => {
    const { result, rerender } = renderHook(
      ({ callId }: { callId: string | null }) => useCoachSession(callId, "lead-1", null, null),
      { initialProps: { callId: "call-1" } as { callId: string | null } },
    );
    await waitFor(() => expect(result.current.contextLoad.status).toBe("ready"));
    act(() => result.current.selectVariant("Opener", "fsbo"));
    act(() => result.current.goNextSection());
    act(() => result.current.setEntryField("motivation", "move closer to family"));
    act(() => result.current.setEntryField("cold_caller_name", "Morgan"));
    const firstContinuity = result.current.recommendationContinuity;
    firstContinuity.state = {
      ...firstContinuity.state,
      recommendations: ["Seller A recommendation"],
      followUpQuestions: ["Seller A question?"],
    };
    expect(result.current.branchOverrides).toEqual({ Opener: "fsbo" });
    expect(result.current.canGoPrevious).toBe(true);

    rerender({ callId: null });
    expect(result.current.activeSectionId).toBe("introduction.opener");
    expect(result.current.recommendationContinuity).not.toBe(firstContinuity);
    expect(result.current.recommendationContinuity.state.recommendations).toEqual([]);
    expect(result.current.recommendationContinuity.state.followUpQuestions).toEqual([]);
    rerender({ callId: "call-2" });
    expect(result.current.branchOverrides).toEqual({});
    expect(result.current.state.entryFields.motivation).toBeNull();
    expect(result.current.state.entryFields.cold_caller_name).toBeNull();
    expect(result.current.canGoPrevious).toBe(false);
    expect(result.current.activeSectionId).toBe("introduction.opener");
    await waitFor(() => expect(result.current.contextLoad.status).toBe("ready"));
    expect(loadCoachCallContext).toHaveBeenCalledTimes(2);
  });

  it("setEntryField dispatches into the underlying reducer state", async () => {
    const { result } = renderHook(() => useCoachSession("call-1", "lead-1", null, null));
    await waitFor(() => expect(result.current.contextLoad.status).toBe("ready"));
    act(() => result.current.setEntryField("offer_price", "$210,000"));
    expect(result.current.state.entryFields.offer_price).toBe("$210,000");
  });

  it("does nothing when callId is null", async () => {
    renderHook(() => useCoachSession(null, "lead-1", null, null));
    await act(async () => {
      await Promise.resolve();
    });
    expect(loadCoachCallContext).not.toHaveBeenCalled();
  });
});
