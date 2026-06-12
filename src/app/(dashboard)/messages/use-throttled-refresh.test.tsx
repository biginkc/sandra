import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

// eslint-disable-next-line import/first
import { useThrottledRefresh } from "./use-throttled-refresh";

const INTERVAL = 10_000;

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useThrottledRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refresh.mockClear();
    setVisibility("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes immediately when outside the throttle window", () => {
    const { result } = renderHook(() => useThrottledRefresh(INTERVAL));
    act(() => result.current());
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst into one leading + one trailing refresh", () => {
    const { result } = renderHook(() => useThrottledRefresh(INTERVAL));
    act(() => {
      result.current(); // leading
      result.current();
      result.current();
      result.current();
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(INTERVAL);
    });
    expect(refresh).toHaveBeenCalledTimes(2); // trailing fired once
  });

  it("sustained events refresh at most once per interval", () => {
    const { result } = renderHook(() => useThrottledRefresh(INTERVAL));
    // Simulate a campaign: an event every second for 60s.
    act(() => {
      for (let i = 0; i < 60; i++) {
        result.current();
        vi.advanceTimersByTime(1_000);
      }
    });
    // 60s of once-a-second events through a 10s throttle → ≤7 refreshes
    // (leading + one per window), far below the 60 of the old behavior.
    expect(refresh.mock.calls.length).toBeLessThanOrEqual(7);
    expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it("does not refresh while hidden; reconciles once on return", () => {
    const { result } = renderHook(() => useThrottledRefresh(INTERVAL));
    act(() => setVisibility("hidden"));
    act(() => {
      result.current();
      result.current();
      vi.advanceTimersByTime(INTERVAL * 3);
    });
    expect(refresh).not.toHaveBeenCalled();

    act(() => setVisibility("visible"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a trailing timer that fires after tabbing away defers to the visibility reconcile", () => {
    const { result } = renderHook(() => useThrottledRefresh(INTERVAL));
    act(() => {
      result.current(); // leading — starts the window
      result.current(); // arms trailing
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    act(() => setVisibility("hidden"));
    act(() => {
      vi.advanceTimersByTime(INTERVAL); // trailing fires while hidden
    });
    expect(refresh).toHaveBeenCalledTimes(1); // suppressed

    act(() => setVisibility("visible"));
    expect(refresh).toHaveBeenCalledTimes(2); // reconciled on return
  });

  it("returning to a tab with nothing pending does not refresh", () => {
    renderHook(() => useThrottledRefresh(INTERVAL));
    act(() => setVisibility("hidden"));
    act(() => setVisibility("visible"));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("clears the trailing timer on unmount", () => {
    const { result, unmount } = renderHook(() => useThrottledRefresh(INTERVAL));
    act(() => {
      result.current();
      result.current(); // arms trailing
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(INTERVAL * 2);
    });
    expect(refresh).toHaveBeenCalledTimes(1); // only the leading call
  });
});
