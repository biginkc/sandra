import { queueRowFixture } from "../_components/call-next-test-support";
import type { WorkFacts, WorkReason } from "./contract";

/** 2026-10-14 1:00 PM Central (CDT, UTC-5). */
export const NOW = new Date("2026-10-14T18:00:00Z");

const PLACE: Partial<Record<WorkReason, WorkFacts["place"]>> = {
  in_drip: "their_move", texted_last: "their_move", offer_out: "their_move", callback_booked: "their_move", under_contract: "neither",
};

/** A WorkFacts with sane defaults; `over` replaces any field. */
export function workFacts(reason: WorkReason, rowNo: string, headline: Record<string, unknown> = {}, over: Partial<WorkFacts> = {}): WorkFacts {
  const propertyId = over.propertyId ?? "lead-1";
  return {
    propertyId,
    stage: "contacted",
    place: PLACE[reason] ?? "your_move",
    reason,
    rowNo,
    reasonAt: null,
    headline,
    drip: null,
    nextStep: null,
    lastTouchAt: null,
    attemptsCount: 0,
    assignedAt: "2026-10-11T15:00:00Z",
    latestInbound: null,
    hasPhone: true,
    contactDnc: false,
    broken: [],
    aiDraftId: null,
    labels: [],
    zip: null,
    contractSignedAt: null,
    lastTouch: null,
    row: queueRowFixture(propertyId),
    ...over,
  };
}
