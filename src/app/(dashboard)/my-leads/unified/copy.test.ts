import { describe, expect, it } from "vitest";
import {
  agoLabel, brokenLines, brokenText, CHIP_WORDS, chipLabel, dateLabel, dripLine, expandedLines, labelChips,
  REASON_TONE, rowHeadline, timeLabel, whenLabel,
} from "./copy";
import type { LastTouchKind, WorkDrip, WorkReason } from "./contract";
import { NOW, workFacts } from "./test-support";

// NOW = Wed 2026-10-14 1:00 PM Central.
const drip = (over: Partial<WorkDrip> = {}): WorkDrip => ({
  enrollmentId: "e1", status: "active", pauseReason: null, name: "Warm check-in", step: 1, stepsTotal: 4,
  nextRunAt: "2026-10-16T15:00:00Z", completedAt: null, lastSentAt: null, healthy: true, ...over,
});
const text = (reason: WorkReason, rowNo: string, headline: Record<string, unknown>, over = {}) =>
  rowHeadline(workFacts(reason, rowNo, headline, over), NOW).text;

describe("time helpers", () => {
  it("renders in America/Chicago", () => {
    expect(timeLabel("2026-10-14T19:30:00Z")).toBe("2:30 PM");
    expect(timeLabel("2026-12-01T15:30:00Z")).toBe("9:30 AM"); // CST
  });
  it("whenLabel covers today, tomorrow, within a week, yesterday and far dates", () => {
    expect(whenLabel("2026-10-14T19:30:00Z", NOW)).toBe("2:30 PM");
    expect(whenLabel("2026-10-14T19:30:00Z", NOW, { todayPrefix: true })).toBe("today 2:30 PM");
    expect(whenLabel("2026-10-15T14:00:00Z", NOW)).toBe("tomorrow 9:00 AM");
    expect(whenLabel("2026-10-16T15:00:00Z", NOW)).toBe("Fri 10:00 AM");
    expect(whenLabel("2026-10-13T19:30:00Z", NOW)).toBe("yesterday 2:30 PM");
    expect(whenLabel("2026-10-20T14:00:00Z", NOW)).toBe("Oct 20 9:00 AM");
    expect(whenLabel("2027-01-05T15:00:00Z", NOW)).toBe("Jan 5, 2027 9:00 AM");
  });
  it("uses the Chicago day, not the UTC day", () => {
    // 2026-10-15 02:00Z is still Oct 14 9 PM in Chicago.
    expect(whenLabel("2026-10-15T02:00:00Z", NOW)).toBe("9:00 PM");
  });
  it("agoLabel", () => {
    expect(agoLabel("2026-10-14T17:59:40Z", NOW)).toBe("just now");
    expect(agoLabel("2026-10-14T17:58:00Z", NOW)).toBe("2m ago");
    expect(agoLabel("2026-10-14T15:00:00Z", NOW)).toBe("3h ago");
    expect(agoLabel("2026-10-12T15:00:00Z", NOW)).toBe("2d ago");
  });
  it("dateLabel", () => {
    expect(dateLabel("2026-10-20T14:00:00Z", NOW)).toBe("Oct 20");
  });
});

