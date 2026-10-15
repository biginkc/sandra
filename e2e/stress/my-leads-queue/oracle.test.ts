import { describe, expect, it } from "vitest";

import { DAY, HOUR, MIN, SEC, emptyLead, type Lead, type Msg } from "./model";
import { addBusinessDays, expectedViews, fromChicagoLocal, isHandled, minusChicagoDays, place } from "./oracle";

const NOW = Date.UTC(2026, 9, 14, 17, 0, 0); // Wed 2026-10-14 12:00 CDT
const lead = (over: Partial<Lead> = {}) => emptyLead("t", NOW, over);
const inb = (ref: string, ago: number, extra: Partial<Msg> = {}): Msg => ({ ref, dir: "inbound", at: NOW - ago, body: "hi", ...extra });
const out = (ref: string, ago: number, extra: Partial<Msg> = {}): Msg => ({ ref, dir: "outbound", at: NOW - ago, body: "hi", source: "human", outcome: "sent", ...extra });
const where = (l: Lead, at = NOW) => { const p = place(l, at); return `${p.place}/${p.reason}/${p.row}`; };

describe("business days (Chicago wall clock)", () => {
  const fri4pm = Date.UTC(2026, 9, 16, 21, 0, 0);
  it("a Friday 4 PM text comes back Wednesday 4 PM", () => expect(new Date(addBusinessDays(fri4pm, 3)).toISOString()).toBe("2026-10-21T21:00:00.000Z"));
  it("Monday -> Thursday, Saturday -> Wednesday", () => {
    expect(new Date(addBusinessDays(Date.UTC(2026, 9, 12, 15), 3)).toISOString()).toBe("2026-10-15T15:00:00.000Z");
    expect(new Date(addBusinessDays(Date.UTC(2026, 9, 17, 15), 3)).toISOString()).toBe("2026-10-21T15:00:00.000Z");
  });
  it("is wall-clock across both DST changes, not 72 hours", () => {
    expect(new Date(addBusinessDays(Date.UTC(2026, 9, 30, 21), 3)).toISOString()).toBe("2026-11-04T22:00:00.000Z");
    expect(new Date(addBusinessDays(Date.UTC(2027, 2, 12, 22), 3)).toISOString()).toBe("2027-03-17T21:00:00.000Z");
  });
  it("round-trips Chicago wall clock", () => {
    expect(new Date(fromChicagoLocal({ y: 2026, mo: 11, d: 4, h: 16, mi: 0, s: 0, ms: 0 })).toISOString()).toBe("2026-11-04T22:00:00.000Z");
    expect(new Date(minusChicagoDays(Date.UTC(2026, 10, 5, 22), 7)).toISOString()).toBe("2026-10-29T21:00:00.000Z"); // crosses fall-back: wall clock, not 168 h
  });
});

