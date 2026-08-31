import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CoachHoldTimer } from "@/lib/coach/types";

import { HoldTimer, formatHoldTimerSeconds, holdTimerRemainingSeconds } from "./hold-timer";

const STARTED_AT = "2026-08-30T18:00:00.000Z";
const STARTED_MS = Date.parse(STARTED_AT);

const timer: CoachHoldTimer = {
  timerId: "hold_timer",
  startedAt: STARTED_AT,
  durationS: 180,
};

describe("hold timer", () => {
  beforeEach(() => vi.useFakeTimers({ now: STARTED_MS }));
  afterEach(() => vi.useRealTimers());

  it("counts down from three minutes using the authoritative start timestamp", () => {
    expect(holdTimerRemainingSeconds(timer, STARTED_MS)).toBe(180);
    expect(holdTimerRemainingSeconds(timer, STARTED_MS + 61_000)).toBe(119);
    expect(formatHoldTimerSeconds(180)).toBe("03:00");
    expect(formatHoldTimerSeconds(0)).toBe("00:00");
  });

  it("ticks toward zero and clamps an expired hold at 00:00", () => {
    render(<HoldTimer timer={timer} />);
    expect(screen.getByTestId("hold-timer")).toHaveTextContent("Hold 03:00");

    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByTestId("hold-timer")).toHaveTextContent("Hold 02:59");

    act(() => vi.advanceTimersByTime(179_000));
    expect(screen.getByTestId("hold-timer")).toHaveTextContent("Hold 00:00");
    expect(screen.getByTestId("hold-timer")).toHaveAttribute("data-remaining-seconds", "0");
  });

  it("fails closed for no or malformed timer data", () => {
    const { rerender } = render(<HoldTimer timer={null} />);
    expect(screen.queryByTestId("hold-timer")).not.toBeInTheDocument();

    rerender(<HoldTimer timer={{ ...timer, startedAt: "not-a-date" }} />);
    expect(screen.queryByTestId("hold-timer")).not.toBeInTheDocument();

    rerender(<HoldTimer timer={{ ...timer, durationS: 0 }} />);
    expect(screen.queryByTestId("hold-timer")).not.toBeInTheDocument();

    rerender(<HoldTimer timer={{ ...timer, timerId: "legacy" }} />);
    expect(screen.queryByTestId("hold-timer")).not.toBeInTheDocument();
  });

  it("recomputes after remount instead of restarting from three minutes", () => {
    const first = render(<HoldTimer timer={timer} />);
    act(() => vi.advanceTimersByTime(12_000));
    expect(screen.getByTestId("hold-timer")).toHaveTextContent("Hold 02:48");

    first.unmount();
    render(<HoldTimer timer={timer} />);
    expect(screen.getByTestId("hold-timer")).toHaveTextContent("Hold 02:48");
  });
});
