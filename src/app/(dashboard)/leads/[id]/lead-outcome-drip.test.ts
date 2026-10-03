import { describe, expect, it } from "vitest";

import type { DripProgress } from "@/lib/sequences/drip-progress";

import { NO_ACTIVE_DRIP, toOutcomeBarDrip } from "./lead-outcome-drip";

const progress: DripProgress = {
  propertyId: "p1",
  enrollmentId: "e1",
  enrollmentStatus: "active",
  sequenceId: "s1",
  sequenceName: "90-day follow-up",
  step: 2,
  totalSteps: 4,
  nextTextAt: null,
  lastText: null,
  status: "Waiting",
  reason: null,
};

describe("toOutcomeBarDrip", () => {
  it.each(["active", "paused"])("maps a %s enrollment", (status) => {
    expect(toOutcomeBarDrip({ ...progress, enrollmentStatus: status })).toEqual({
      activeDripEnrollmentId: "e1",
      activeDripSequenceId: "s1",
      activeDripName: "90-day follow-up",
      activeDripStep: 2,
      activeDripTotal: 4,
    });
  });

  it.each(["completed", "canceled", "opted_out", "failed"])("returns nulls for %s", (status) => {
    expect(toOutcomeBarDrip({ ...progress, enrollmentStatus: status })).toEqual(NO_ACTIVE_DRIP);
  });

  it("returns nulls when there is no enrollment", () => {
    expect(toOutcomeBarDrip(undefined)).toEqual(NO_ACTIVE_DRIP);
    expect(toOutcomeBarDrip(null)).toEqual(NO_ACTIVE_DRIP);
  });
});