describe("rowHeadline: every text starts with its chip word", () => {
  it("New lead", () => {
    expect(text("new_lead", "3", { assignedAt: "2026-10-14T15:00:00Z", firstCallOverdue: false })).toBe("New lead · assigned today, not called yet");
    expect(text("new_lead", "3", { assignedAt: "2026-10-12T15:00:00Z", firstCallOverdue: true })).toBe("New lead · assigned 2d ago, not called yet · first call overdue");
    expect(text("new_lead", "3", { assignedAt: null, firstCallOverdue: false })).toBe("New lead · not called yet");
  });
  it("Call today", () => {
    expect(text("call_today", "2", { pinnedAt: "2026-10-14T13:05:00Z" })).toBe("Call today · you pinned this at 8:05 AM");
    expect(text("call_today", "2", { pinnedAt: "2026-10-13T13:05:00Z" })).toBe("Call today · you pinned this yesterday 8:05 AM");
  });
  it("Due", () => {
    expect(text("due", "4", { at: "2026-10-14T19:30:00Z", soon: true })).toBe("Due soon · callback 2:30 PM");
    expect(text("due", "4", { at: "2026-10-14T14:30:00Z", soon: false })).toBe("Due · callback 9:30 AM");
    expect(text("due", "4", { at: "2026-10-14T17:50:00Z", soon: false })).toBe("Due · callback 10 min overdue");
    expect(text("due", "4", { at: "2026-10-12T17:50:00Z", soon: false })).toBe("Due · callback 2 days overdue");
    expect(text("due", "4", { at: "2026-10-13T17:50:00Z", soon: false })).toBe("Due · callback 1 day overdue");
    expect(text("due", "9", { at: "2026-10-05T17:50:00Z", overdueDays: 9 })).toBe("Due · callback 9 days overdue");
  });
  it("Due: kind word from the task and (snoozed)", () => {
    expect(text("due", "4", { at: "2026-10-14T19:30:00Z", soon: true, taskKind: "appointment", snoozed: false })).toBe("Due soon · appointment 2:30 PM");
    expect(text("due", "4", { at: "2026-10-14T17:35:00Z", soon: false, taskKind: "callback", snoozed: false })).toBe("Due · callback 25 min overdue");
    expect(text("due", "4", { at: "2026-10-14T17:35:00Z", soon: false, taskKind: "offer_follow_up", snoozed: false })).toBe("Due · offer follow-up 25 min overdue");
    expect(text("due", "4", { at: "2026-10-14T19:30:00Z", soon: true, taskKind: "callback", snoozed: true })).toBe("Due soon · callback 2:30 PM (snoozed)");
    expect(text("due", "9", { at: "2026-10-05T17:50:00Z", overdueDays: 9, taskKind: "appointment", snoozed: true })).toBe("Due · appointment 9 days overdue (snoozed)");
    expect(text("callback_booked", "11", { kind: "callback_booked", at: "2026-10-15T14:00:00Z", taskKind: "callback", snoozed: true })).toBe("Callback booked · tomorrow 9:00 AM (snoozed)");
  });
  it("New reply", () => {
    expect(text("new_reply", "5", { at: "2026-10-14T14:12:00Z", kind: "text" })).toBe("New reply · today 9:12 AM");
    expect(text("new_reply", "5", { at: "2026-10-14T14:12:00Z", kind: "call" })).toBe("New reply · missed call 9:12 AM");
  });
  it("Broken, one line per kind (design 2.1)", () => {
    const d = drip({ step: 2, stepsTotal: 4, status: "paused", pauseReason: "provider_failed" });
    const f = (kind: string) => rowHeadline(workFacts("broken", "6", { kind, action: "review", at: null }, { drip: d }), NOW).text;
    expect(f("drip_paused")).toBe("Broken · drip couldn't send text 2 of 4");
    expect(f("drip_stuck")).toBe("Broken · drip is stuck");
    expect(f("followup_text_not_sent")).toBe("Broken · follow-up text not sent");
    expect(f("followup_text_not_delivered")).toBe("Broken · follow-up text didn't deliver");
    expect(f("followup_text_status_unknown")).toBe("Broken · follow-up text status unknown");
    expect(f("text_not_sent")).toBe("Broken · text didn't send");
    expect(f("text_not_delivered")).toBe("Broken · text didn't deliver");
    expect(f("text_status_unknown")).toBe("Broken · text status unknown");
    expect(f("scheduled_text_overdue")).toBe("Broken · scheduled text overdue");
    expect(f("ai_reply_failed")).toBe("Broken · AI reply failed");
    expect(f("norma_needs_review")).toBe("Broken · Norma call needs review");
    expect(brokenText("drip_paused", { drip: null })).toBe("drip couldn't send a text");
  });
  it("Offer", () => {
    expect(text("offer", "7", { kind: "ready", since: "2026-10-12T17:00:00Z" })).toBe("Offer · you marked them ready 2 days ago");
    expect(text("offer", "7", { kind: "ready", since: "2026-10-14T17:00:00Z" })).toBe("Offer · you marked them ready today");
    expect(text("offer", "8", { kind: "follow_up_due", at: "2026-10-14T14:00:00Z" })).toBe("Offer · follow-up due 9:00 AM");
    expect(text("offer", "8", { kind: "follow_up_missing", at: null })).toBe("Offer · follow-up missing");
  });
  it("Gone quiet", () => {
    expect(text("gone_quiet", "14", { kind: "texted_silent", at: "2026-10-11T15:00:00Z", since: "2026-10-11T15:00:00Z" })).toBe("Gone quiet · no reply in 3 business days");
    expect(text("gone_quiet", "14", { kind: "drip_finished", at: "2026-10-01T15:00:00Z", since: "2026-10-01T14:00:00Z" })).toBe("Gone quiet · drip finished Oct 1, no reply in 13 days");
  });
  it("Nothing planned", () => {
    expect(text("nothing_planned", "15", { variant: null })).toBe("Nothing planned");
    expect(text("nothing_planned", "15", { variant: "check_texts" })).toBe("Nothing planned (check texts)");
    expect(text("nothing_planned", "6a", { variant: "text_waiting", at: "2026-10-14T15:00:00Z" })).toBe("Nothing planned (Text waiting for you to send)");
  });
  it("In a drip", () => {
    const starts = drip({ step: 1 });
    expect(text("in_drip", "10", { nextRunAt: starts.nextRunAt }, { drip: starts })).toBe("In a drip · Warm check-in · starts Fri 10:00 AM · text 1 of 4");
    const running = drip({ step: 3, lastSentAt: "2026-10-12T15:00:00Z", nextRunAt: "2026-10-16T15:00:00Z" });
    expect(text("in_drip", "10", { nextRunAt: running.nextRunAt }, { drip: running })).toBe("In a drip · Warm check-in · text 2 of 4 sent Mon · next Fri 10:00 AM");
    const nurture = drip({ step: 2, lastSentAt: "2026-08-15T15:00:00Z", nextRunAt: "2026-12-14T16:00:00Z" });
    expect(text("in_drip", "10", { nextRunAt: nurture.nextRunAt }, { drip: nurture })).toBe("In a drip · Warm check-in · text 1 of 4 sent Aug 15 · next Dec 14 10:00 AM");
    expect(text("in_drip", "10", { nextRunAt: null, scheduledAt: "2026-10-16T14:00:00Z" })).toBe("In a drip · Text scheduled Fri 9:00 AM");
    expect(text("in_drip", "10", { nextRunAt: null, scheduledAt: "2026-10-20T14:00:00Z" })).toBe("In a drip · Text scheduled Oct 20 9:00 AM");
    expect(text("in_drip", "10", { nextRunAt: null, callInProgress: true, resumeBy: "2026-10-14T19:30:00Z" }, { drip: drip({ nextRunAt: null }) })).toBe("In a drip · call in progress, resumes by 2:30 PM");
  });
  it("Texted last, by who", () => {
    expect(text("texted_last", "13", { at: "2026-10-14T15:00:00Z", by: "human" })).toBe("Texted last · you texted 3h ago");
    expect(text("texted_last", "13", { at: "2026-10-14T17:58:00Z", by: "ai" })).toBe("Texted last · Sandra replied 2m ago");
    expect(text("texted_last", "13", { at: "2026-10-14T15:00:00Z", by: "campaign" })).toBe("Texted last · campaign text sent 3h ago");
  });
  it("Offer out and Callback booked", () => {
    expect(text("offer_out", "12", { at: "2026-10-20T14:00:00Z" })).toBe("Offer out · follow-up Oct 20");
    expect(text("offer_out", "11", { kind: "offer_out", at: "2026-10-20T14:00:00Z" })).toBe("Offer out · follow-up Oct 20");
    expect(text("callback_booked", "11", { kind: "callback_booked", at: "2026-10-16T15:00:00Z" })).toBe("Callback booked · Fri 10:00 AM");
    expect(text("callback_booked", "11", { kind: "callback_booked", at: "2026-10-15T14:00:00Z" })).toBe("Callback booked · tomorrow 9:00 AM");
  });
  it("Under contract", () => {
    expect(text("under_contract", "1", {}, { contractSignedAt: "2026-10-02T15:00:00Z" })).toBe("Under contract · signed Oct 2");
    expect(text("under_contract", "1", {}, { contractSignedAt: null })).toBe("Under contract");
  });
  it("each reason's text starts with its chip word and carries its tone", () => {
    const samples: [WorkReason, string, Record<string, unknown>][] = [
      ["new_lead", "3", {}], ["call_today", "2", {}], ["due", "4", { at: null }], ["new_reply", "5", {}], ["broken", "6", {}],
      ["offer", "7", {}], ["gone_quiet", "14", {}], ["nothing_planned", "15", {}], ["in_drip", "10", {}],
      ["texted_last", "13", {}], ["offer_out", "12", {}], ["callback_booked", "11", {}], ["under_contract", "1", {}],
    ];
    for (const [reason, rowNo, headline] of samples) {
      const result = rowHeadline(workFacts(reason, rowNo, headline), NOW);
      expect(result.chipWord).toBe(CHIP_WORDS[reason]);
      expect(result.text.startsWith(result.chipWord)).toBe(true);
      expect(result.tone).toBe(REASON_TONE[reason]);
    }
  });
  it("tolerates a malformed headline", () => {
    expect(() => rowHeadline(workFacts("due", "4", { at: 5 }), NOW)).not.toThrow();
    expect(() => rowHeadline(workFacts("new_reply", "5", { at: "not a date" }), NOW)).not.toThrow();
  });
  it("never says Not today", () => {
    expect(JSON.stringify(Object.values(CHIP_WORDS))).not.toMatch(/not today/i);
  });
});