describe("placement table 1.1", () => {
  it("row 1: under contract, nothing due is Neither", () => expect(where(lead({ stage: "under_contract" }))).toBe("neither/under_contract/1"));
  it("row 1: an overdue/near callback pulls it out (row 4)", () =>
    expect(where(lead({ stage: "under_contract", appointments: [{ ref: "a", due: NOW + 10 * MIN, status: "open" }] }))).toBe("your_move/due/4"));
  it("row 1 (v9 SQ1): any active appointment, even a future one, takes it out of Neither", () =>
    expect(where(lead({ stage: "under_contract", appointments: [{ ref: "a", due: NOW + DAY, status: "open" }] }))).toBe("their_move/callback_booked/11"));
  it("row 2: pin without expiry, cleared by a later attempt", () => {
    const pin = { pinnedAt: NOW - 2 * HOUR, until: null };
    expect(where(lead({ pin }))).toBe("your_move/call_today/2");
    expect(where(lead({ pin, attempts: [{ at: NOW - HOUR, outcome: "no_answer" }] }))).toBe("your_move/nothing_planned/15");
    expect(where(lead({ pin: { pinnedAt: NOW - 9 * HOUR, until: NOW - HOUR } }))).toBe("your_move/nothing_planned/15");
  });
  it("row 3: new lead", () => expect(where(lead({ stage: "not_contacted", attempts: [] }))).toBe("your_move/new_lead/3"));
  it("row 4 boundary: callback due at now+15 min is Due, one second later is Waiting", () => {
    expect(where(lead({ appointments: [{ ref: "a", due: NOW + 15 * MIN, status: "open" }] }))).toBe("your_move/due/4");
    expect(where(lead({ appointments: [{ ref: "a", due: NOW + 15 * MIN + SEC, status: "open" }] }))).toBe("their_move/callback_booked/11");
  });
  it("rows 4/9: 7 Chicago days splits Due from missed callback (both Your move · Due)", () => {
    expect(place(lead({ appointments: [{ ref: "a", due: NOW - 6 * DAY, status: "open" }] }), NOW).row).toBe("4");
    expect(place(lead({ appointments: [{ ref: "a", due: NOW - 9 * DAY, status: "open" }] }), NOW)).toMatchObject({ row: "9", headline: { overdueDays: 9 } });
  });
  it("snooze moves the effective time and never removes the callback", () => {
    expect(where(lead({ appointments: [{ ref: "a", due: NOW - HOUR, status: "snoozed", snoozedUntil: NOW + DAY }] }))).toBe("their_move/callback_booked/11");
    expect(where(lead({ appointments: [{ ref: "a", due: NOW - DAY, status: "snoozed", snoozedUntil: NOW - 10 * MIN }], enrollment: { status: "active", nextRunAt: NOW + HOUR, updatedAt: NOW, enrolledAt: NOW - DAY, enrolledBy: "none", steps: 4, step: 1 } }))).toBe("your_move/due/4");
  });
  it("row 5 beats automation; row 4 beats row 5", () => {
    const drip = { status: "active" as const, nextRunAt: NOW + HOUR, updatedAt: NOW, enrolledAt: NOW - DAY, enrolledBy: "none" as const, steps: 4, step: 1 };
    expect(where(lead({ messages: [inb("i", 3 * HOUR)], enrollment: drip }))).toBe("your_move/new_reply/5");
    expect(where(lead({ messages: [inb("i", 3 * HOUR)], appointments: [{ ref: "a", due: NOW - HOUR, status: "open" }] }))).toBe("your_move/due/4");
  });
  it("row 6: Broken only when no unhandled inbound; row 6a manual queued text", () => {
    expect(where(lead({ enrollment: { status: "paused", pause: "provider_failed", nextRunAt: null, updatedAt: NOW, enrolledAt: NOW - DAY, enrolledBy: "none", steps: 4, step: 1 } }))).toBe("your_move/broken/6");
    expect(where(lead({ messages: [out("q", HOUR, { outcome: "queued" })] }))).toBe("your_move/nothing_planned/6a");
    expect(where(lead({ messages: [out("q", HOUR, { outcome: "queued" })], appointments: [{ ref: "a", due: NOW + DAY, status: "open" }] }))).toBe("your_move/nothing_planned/6a");
  });
  it("rows 7/8/12: offers", () => {
    expect(where(lead({ stage: "needs_offer" }))).toBe("your_move/offer/7");
    const base = { stage: "offer_sent" as const };
    const offer = (f: number, hasChain: boolean) => ({ sentAt: NOW - 3 * DAY, followUpAt: f, outcome: "pending" as const, hasChain });
    expect(where(lead({ ...base, offer: offer(NOW - HOUR, false) }))).toBe("your_move/offer/8");
    expect(where(lead({ ...base, offer: offer(NOW + 5 * DAY, true), appointments: [{ ref: "c", due: NOW + 5 * DAY, status: "open", offerChain: true }] }))).toBe("their_move/offer_out/12");
    expect(place(lead({ ...base, offer: offer(NOW + 5 * DAY, true), appointments: [{ ref: "c", due: NOW + 5 * DAY, status: "completed", offerChain: true }] }), NOW)).toMatchObject({ row: "8", headline: { kind: "follow_up_missing" } });
    // chain task due exactly at +15 min is due, +1 s is Offer out
    expect(where(lead({ ...base, offer: offer(0, true), appointments: [{ ref: "c", due: NOW + 15 * MIN, status: "open", offerChain: true }] }))).toBe("your_move/offer/8");
    expect(where(lead({ ...base, offer: offer(0, true), appointments: [{ ref: "c", due: NOW + 15 * MIN + SEC, status: "open", offerChain: true }] }))).toBe("their_move/offer_out/12");
  });
  it("row 11: offer follow-up earlier than a callback names the offer", () => {
    const l = lead({ stage: "offer_sent", offer: { sentAt: NOW - DAY, followUpAt: NOW + 2 * DAY, outcome: "pending", hasChain: true },
      appointments: [{ ref: "c", due: NOW + 2 * DAY, status: "open", offerChain: true }, { ref: "cb", due: NOW + 3 * DAY, status: "open" }] });
    expect(where(l)).toBe("their_move/offer_out/11");
  });
  it("row 10: healthy drip, with the 60 min / 15 min / 30 min limits", () => {
    const en = (o: Partial<NonNullable<Lead["enrollment"]>>) => lead({ enrollment: { status: "active", nextRunAt: NOW + HOUR, updatedAt: NOW, enrolledAt: NOW - DAY, enrolledBy: "none", steps: 4, step: 1, ...o } });
    expect(where(en({}))).toBe("their_move/in_drip/10");
    expect(where(en({ nextRunAt: NOW - 30 * MIN }))).toBe("their_move/in_drip/10");
    expect(where(en({ nextRunAt: NOW - 90 * MIN }))).toBe("your_move/broken/6");
    expect(where(en({ nextRunAt: null }))).toBe("your_move/nothing_planned/15");
    expect(where(en({ claimAt: NOW - 20 * MIN }))).toBe("your_move/broken/6");
    expect(where(en({ status: "paused", pause: "call_in_progress", nextRunAt: null, updatedAt: NOW - 5 * MIN }))).toBe("their_move/in_drip/10");
    expect(where(en({ status: "paused", pause: "call_in_progress", nextRunAt: null, updatedAt: NOW - 45 * MIN }))).toBe("your_move/broken/6");
    for (const pause of ["norma_call", "manual", "inbound_reply", "appointment_booked", "person_took_over", "terminal_dispo"])
      expect(where(en({ status: "paused", pause, nextRunAt: null }))).toBe("your_move/nothing_planned/15");
  });
  it("rows 13/14: Friday 4 PM text across Monday and Wednesday", () => {
    const sent = Date.UTC(2026, 9, 16, 21);
    const l = lead({ messages: [out("o", 0, { at: sent })] });
    expect(where(l, Date.UTC(2026, 9, 19, 14))).toBe("their_move/texted_last/13");
    expect(where(l, Date.UTC(2026, 9, 21, 20, 59, 59))).toBe("their_move/texted_last/13");
    expect(where(l, Date.UTC(2026, 9, 21, 21, 0, 1))).toBe("your_move/gone_quiet/14");
  });
  it("row 14: completed drip with no reply is Gone quiet; a later human text brings it back to Texted last", () => {
    const en = { status: "completed" as const, nextRunAt: null, updatedAt: NOW - 13 * DAY, enrolledAt: NOW - 30 * DAY, completedAt: NOW - 13 * DAY, enrolledBy: "none" as const, steps: 4, step: 4 };
    const drip = out("d", 13 * DAY, { source: "drip", dripFinal: true });
    expect(where(lead({ enrollment: en, messages: [drip] }))).toBe("your_move/gone_quiet/14");
    expect(where(lead({ enrollment: en, messages: [drip, out("h", DAY)] }))).toBe("their_move/texted_last/13");
    expect(where(lead({ enrollment: en, messages: [{ ...drip, dripFinal: false }] }))).toBe("your_move/nothing_planned/15");
  });
  it("row 13 excludes drip and norma pre-call texts", () => {
    expect(where(lead({ messages: [out("d", HOUR, { source: "drip" })] }))).toBe("your_move/nothing_planned/15");
    expect(where(lead({ messages: [out("n", HOUR, { source: "norma_precall" })] }))).toBe("your_move/nothing_planned/15");
  });
  it("campaign text: queued future is In a drip, overdue is Broken, sent is Texted last", () => {
    expect(where(lead({ messages: [out("c", 0, { source: "campaign", outcome: "queued", scheduledFor: NOW + DAY })] }))).toBe("their_move/in_drip/10");
    expect(where(lead({ messages: [out("c", 0, { source: "campaign", outcome: "queued", scheduledFor: NOW - 45 * MIN })] }))).toBe("your_move/broken/6");
    expect(where(lead({ messages: [out("c", HOUR, { source: "campaign" })] }))).toBe("their_move/texted_last/13");
  });
  it("an exhaustive row 15", () => expect(where(lead())).toBe("your_move/nothing_planned/15"));
});

