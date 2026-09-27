import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initialCoachState } from "@/lib/coach/event-reducer";
import { createCoachRecommendationContinuity } from "@/lib/coach/recommendation-client";
import type { CoachSession } from "@/lib/coach/use-coach-session";
import { CoachLiveView } from "./coach-live-view";

const session = {
  callId: "call-1", scriptBinding: null, state: initialCoachState(), dispatch: vi.fn(), degraded: false, reconnectGap: false, dismissReconnectGap: vi.fn(), malformedEventCount: 0, scriptOutOfSync: null,
  contextLoad: { status: "ready", context: { sellerName: null, propertyAddress: null, propertyCounty: null, repName: null, repPhoneE164: null, motivation: null, leadId: null, sellerPhoneE164: null, coldCallerName: null, yearBuilt: null, leadSource: null, occupancy: null } }, retryContext: vi.fn(), branchOverrides: {}, selectVariant: vi.fn(), sectionBranchSelections: {}, selectSectionBranch: vi.fn(), setEntryField: vi.fn(), activeSectionId: "", previousSectionId: null, nextSectionId: null, canGoPrevious: false, canGoNext: false, goToSection: vi.fn(), goPreviousSection: vi.fn(), goNextSection: vi.fn(), goToPhase: vi.fn(), recommendationContinuity: createCoachRecommendationContinuity("call-1"),
} as unknown as CoachSession;

describe("unbound live coach", () => {
  it("keeps transcript and hangup usable while explicitly disabling coaching", () => {
    const hangup = vi.fn();
    render(<CoachLiveView session={session} callName="Jane" callStatus="live" seconds={12} muted={false} held={false} holdPending={false} onDigit={vi.fn()} onMute={vi.fn()} onHold={vi.fn()} onHangup={hangup} onCollapse={vi.fn()} />);
    expect(screen.getByTestId("coach-script-unavailable")).toHaveTextContent("Script unavailable — coaching is off for this call");
    expect(screen.getByText("Transcript")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("coach-hangup")); expect(hangup).toHaveBeenCalledOnce();
  });
});
