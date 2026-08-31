import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCoachRecommendationContinuity } from "@/lib/coach/recommendation-client";
import { FIRST_COACH_SECTION_ID } from "@/lib/coach/section-manifest";
import { initialCoachState } from "@/lib/coach/event-reducer";
import type { CoachCallContext, CoachState } from "@/lib/coach/types";

import { CoachLiveView } from "./coach-live-view";

const context: CoachCallContext = {
  sellerName: "Jane Homeowner",
  propertyAddress: "123 Main Street",
  propertyCounty: "Jackson",
  repName: "Alex Rep",
  repPhoneE164: "+18165551234",
  motivation: "move closer to family",
  leadId: "lead-1",
  sellerPhoneE164: "+18165559876",
  coldCallerName: "Taylor",
  yearBuilt: "1987",
  leadSource: "cold_call",
  occupancy: "owner_occupied",
};

function makeSession() {
  const state: CoachState = {
    ...initialCoachState(),
    holdTimer: {
      timerId: "hold_timer",
      startedAt: "2026-08-30T18:00:00.000Z",
      durationS: 180,
    },
  };
  return {
    callId: "call-1",
    recommendationContinuity: createCoachRecommendationContinuity("call-1"),
    state,
    degraded: false,
    reconnectGap: false,
    dismissReconnectGap: vi.fn(),
    contextLoad: { status: "ready" as const, context },
    retryContext: vi.fn(),
    branchOverrides: {},
    selectVariant: vi.fn(),
    setEntryField: vi.fn(),
    activeSectionId: FIRST_COACH_SECTION_ID,
    previousSectionId: null,
    nextSectionId: null,
    canGoPrevious: false,
    canGoNext: false,
    goToSection: vi.fn(),
    goPreviousSection: vi.fn(),
    goNextSection: vi.fn(),
    goToPhase: vi.fn(),
    dispatch: vi.fn(),
  };
}

describe("CoachLiveView hold timer integration", () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.parse("2026-08-30T18:00:00.000Z") }));
  afterEach(() => vi.useRealTimers());

  it("renders the countdown without changing script or telephony controls", () => {
    const onHold = vi.fn();
    const onHangup = vi.fn();
    const session = makeSession();
    const common = {
      session: session as never,
      callName: "Jane Homeowner",
      callStatus: "live" as const,
      seconds: 83,
      muted: false,
      holdPending: false,
      onDigit: vi.fn(),
      onMute: vi.fn(),
      onHold,
      onHangup,
      onCollapse: vi.fn(),
      recommendationRequest: vi.fn(),
    };
    const rendered = render(
      <CoachLiveView
        {...common}
        held
      />,
    );

    expect(screen.getByTestId("hold-timer")).toHaveTextContent("Hold 03:00");
    expect(screen.getByTestId("current-section-script")).toBeVisible();
    expect(screen.getByTestId("coach-hold")).toHaveTextContent("Resume");

    rendered.rerender(<CoachLiveView {...common} held={false} />);
    expect(screen.queryByTestId("hold-timer")).not.toBeInTheDocument();
    expect(screen.getByTestId("current-section-script")).toBeVisible();

    session.state.holdTimer = {
      timerId: "hold_timer",
      startedAt: new Date(Date.now()).toISOString(),
      durationS: 180,
    };
    rendered.rerender(<CoachLiveView {...common} held />);
    expect(screen.getByTestId("hold-timer")).toHaveTextContent("Hold 03:00");

    act(() => vi.advanceTimersByTime(180_000));
    expect(screen.getByTestId("hold-timer")).toHaveTextContent("Hold 00:00");
    expect(screen.getByTestId("current-section-script")).toBeVisible();
    expect(onHold).not.toHaveBeenCalled();
    expect(onHangup).not.toHaveBeenCalled();
  });
});