describe("handled-reply rule (5)", () => {
  const unhandled = (l: Lead) => place(l, NOW).row === "5";
  const reply = (extra: Partial<Lead> = {}) => lead({ messages: [inb("i", 3 * HOUR)], ...extra });
  it.each([
    ["human text", { messages: [inb("i", 3 * HOUR), out("o", HOUR)] }],
    ["approved held draft", { messages: [inb("i", 3 * HOUR), out("o", HOUR, { source: "approved_draft" })] }],
    ["AI template", { messages: [inb("i", 3 * HOUR), out("o", HOUR, { source: "ai_template" })] }],
    ["AI written", { messages: [inb("i", 3 * HOUR), out("o", HOUR, { source: "ai_written" })] }],
    ["reached call", { attempts: [{ at: NOW - HOUR, outcome: "reached" as const }] }],
    ["voicemail", { attempts: [{ at: NOW - HOUR, outcome: "voicemail" as const }] }],
    ["user dispo", { events: [{ type: "dispo_set" as const, at: NOW - HOUR, actor: "user" as const }] }],
    ["user next step", { events: [{ type: "appointment_booked" as const, at: NOW - HOUR, actor: "user" as const }] }],
    ["rep-started drip", { enrollment: { status: "active" as const, nextRunAt: NOW + HOUR, updatedAt: NOW, enrolledAt: NOW - HOUR, enrolledBy: "rep" as const, steps: 4, step: 0 } }],
  ])("%s handles it", (_n, over) => expect(unhandled(reply(over as Partial<Lead>))).toBe(false));
  it.each([
    ["no-answer call", { attempts: [{ at: NOW - HOUR, outcome: "no_answer" as const }] }],
    ["wrong_number attempt alone", { attempts: [{ at: NOW - HOUR, outcome: "wrong_number" as const }] }],
    ["note", { events: [{ type: "note" as const, at: NOW - HOUR, actor: "user" as const }] }],
    ["log-attempt workflow event", { events: [{ type: "my_leads_workflow" as const, at: NOW - HOUR, actor: "user" as const, operation: "log_acquisition_attempt" }] }],
    ["system dispo", { events: [{ type: "dispo_set" as const, at: NOW - HOUR, actor: "system" as const }] }],
    ["AI-routed enrollment", { enrollment: { status: "active" as const, nextRunAt: NOW + HOUR, updatedAt: NOW, enrolledAt: NOW - HOUR, enrolledBy: "ai" as const, steps: 4, step: 0 } }],
    ["queued/failed/pending texts", { messages: [inb("i", 3 * HOUR), out("a", 2 * HOUR, { outcome: "failed" }), out("b", HOUR, { outcome: "queued" }), out("c", 50 * MIN, { outcome: "pending" })] }],
    ["drip text", { messages: [inb("i", 3 * HOUR), out("a", HOUR, { source: "drip" })] }],
    ["campaign text", { messages: [inb("i", 3 * HOUR), out("a", HOUR, { source: "campaign" })] }],
    ["unresolved-stamp text", { messages: [inb("i", 3 * HOUR), out("a", HOUR, { stamp: { kind: "unresolved" } })] }],
  ])("%s does not clear it", (_n, over) => expect(unhandled(reply(over as Partial<Lead>))).toBe(true));
  it("stamped to X while Y arrived: Y stays unhandled; stamped to Y or foreign handles by time", () => {
    const base = [inb("x", 3 * HOUR), inb("y", 2 * HOUR)];
    expect(unhandled(lead({ messages: [...base, out("o", HOUR, { stamp: { kind: "inbound", ref: "x" } })] }))).toBe(true);
    expect(unhandled(lead({ messages: [...base, out("o", HOUR, { stamp: { kind: "inbound", ref: "y" } })] }))).toBe(false);
    expect(unhandled(lead({ messages: [...base, out("o", HOUR, { stamp: { kind: "foreign" } })] }))).toBe(false);
    expect(unhandled(lead({ messages: [...base, out("o", HOUR)] }))).toBe(false);
  });
  it("accepted-then-delivery-failed still answers X; a newer Y is unhandled", () => {
    const failed = out("o", 2 * HOUR, { outcome: "accepted_then_failed", sentAt: NOW - 2 * HOUR, failedAt: NOW - HOUR });
    expect(place(lead({ messages: [inb("x", 3 * HOUR), failed] }), NOW)).toMatchObject({ row: "6", reason: "broken" });
    expect(place(lead({ messages: [inb("x", 3 * HOUR), failed, inb("y", 30 * MIN)] }), NOW).row).toBe("5");
  });
  it("a reply created earlier but sent after the inbound handles it (effective send time)", () => {
    const l = lead({ messages: [inb("i", 3 * HOUR), out("o", 4 * HOUR, { sentAt: NOW - HOUR })] });
    expect(isHandled(l, { at: NOW - 3 * HOUR, ref: "i", kind: "text" })).toBe(true);
    const l2 = lead({ messages: [inb("i", 3 * HOUR), out("o", HOUR, { sentAt: NOW - 4 * HOUR })] });
    expect(isHandled(l2, { at: NOW - 3 * HOUR, ref: "i", kind: "text" })).toBe(false);
  });
  it("missed inbound calls are handled by any qualifying event after them", () => {
    expect(place(lead({ missedCalls: [NOW - 2 * HOUR] }), NOW).headline).toMatchObject({ kind: "call" });
    expect(place(lead({ missedCalls: [NOW - 2 * HOUR], messages: [out("o", HOUR)] }), NOW).row).toBe("13");
  });
});