describe("chipLabel", () => {
  it("names the catch-all chip per tab", () => {
    expect(chipLabel("all", "needs_attention")).toBe("All reasons");
    expect(chipLabel("all", "waiting")).toBe("All waiting");
    expect(chipLabel("in_drip", "waiting")).toBe("In a drip");
  });
});

describe("labelChips", () => {
  it("renders the label chips and leaves out ones the bold line already says", () => {
    const f = workFacts("due", "4", {}, {
      labels: ["norma_calling", "norma_task", "do_not_contact", "text_waiting", "check_texts", "broken", "ai_draft_waiting", "no_phone"],
      broken: [{ kind: "text_not_sent", action: "resend", at: null, refId: "x" }],
    });
    expect(labelChips(f).map((c) => c.text)).toEqual([
      "Norma calling", "Norma task", "Do not contact", "Text waiting for you to send", "check texts",
      "Broken · text didn't send", "AI reply needs your OK", "No phone",
    ]);
    expect(labelChips(workFacts("nothing_planned", "6a", { variant: "text_waiting" }, { labels: ["text_waiting"] }))).toEqual([]);
    expect(labelChips(workFacts("nothing_planned", "15", { variant: "check_texts" }, { labels: ["check_texts"] }))).toEqual([]);
    expect(labelChips(workFacts("broken", "6", {}, { labels: ["broken"], broken: [{ kind: "drip_stuck", action: "fix_drip", at: null, refId: null }] }))).toEqual([]);
  });
});

