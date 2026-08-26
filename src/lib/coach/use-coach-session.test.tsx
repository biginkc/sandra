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

  it("moves to error state when context loading rejects, and retryContext re-fetches", async () => {
    loadCoachCallContext.mockReset().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(sampleContext);
    const { result } = renderHook(() => useCoachSession("call-1", "lead-1", null, null));
    await waitFor(() => expect(result.current.contextLoad.status).toBe("error"));

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

  it("resets contextLoad, contextAttempt, and branchOverrides for a new callId", async () => {
    const { result, rerender } = renderHook(
      ({ callId }: { callId: string }) => useCoachSession(callId, "lead-1", null, null),
      { initialProps: { callId: "call-1" } },
    );
    await waitFor(() => expect(result.current.contextLoad.status).toBe("ready"));
    act(() => result.current.selectVariant("Opener", "fsbo"));
    expect(result.current.branchOverrides).toEqual({ Opener: "fsbo" });

    rerender({ callId: "call-2" });
    expect(result.current.branchOverrides).toEqual({});
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