describe("Broken inventory and supersession (2.1)", () => {
  const ledger = (state: "unknown" | "blocked" | "delivery_failed" | "sending", ago: number) => lead({ ledgers: [{ ref: "l", state, updatedAt: NOW - ago }] });
  it("ledger states and actions", () => {
    expect(place(ledger("blocked", HOUR), NOW)).toMatchObject({ row: "6", brokenActions: ["review"] });
    expect(place(ledger("delivery_failed", HOUR), NOW)).toMatchObject({ brokenActions: ["resend"] });
    expect(place(ledger("unknown", 20 * MIN), NOW)).toMatchObject({ brokenActions: ["check_status"] });
    expect(where(ledger("sending", 5 * MIN))).toBe("your_move/nothing_planned/15");
    expect(where(ledger("sending", 20 * MIN))).toBe("your_move/broken/6");
  });
  it("a replacement text resolves a failure; a no-answer call does not; a user dispo does", () => {
    const failed = out("f", 2 * HOUR, { outcome: "failed" });
    expect(where(lead({ messages: [failed] }))).toBe("your_move/broken/6");
    expect(where(lead({ messages: [failed, out("r", HOUR)] }))).toBe("their_move/texted_last/13");
    expect(where(lead({ messages: [failed], attempts: [{ at: NOW - HOUR, outcome: "no_answer" }] }))).toBe("your_move/broken/6");
    expect(where(lead({ messages: [failed], events: [{ type: "dispo_set", at: NOW - HOUR, actor: "user" }] }))).toBe("your_move/nothing_planned/15");
    expect(where(lead({ messages: [failed], events: [{ type: "rep_sms_failure_dismissed", at: NOW - HOUR, actor: "user", dismisses: "f" }] }))).toBe("your_move/nothing_planned/15");
  });
  it("provider_unknown is Check status, never Resend; reconciled to delivered is Texted last", () => {
    expect(place(lead({ messages: [out("u", HOUR, { outcome: "failed_unknown" })] }), NOW).brokenActions).toEqual(["check_status"]);
    expect(where(lead({ messages: [out("u", HOUR, { outcome: "delivered" })] }))).toBe("their_move/texted_last/13");
  });
  it("failures older than 7 days, and pending under 15 minutes, do not show", () => {
    expect(where(lead({ messages: [out("f", 8 * DAY, { outcome: "failed" })] }))).toBe("your_move/nothing_planned/15");
    expect(where(lead({ messages: [out("p", 5 * MIN, { outcome: "pending" })] }))).toBe("your_move/nothing_planned/15");
    expect(place(lead({ messages: [out("p", 20 * MIN, { outcome: "pending" })] }), NOW).brokenActions).toEqual(["check_status"]);
  });
  it("obligations", () => {
    const ob = (state: "required" | "delivery_failed" | "claimed", lease?: number) => lead({ obligations: [{ ref: "o", state, updatedAt: NOW - HOUR, leaseExpiresAt: lease }] });
    expect(place(ob("required"), NOW).brokenActions).toEqual(["send_text"]);
    expect(place(ob("delivery_failed"), NOW).brokenActions).toEqual(["resend"]);
    expect(place(ob("claimed", NOW - MIN), NOW).brokenActions).toEqual(["check_status"]);
    expect(where(ob("claimed", NOW + 5 * MIN))).toBe("your_move/nothing_planned/15");
  });
  it("AI dead letter and Norma review are Broken; a pending AI draft is a label only (v9 SQ3)", () => {
    expect(where(lead({ aiDeadLetter: NOW - HOUR }))).toBe("your_move/broken/6");
    expect(where(lead({ normaNeedsReview: true }))).toBe("your_move/broken/6");
    expect(where(lead({ aiDraftPending: true }))).toBe("your_move/nothing_planned/15");
    expect(where(lead({ aiDraftPending: true, messages: [inb("i", 3 * HOUR)] }))).toBe("your_move/new_reply/5");
  });
  it("badge counts Due, New reply and Broken once per lead", () => {
    const a = place(lead({ appointments: [{ ref: "a", due: NOW - HOUR, status: "open" }], messages: [inb("i", HOUR)] }), NOW);
    const b = place(lead({ aiDeadLetter: NOW }), NOW);
    const c = place(lead(), NOW);
    expect(expectedViews(new Map([["a", a], ["b", b], ["c", c]])).badge).toBe(2);
  });
});

describe("v9 corrections", () => {
  it("SQ2: an unknown obligation is in flight for 15 minutes", () => {
    const ob = (ago: number) => lead({ obligations: [{ ref: "o", state: "unknown", updatedAt: NOW - ago }] });
    expect(where(ob(5 * MIN))).toBe("your_move/nothing_planned/15");
    expect(place(ob(20 * MIN), NOW).brokenActions).toEqual(["check_status"]);
  });
  it("SQ4: a no-answer attempt and its log_acquisition_attempt workflow event do not clear New reply", () =>
    expect(where(lead({ messages: [inb("i", 3 * HOUR)], attempts: [{ at: NOW - HOUR, outcome: "no_answer" }],
      events: [{ type: "my_leads_workflow", at: NOW - HOUR, actor: "user", operation: "log_acquisition_attempt" }] }))).toBe("your_move/new_reply/5"));
  it("SQ5: contact-only inbound counts only when the contact is homeowner on one queue lead", () => {
    expect(where(lead({ messages: [inb("i", HOUR, { contactOnly: true })] }))).toBe("your_move/new_reply/5");
    expect(where(lead({ contactShared: true, messages: [inb("i", HOUR, { contactOnly: true })] }))).toBe("your_move/nothing_planned/15");
  });
});