describe("expandedLines", () => {
  const labels = (f: ReturnType<typeof workFacts>) => expandedLines(f, NOW).map((l) => l.label);
  it("has DRIP, NEXT STEP, LAST TOUCH, ATTEMPTS and MOTIVATION; CLEARS only on Call today", () => {
    expect(labels(workFacts("due", "4"))).toEqual(["DRIP", "NEXT STEP", "LAST TOUCH", "ATTEMPTS", "MOTIVATION"]);
    expect(labels(workFacts("call_today", "2"))).toEqual(["DRIP", "NEXT STEP", "LAST TOUCH", "ATTEMPTS", "MOTIVATION", "CLEARS"]);
  });
  it("swaps MOTIVATION for a PHONE warning", () => {
    const noPhone = expandedLines(workFacts("due", "4", {}, { hasPhone: false }), NOW);
    expect(noPhone.map((l) => l.label)).toContain("PHONE");
    expect(noPhone.map((l) => l.label)).not.toContain("MOTIVATION");
    expect(noPhone.find((l) => l.label === "PHONE")?.text).toBe("No phone number");
    const dnc = expandedLines(workFacts("due", "4", {}, { contactDnc: true }), NOW);
    expect(dnc.find((l) => l.label === "PHONE")?.text).toBe("Do not contact");
  });
  it("formats attempts, last touch, next step and motivation", () => {
    const f = workFacts("due", "4", {}, {
      attemptsCount: 3, assignedAt: "2026-10-11T15:00:00Z", lastTouchAt: "2026-10-14T15:00:00Z",
      nextStep: { callbackAt: "2026-10-16T15:00:00Z", offerFollowUpAt: "2026-10-20T14:00:00Z" },
    });
    f.row = { ...f.row, temperature: "warm", motivationKind: "specified", motivationText: "Wants out by spring" };
    const lines = Object.fromEntries(expandedLines(f, NOW).map((l) => [l.label, l.text]));
    expect(lines["ATTEMPTS"]).toBe("3 attempts · assigned 3d ago");
    expect(lines["LAST TOUCH"]).toBe("3h ago");
    expect(lines["NEXT STEP"]).toBe("Callback Fri 10:00 AM · Offer follow-up Oct 20 9:00 AM");
    expect(lines["MOTIVATION"]).toBe("Warm · Wants out by spring");
    const bare = Object.fromEntries(expandedLines(workFacts("due", "4", {}, { attemptsCount: 1 }), NOW).map((l) => [l.label, l.text]));
    expect(bare["ATTEMPTS"]).toBe("1 attempt · assigned 3d ago");
    expect(bare["NEXT STEP"]).toBe("None");
    expect(bare["LAST TOUCH"]).toBe("none yet");
  });
  it("LAST TOUCH uses the owner's phrases", () => {
    const touch = (kind: LastTouchKind, at: string) =>
      Object.fromEntries(expandedLines(workFacts("due", "4", {}, { lastTouch: { kind, at } }), NOW).map((l) => [l.label, l.text]))["LAST TOUCH"];
    expect(touch("your_text", "2026-10-14T15:00:00Z")).toBe("your text · 3h ago");
    expect(touch("sandra_reply", "2026-10-14T15:00:00Z")).toBe("Sandra's reply · 3h ago");
    expect(touch("drip_text", "2026-10-12T15:00:00Z")).toBe("drip text · Mon");
    expect(touch("campaign_text", "2026-10-12T15:00:00Z")).toBe("campaign text · Mon");
    expect(touch("call_reached", "2026-10-12T15:00:00Z")).toBe("call, reached · 2d ago");
    expect(touch("call_no_answer", "2026-10-11T15:00:00Z")).toBe("call, no answer · 3d ago");
    expect(touch("voicemail", "2026-10-13T15:00:00Z")).toBe("voicemail · 1d ago");
    expect(touch("note", "2026-10-12T15:00:00Z")).toBe("note · 2d ago");
    expect(touch("other", "2026-10-12T15:00:00Z")).toBe("2d ago");
  });
  it("CLEARS reads as the owner wrote it", () => {
    const lines = expandedLines(workFacts("call_today", "2"), NOW);
    expect(lines.find((l) => l.label === "CLEARS")?.text).toBe("when you log the call · Undo");
  });
});

