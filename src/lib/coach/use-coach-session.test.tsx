import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CoachCallContext } from "./types";

const { loadCoachCallContext, createCoachChannel } = vi.hoisted(() => ({
  loadCoachCallContext: vi.fn(),
  createCoachChannel: vi.fn(),
}));

vi.mock("./coach-context-actions", () => ({ loadCoachCallContext }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getSession: () => Promise.resolve({ data: { session: null } }) },
    realtime: { setAuth: vi.fn() },
    channel: createCoachChannel,
    removeChannel: vi.fn(),
  }),
}));

import { useCoachSession } from "./use-coach-session";

const sampleContext: CoachCallContext = {
  sellerName: "Jane",
  propertyAddress: "1 Main St",
  propertyCounty: "Jackson",
  repName: "Alex Rep",
  authenticatedRepName: "Alex Rep",
  repPhoneE164: "+18165551234",
  motivation: null,
  leadId: "abcd1234-ef56-7890-abcd-ef1234567890",
  sellerPhoneE164: "+18165559876",
  coldCallerName: null,
  yearBuilt: null,
  leadSource: null,
  occupancy: null,
};

describe("useCoachSession", () => {
  beforeEach(() => {
    loadCoachCallContext.mockReset().mockResolvedValue(sampleContext);
    createCoachChannel.mockReset().mockImplementation(() => ({
      on() {
        return this;
      },
      subscribe() {
        return this;
      },
    }));
  });

  it("hydrates prepared names during connecting, then subscribes without resetting the session", async () => {
    loadCoachCallContext.mockReturnValue(new Promise(() => undefined));
    const { result, rerender } = renderHook(
      ({ callId }: { callId: string | null }) => useCoachSession(
        callId,
        "lead-1",
        "+18165559876",
        "+18165551234",
        true,
        {
          repName: "Mel",
          sellerName: "Jarrad",
          propertyAddress: "55 Oak Ave",
          sellerPhoneE164: "+18165559876",
          maskedSellerPhone: "+1 (816) 555-9876",
        },
        "call-token",
      ),
      { initialProps: { callId: null } as { callId: string | null } },
    );

    expect(result.current.contextLoad).toEqual({
      status: "loading",
      context: expect.objectContaining({
        repName: "Mel",
        authenticatedRepName: null,
        leadId: null,
        sellerName: "Jarrad",
        propertyAddress: "55 Oak Ave",
      }),
    });
    await waitFor(() => expect(loadCoachCallContext).toHaveBeenCalledTimes(1));
    expect(createCoachChannel).not.toHaveBeenCalled();

    act(() => result.current.goNextSection());
    act(() => result.current.setEntryField("motivation", "sell before winter"));
    const selectedSection = result.current.activeSectionId;
    rerender({ callId: "call-token" });

    expect(result.current.activeSectionId).toBe(selectedSection);
    expect(result.current.state.entryFields.motivation).toBe("sell before winter");
    expect(loadCoachCallContext).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(createCoachChannel).toHaveBeenCalledTimes(1));
  });

  it("replaces a prior connecting identity synchronously when the session key changes", () => {
    loadCoachCallContext.mockReturnValue(new Promise(() => undefined));
    const { result, rerender } = renderHook(
      ({ sessionKey, repName, sellerName, address }) => useCoachSession(
        null,
        "lead-1",
        null,
        null,
        true,
        {
          repName,
          sellerName,
          propertyAddress: address,
          sellerPhoneE164: null,
          maskedSellerPhone: null,
        },
        sessionKey,
      ),
      {
        initialProps: {
          sessionKey: "call-one",
          repName: "Mel",
          sellerName: "Seller One",
          address: "1 First St",
        },
      },
    );

    act(() => result.current.setEntryField("offer_price", "$200,000"));

    rerender({
      sessionKey: "call-two",
      repName: "Morgan",
      sellerName: "Seller Two",
      address: "2 Second St",
    });

    expect(result.current.contextLoad).toEqual({
      status: "loading",
      context: expect.objectContaining({
        repName: "Morgan",
        authenticatedRepName: null,
        leadId: null,
        sellerName: "Seller Two",
        propertyAddress: "2 Second St",
      }),
    });
    expect(result.current.state.entryFields.offer_price).toBeNull();
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

  it("uses only the successful authorized context for file-number identity", async () => {
    const authorized = {
      ...sampleContext,
      repName: "Jarrad Henry",
      authenticatedRepName: "Jarrad Henry",
      leadId: "abcd1234-ef56-7890-abcd-ef1234c1c524",
    };
    loadCoachCallContext.mockResolvedValue(authorized);
    const { result } = renderHook(() => useCoachSession(
      "call-1",
      "unauthorized-abcdef",
      null,
      null,
      true,
      {
        repName: "Prepared Impostor",
        sellerName: "Prepared Homeowner",
        propertyAddress: "55 Oak Ave",
        sellerPhoneE164: null,
        maskedSellerPhone: null,
      },
    ));

    expect(result.current.contextLoad.context).toEqual(expect.objectContaining({
      repName: "Prepared Impostor",
      authenticatedRepName: null,
      leadId: null,
    }));
    await waitFor(() => expect(result.current.contextLoad.status).toBe("ready"));
    expect(result.current.contextLoad.context).toEqual(expect.objectContaining({
      repName: "Jarrad Henry",
      authenticatedRepName: "Jarrad Henry",
      leadId: "abcd1234-ef56-7890-abcd-ef1234c1c524",
    }));
  });

  it("does not replace an absent authenticated rep with the prepared target rep", async () => {
    loadCoachCallContext.mockResolvedValue({ ...sampleContext, repName: null, authenticatedRepName: null });
    const { result } = renderHook(() => useCoachSession(
      "call-1",
      "lead-1",
      null,
      null,
      true,
      {
        repName: "Prepared Rep",
        sellerName: "Prepared Homeowner",
        propertyAddress: "55 Oak Ave",
        sellerPhoneE164: null,
        maskedSellerPhone: null,
      },
    ));

    await waitFor(() => expect(result.current.contextLoad.status).toBe("ready"));
    expect(result.current.contextLoad.context).toEqual(expect.objectContaining({
      repName: "Prepared Rep",
      authenticatedRepName: null,
    }));
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
        authenticatedRepName: null,
        leadId: null,
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
      scriptVersion: "1.1.0",
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
