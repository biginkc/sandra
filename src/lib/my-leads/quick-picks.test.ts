import { describe, expect, it } from "vitest";

import { quickPickDueAt } from "./quick-picks";

const chicago = (d: Date) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

describe("quickPickDueAt", () => {
  it("is 10:00 Central on the following days", () => {
    const now = new Date("2026-10-05T15:00:00Z"); // Mon 10:00 CDT
    expect(chicago(quickPickDueAt("tomorrow", now))).toBe("10/06/2026, 10:00");
    expect(chicago(quickPickDueAt("three_days", now))).toBe("10/08/2026, 10:00");
    expect(chicago(quickPickDueAt("next_week", now))).toBe("10/12/2026, 10:00");
  });

  it("uses the Chicago calendar day, not the UTC day, late in the evening", () => {
    const now = new Date("2026-10-06T03:30:00Z"); // Mon 22:30 CDT, already Tue in UTC
    expect(chicago(quickPickDueAt("tomorrow", now))).toBe("10/06/2026, 10:00");
  });

  it("keeps 10:00 local across the 2026-11-01 fall-back", () => {
    const now = new Date("2026-10-30T15:00:00Z");
    const tomorrow = quickPickDueAt("tomorrow", now); // Sat 10/31 CDT
    const three = quickPickDueAt("three_days", now); // Mon 11/02 CST
    expect(chicago(tomorrow)).toBe("10/31/2026, 10:00");
    expect(chicago(three)).toBe("11/02/2026, 10:00");
    expect(three.getTime() - tomorrow.getTime()).toBe(49 * 3_600_000); // 2 days + the repeated hour
    expect(chicago(quickPickDueAt("next_week", now))).toBe("11/06/2026, 10:00");
  });

  it("keeps 10:00 local across the 2027-03-14 spring-forward", () => {
    const now = new Date("2027-03-12T16:00:00Z"); // Fri 10:00 CST
    const tomorrow = quickPickDueAt("tomorrow", now); // Sat 3/13 CST
    const three = quickPickDueAt("three_days", now); // Mon 3/15 CDT
    expect(chicago(three)).toBe("03/15/2027, 10:00");
    expect(three.getTime() - tomorrow.getTime()).toBe(47 * 3_600_000);
    expect(chicago(quickPickDueAt("next_week", now))).toBe("03/19/2027, 10:00");
  });

  it("never lands on a non-existent local time", () => {
    const now = new Date("2027-03-12T16:00:00Z");
    const due = quickPickDueAt("tomorrow", now, { time: "02:30" }); // Sat: fine
    expect(chicago(due)).toBe("03/13/2027, 02:30");
    const sunday = quickPickDueAt("tomorrow", new Date("2027-03-13T16:00:00Z"), { time: "02:30" }); // 3/14 02:30 does not exist
    expect(chicago(sunday)).toBe("03/14/2027, 03:30");
  });

  it("honours a custom time and zone", () => {
    const due = quickPickDueAt("tomorrow", new Date("2026-10-05T15:00:00Z"), { time: "09:00", timeZone: "America/New_York" });
    expect(due.toISOString()).toBe("2026-10-06T13:00:00.000Z");
  });
});
