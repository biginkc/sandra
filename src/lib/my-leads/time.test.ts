import { describe, expect, it } from "vitest";
import { acquisitionWarnings, workingDeadline, workingMinutesBetween, type WarningInput } from "./time";

const vectors = [
  ["2026-09-11T21:50:00Z", "2026-09-14T14:20:00Z"],
  ["2026-03-06T22:50:00Z", "2026-03-09T14:20:00Z"],
  ["2026-10-30T21:50:00Z", "2026-11-02T15:20:00Z"],
  ["2026-09-11T22:00:00Z", "2026-09-14T14:30:00Z"],
  ["2026-09-14T04:59:00Z", "2026-09-14T14:30:00Z"],
  ["2026-09-14T14:00:00Z", "2026-09-14T14:30:00Z"],
];
describe("Central working time", () => {
  it.each(vectors)("30 minutes from %s ends at %s", (start, expected) => {
    expect(workingDeadline(new Date(start)).toISOString()).toBe(new Date(expected).toISOString());
    expect(workingMinutesBetween(new Date(start), new Date(expected))).toBe(30);
  });
  it("keeps fractional minutes and excludes weekends", () => {
    expect(workingMinutesBetween(new Date("2026-09-11T21:59:30Z"), new Date("2026-09-14T14:00:15Z"))).toBe(0.75);
    expect(workingMinutesBetween(new Date("2026-09-12T12:00Z"), new Date("2026-09-13T18:00Z"))).toBe(0);
  });
  it("handles zero and rejects invalid inputs", () => {
    const start = new Date("2026-09-12T12:00Z");
    expect(workingDeadline(start, 0)).toEqual(start);
    expect(() => workingDeadline(start, -1)).toThrow(RangeError);
    expect(() => workingMinutesBetween(new Date("bad"), start)).toThrow(RangeError);
  });
});
const base: WarningInput = { stage: "contacted", assignedAt: null, firstCallAt: null, clockEligible: false,
  stageEnteredAt: null, nextAppointmentAt: null, offerFollowUpAt: null, archived: false };
describe("warning transitions", () => {
  it("requires a strictly future next step and supplies its transition time", () => {
    const now = new Date("2026-09-14T15:00Z");
    expect(acquisitionWarnings(base, now).reasons).toEqual(["missing_next_step"]);
    expect(acquisitionWarnings({ ...base, nextAppointmentAt: now }, now).reasons).toEqual(["missing_next_step"]);
    expect(acquisitionWarnings({ ...base, nextAppointmentAt: new Date("2026-09-14T16:00Z") }, now)).toEqual({ reasons: [], nextWarningAt: new Date("2026-09-14T16:00Z") });
  });
  it("warns at exactly 12 elapsed hours, including overnight/weekend", () => {
    const input = { ...base, stage: "needs_offer" as const, stageEnteredAt: new Date("2026-09-12T02:00Z") };
    expect(acquisitionWarnings(input, new Date("2026-09-12T13:59:59Z")).reasons).toEqual([]);
    expect(acquisitionWarnings(input, new Date("2026-09-12T14:00Z")).reasons).toEqual(["offer_needed_overdue"]);
  });
  it("keeps call warning after outreach and stops it with actual evidence", () => {
    const input = { ...base, clockEligible: true, assignedAt: new Date("2026-09-14T14:00Z") };
    const now = new Date("2026-09-14T14:30Z");
    expect(acquisitionWarnings(input, now).reasons).toEqual(["first_call_overdue", "missing_next_step"]);
    expect(acquisitionWarnings({ ...input, firstCallAt: now }, now).reasons).toEqual(["missing_next_step"]);
    expect(acquisitionWarnings({ ...input, stage: "under_contract" }, now).reasons).toEqual([]);
    expect(acquisitionWarnings({ ...input, archived: true }, now).reasons).toEqual([]);
  });
  it("uses the offer follow-up instant and does not fabricate launch timing", () => {
    const now = new Date("2026-09-14T15:00Z");
    expect(acquisitionWarnings({ ...base, stage: "not_contacted", clockEligible: true }, now).reasons).toEqual([]);
    expect(acquisitionWarnings({ ...base, stage: "offer_sent", offerFollowUpAt: now }, now).reasons).toEqual(["offer_follow_up_overdue"]);
  });
});
