import { describe, expect, it } from "vitest";

import { canActOnLeadAppointment } from "./lead-appointments";

describe("canActOnLeadAppointment", () => {
  const live = { status: "open" as const, assignee_id: "rep-1" };
  it("allows the assignee and an owner on open and snoozed work", () => {
    expect(canActOnLeadAppointment(live, "rep-1", false)).toBe(true);
    expect(canActOnLeadAppointment({ ...live, status: "snoozed" }, "boss", true)).toBe(true);
  });
  it("denies other reps, anonymous viewers and finished work", () => {
    expect(canActOnLeadAppointment(live, "rep-2", false)).toBe(false);
    expect(canActOnLeadAppointment(live, null, true)).toBe(false);
    expect(canActOnLeadAppointment({ ...live, status: "completed" }, "rep-1", true)).toBe(false);
    expect(canActOnLeadAppointment({ ...live, status: "cancelled" }, "rep-1", true)).toBe(false);
  });
});