describe("dripLine", () => {
  const f = (d: WorkDrip | null, over = {}) => dripLine(workFacts("nothing_planned", "15", {}, { drip: d, ...over }), NOW);
  const paused = (pauseReason: string | null, over = {}) => f(drip({ status: "paused", pauseReason, step: 2 }), over);
  it("none, starts, running", () => {
    expect(f(null)).toBe("none");
    expect(f(drip({ step: 1 }))).toBe("starts Fri 10:00 AM · Warm check-in");
    expect(f(drip({ step: 2, lastSentAt: "2026-10-12T15:00:00Z" }))).toBe("running · text 2 of 4 · next Fri 10:00 AM");
    expect(f(drip({ nextRunAt: null }))).toBe("running");
  });
  it("paused phrases", () => {
    expect(paused("inbound_reply")).toBe("paused — they replied");
    expect(paused("appointment_booked")).toBe("paused — callback booked");
    expect(paused("call_in_progress")).toBe("paused while you call");
    expect(paused("manual")).toBe("paused by you");
    expect(paused("rep_sms_human_takeover")).toBe("paused by you");
    expect(paused("norma_call")).toBe("paused — Norma call");
    expect(paused("person_took_over")).toBe("paused — needs a person");
    expect(paused("status_terminal")).toBe("paused");
  });
  it("stopped on a problem, finished and opted out", () => {
    expect(paused("provider_failed")).toBe("stopped on a problem");
    expect(paused("inbound_reply", { broken: [{ kind: "drip_paused", action: "fix_drip", at: null, refId: "e1" }] })).toBe("stopped on a problem");
    expect(f(drip({ status: "completed", completedAt: "2026-10-01T15:00:00Z" }))).toBe("finished Oct 1, no reply");
    expect(f(drip({ status: "opted_out" }))).toBe("stopped, seller opted out");
  });
});

describe("brokenLines", () => {
  it("lists every item", () => {
    const f = workFacts("broken", "6", {}, {
      broken: [
        { kind: "text_not_delivered", action: "resend", at: "2026-10-14T15:00:00Z", refId: "a" },
        { kind: "norma_needs_review", action: "review", at: null, refId: null },
      ],
    });
    expect(brokenLines(f, NOW).map((l) => l.text)).toEqual(["text didn't deliver · today 10:00 AM", "Norma call needs review"]);
  });
});
