import { describe, expect, it } from "vitest";

import { NINE_REPEAT_NOT_INTERESTED_RULE } from "@/lib/sms-classification/nine-questions";

import { isNineDeferrableNotSent, secondsUntilNineSendWindow } from "./dispatch";

// Kansas City (MO, area code 816): Central time. 2026-10-20 is CDT (UTC-5).
const MO_PHONE = "+18165550100";
const at = (iso: string) => new Date(iso);

describe("isNineDeferrableNotSent (only a closed send window defers)", () => {
  it.each([
    ["reply_ineligible", "outside_business_hours", true], // A
    ["quiet_hours_recipient:outside_window", undefined, true], // B
    ["delay_not_applied", undefined, true], // C
    ["reply_ineligible", "max_turns_reached", false],
    ["reply_ineligible", undefined, false],
    ["quiet_hours_recipient:florida_cap", undefined, false],
    ["quiet_hours_recipient:unknown_recipient_state", undefined, false],
    ["delay_not_configured", undefined, false],
    ["delay_unavailable", undefined, false],
    ["template_already_sent", undefined, false],
    ["outbound_mode_hold", undefined, false],
  ] as Array<[string, string | undefined, boolean]>)("%s (%s) -> %s", (why, skip, expected) => {
    expect(isNineDeferrableNotSent(why, skip)).toBe(expected);
  });
});

describe("secondsUntilNineSendWindow", () => {
  it("late evening: waits until just after 8am local the next morning", () => {
    // 22:00 CDT = 03:00Z. 8:00 CDT next day = 13:00Z: 10h away; first 15-min step at/after it + 5 min.
    const s = secondsUntilNineSendWindow("MO", MO_PHONE, at("2026-10-21T03:00:00Z"));
    expect(s).toBe(10 * 3600 + 5 * 60);
  });

  it("early morning: waits until the window opens the same day", () => {
    // 06:10 CDT = 11:10Z. Opens 13:00Z; steps land at 13:10Z (+5 min buffer).
    const s = secondsUntilNineSendWindow("MO", MO_PHONE, at("2026-10-20T11:10:00Z"));
    expect(s).toBe((2 * 3600) + 5 * 60);
  });

  it("window already open (the delay clamp near the edge): re-dispatches after one short step", () => {
    const s = secondsUntilNineSendWindow("MO", MO_PHONE, at("2026-10-20T17:00:00Z"));
    expect(s).toBe(15 * 60 + 5 * 60);
  });

  it("both windows must be open: a Pacific recipient for a Missouri property waits for 8am Pacific", () => {
    // 06:00 CDT = 11:00Z; MO opens 13:00Z, LA (213, PDT UTC-7) opens 15:00Z.
    const s = secondsUntilNineSendWindow("MO", "+12135550100", at("2026-10-20T11:00:00Z"));
    expect(s).toBe(4 * 3600 + 5 * 60);
  });

  it("unknown state or area code: cannot be computed (the caller holds as before)", () => {
    expect(secondsUntilNineSendWindow(null, MO_PHONE, at("2026-10-21T03:00:00Z"))).toBeNull();
    expect(secondsUntilNineSendWindow("MO", null, at("2026-10-21T03:00:00Z"))).toBeNull();
  });
});

describe("repeat-no rule text", () => {
  it("is Jarrad's approved wording, character for character", () => {
    expect(NINE_REPEAT_NOT_INTERESTED_RULE).toBe(
      "If the homeowner says no again after already getting our not-interested reply, stop their drip, mark them Not interested, and send nothing.",
    );
  });
});
