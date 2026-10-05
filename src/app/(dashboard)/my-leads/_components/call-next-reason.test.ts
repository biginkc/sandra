import { describe, expect, it } from "vitest";

import { compactAge, longAge, reasonLabel } from "./call-next-reason";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// 2026-10-05 15:00 UTC is 10:00 AM in America/Chicago (CDT).
const NOW = new Date("2026-10-05T15:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const ahead = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

describe("reasonLabel", () => {
  it.each([
    ["pinned_call_today", ago(HOUR), "Pinned: call today"],
    ["pinned_call_today", null, "Pinned: call today"],
    ["appointment_due", ahead(10 * MIN), "Callback due 10:10 AM"],
    ["appointment_due", ahead(0), "Callback due 10:00 AM"],
    ["appointment_due", null, "Callback due soon"],
    ["appointment_overdue", ago(2 * DAY), "Callback 2 days overdue"],
    ["appointment_overdue", ago(1 * DAY), "Callback 1 day overdue"],
    ["appointment_overdue", ago(3 * HOUR), "Callback 3 hours overdue"],
    ["appointment_overdue", ago(1 * HOUR), "Callback 1 hour overdue"],
    ["appointment_overdue", ago(5 * MIN), "Callback 5 minutes overdue"],
    ["appointment_overdue", ago(30_000), "Callback overdue"],
    ["appointment_overdue", null, "Callback overdue"],
    ["inbound_text", ago(2 * HOUR), "Texted you 2h ago"],
    ["inbound_text", ago(40 * MIN), "Texted you 40m ago"],
    ["inbound_text", ago(3 * DAY), "Texted you 3d ago"],
    ["inbound_text", null, "Texted you"],
    ["inbound_call", ago(2 * HOUR), "Called you 2h ago"],
    ["needs_offer", ago(1 * DAY), "Needs an offer · waiting 1d"],
    ["needs_offer", ago(3 * HOUR), "Needs an offer"],
    ["needs_offer", null, "Needs an offer"],
    ["offer_follow_up_overdue", ago(3 * DAY), "Offer follow-up 3d overdue"],
    ["offer_follow_up_overdue", null, "Offer follow-up overdue"],
    ["missed_callback", ago(30 * DAY), "Missed callback (30 days ago)"],
    ["missed_callback", ago(8 * DAY), "Missed callback (8 days ago)"],
    ["missed_callback", null, "Missed callback (today)"],
    ["hot_going_cold", ago(4 * DAY), "Hot, no touch in 4d"],
    ["hot_going_cold", null, "Hot, not touched yet"],
    ["warm_going_cold", ago(5 * DAY), "Warm, no touch in 5d"],
    ["warm_going_cold", null, "Warm, not touched yet"],
    ["longest_since_touch", ago(12 * DAY), "Longest since last touch · 12d"],
    ["longest_since_touch", null, "Not touched yet"],
  ] as const)("%s at %s reads %s", (reason, at, expected) => {
    expect(reasonLabel(reason, at, NOW)).toBe(expected);
  });

  it("names a later due date when the callback is not today (America/Chicago)", () => {
    expect(reasonLabel("appointment_due", "2026-10-06T14:00:00Z", NOW)).toBe("Callback due Oct 6, 9:00 AM");
  });

  it("treats a Chicago evening as the same day even when UTC has rolled over", () => {
    const evening = new Date("2026-10-06T02:30:00Z"); // 9:30 PM Oct 5 Chicago
    expect(reasonLabel("appointment_due", "2026-10-06T03:00:00Z", evening)).toBe("Callback due 10:00 PM");
  });

  it("never returns a negative or zero age", () => {
    expect(compactAge(-5 * HOUR)).toBe("1m");
    expect(longAge(-1)).toBe("1 minute");
    expect(reasonLabel("inbound_text", ahead(HOUR), NOW)).toBe("Texted you 1m ago");
  });
});
