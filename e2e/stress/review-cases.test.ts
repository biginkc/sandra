import { describe, expect, it } from "vitest";

import { browserLaneProblem } from "./engine";
import { reminderWindowOpenAt } from "./reminder-window";
import { liveAppIdentityProblems } from "./live-leg";
import { dialProblems, reminderProblems, type ReminderRow } from "./oracle";
import { readCallNextLimit, stripParityProblems } from "./parity";
import { CALL_NEXT_LIMIT } from "@/lib/my-leads/call-next";
import { selfTestReportOk, type SelfTestReportRow } from "./selftest-spec";

/**
 * One reproduction per Astra blocker (review of 6b3fcf0) that has no other home. Each case is the input Astra described; before the fix the old
 * code accepted it (green), now it is refused (these assert the refusal).
 */

describe("Astra 1: dials come from provider receipts (destination + intent key)", () => {
  const LEAD = "+18165550101";
  const intent = { custom_data: "sandra.dialpad.v1." + "a".repeat(48), destination_e164: LEAD };
  it("an authorized intent with NO provider receipt is a missing dial (the old oracle counted the authorization row)", () => {
    expect(dialProblems([], [intent], LEAD, 1)).toEqual([{ rule: "dials", expected: 1, observed: 0 }]);
  });
  it("a duplicate receipt for one intent, and a receipt with an unknown key, fail", () => {
    const r = { phone: LEAD, key: intent.custom_data };
    expect(dialProblems([r, r], [intent], LEAD, 1).map((v) => v.rule)).toEqual(expect.arrayContaining(["dials", "duplicate_receipt_for_intent"]));
    expect(dialProblems([{ phone: LEAD, key: "sandra.dialpad.v1." + "b".repeat(48) }], [intent], LEAD, 1).map((v) => v.rule)).toContain("receipt_without_authorized_intent");
  });
  it("a wrong-number call carrying this lead's intent key fails", () => {
    const problems = dialProblems([{ phone: "+18165550199", key: intent.custom_data }], [intent], LEAD, 0);
    expect(problems.map((v) => v.rule)).toContain("wrong_number_for_intent");
  });
  it("one receipt with the right key and destination passes", () => {
    expect(dialProblems([{ phone: LEAD, key: intent.custom_data }], [intent], LEAD, 1)).toEqual([]);
  });
});

describe("Astra 2: reminders are exact counts and respect cancellation", () => {
  const row = (over: Partial<ReminderRow> = {}): ReminderRow => ({ id: "r1", status: "pending", task_status: "open", messages: 0, ...over });
  it("one reminder expected and none sent fails (the old oracle only had upper bounds)", () => {
    expect(reminderProblems([row()], 1, "plain").map((v) => v.rule)).toEqual(expect.arrayContaining(["reminder_sent_rows", "reminder_messages"]));
  });
  it("exactly one sent row with exactly one message passes", () => {
    expect(reminderProblems([row({ status: "sent", messages: 1 })], 1, "plain")).toEqual([]);
  });
  it("two sends where one is expected fails", () => {
    expect(reminderProblems([row({ status: "sent", messages: 1 }), row({ id: "r2", status: "sent", messages: 1 })], 1, "plain").length).toBeGreaterThan(0);
  });
  it("a text for a cancelled or replaced slot fails; the reschedule variant needs the old reminder cancelled", () => {
    expect(reminderProblems([row({ status: "cancelled", task_status: "cancelled", messages: 1 })], 0, "reschedule").map((v) => v.rule)).toContain("message_for_cancelled_slot");
    expect(reminderProblems([row({ status: "pending" })], 0, "reschedule").map((v) => v.rule)).toContain("old_slot_reminder_not_cancelled");
    expect(reminderProblems([row({ status: "cancelled", task_status: "cancelled" }), row({ id: "r2" })], 0, "reschedule")).toEqual([]);
  });
  it("outside the job's real-clock window nothing may be sent, and the run can no longer be a PASS", () => {
    expect(reminderProblems([row({ status: "pending" })], 1, "plain", false)).toEqual([]);
    expect(reminderProblems([row({ status: "sent", messages: 1 })], 1, "plain", false).map((v) => v.rule)).toContain("reminder_sent_rows");
    expect(reminderWindowOpenAt(new Date("2026-10-06T02:30:00Z"))).toBe(false); // 21:30 Central
    expect(reminderWindowOpenAt(new Date("2026-10-06T15:00:00Z"))).toBe(true); // 10:00 Central
  });
  it("the race variant (undefined) allows zero or one, never a message without a sent row", () => {
    expect(reminderProblems([row({ status: "sent", messages: 1 })], undefined, "reschedule_race")).toEqual([]);
    expect(reminderProblems([row({ status: "pending", messages: 1 })], undefined, "reschedule_race").length).toBeGreaterThan(0);
  });
});

describe("Astra 3: every nonzero Playwright exit fails the run", () => {
  it("exit 1 is a problem even when every tick recorded success; exit 0 is not", () => {
    expect(browserLaneProblem("chaos-browser", 1)).toMatch(/exited 1/);
    expect(browserLaneProblem("chaos-browser", 0)).toBeNull();
  });
});

describe("Astra 4: the self-test gate needs the control and three distinct fired, caught faults", () => {
  const SHA = "c".repeat(40);
  const control: SelfTestReportRow = { fault: "none", ok: true, faultFired: false, failingChecks: [], verdict: "PARTIAL_PASS" };
  const faults = (over: Record<string, Partial<SelfTestReportRow>> = {}): SelfTestReportRow[] => [
    { fault: "duplicate_send", ok: true, faultFired: true, failingChecks: [7], verdict: "FAIL", ...over.duplicate_send },
    { fault: "drop_offer", ok: true, faultFired: true, failingChecks: [13, 14, 15], verdict: "FAIL", ...over.drop_offer },
    { fault: "wrong_lead_note", ok: true, faultFired: true, failingChecks: [12], verdict: "FAIL", ...over.wrong_lead_note },
  ];
  const report = (rows: SelfTestReportRow[]) => ({ sha: SHA, ok: true, rows });
  it("the control plus the three distinct required faults passes", () => {
    expect(selfTestReportOk(report([control, ...faults()]), SHA)).toBe(true);
  });
  it("four 'none' rows (Astra's reproduction) fail", () => {
    expect(selfTestReportOk(report([control, control, control, control]), SHA)).toBe(false);
  });
  it("a duplicated fault in place of another, a missing row, or an extra row fail", () => {
    const f = faults();
    expect(selfTestReportOk(report([control, f[0]!, f[0]!, f[2]!]), SHA)).toBe(false);
    expect(selfTestReportOk(report([control, ...f.slice(0, 2)]), SHA)).toBe(false);
    expect(selfTestReportOk(report([control, ...f, control]), SHA)).toBe(false);
  });
  it("a fault that did not fire, one caught only by an unrelated check, or one that did not turn the run red fails", () => {
    expect(selfTestReportOk(report([control, ...faults({ drop_offer: { faultFired: false } })]), SHA)).toBe(false);
    expect(selfTestReportOk(report([control, ...faults({ drop_offer: { failingChecks: [3] } })]), SHA)).toBe(false);
    expect(selfTestReportOk(report([control, ...faults({ drop_offer: { verdict: "PARTIAL_PASS" } })]), SHA)).toBe(false);
  });
  it("a different sha, or an unknown one, fails", () => {
    expect(selfTestReportOk({ sha: "d".repeat(40), ok: true, rows: [control, ...faults()] }, SHA)).toBe(false);
    expect(selfTestReportOk(report([control, ...faults()]), "unknown")).toBe(false);
  });
});

describe("Astra 5: the live app's build identity is bound to the harness checkout", () => {
  const SHA = "e".repeat(40);
  const LOG = "/tmp/live-identity.jsonl";
  const line = (o: Record<string, unknown> = {}) => JSON.stringify({ kind: "guard_loaded", pid: 7, log: LOG, sha: SHA, dirty: false, redirect: null, ...o });
  it("the listener's own line with this sha, clean, no redirect passes", () => {
    expect(liveAppIdentityProblems([line()], 7, SHA, LOG)).toEqual([]);
  });
  it("an older or foreign commit, a dirty tree, a missing line, or a redirect fails", () => {
    expect(liveAppIdentityProblems([line({ sha: "f".repeat(40) })], 7, SHA, LOG).join()).toMatch(/runs commit/);
    expect(liveAppIdentityProblems([line({ dirty: true })], 7, SHA, LOG).join()).toMatch(/uncommitted/);
    expect(liveAppIdentityProblems([line({ pid: 8 })], 7, SHA, LOG).join()).toMatch(/no guard_loaded/);
    expect(liveAppIdentityProblems([line({ redirect: "http://127.0.0.1:1" })], 7, SHA, LOG).join()).toMatch(/redirect/);
    expect(liveAppIdentityProblems([line()], null, SHA, LOG).join()).toMatch(/no process/);
  });
});

describe("Astra 8: rendered parity compares the strip and the section counts", () => {
  it("strip: wrong order, a missing or extra lead, or a duplicate fails; the exact prefix passes", () => {
    expect(stripParityProblems(["a", "b"], ["a", "b"], 10)).toEqual([]);
    // B1: rows dropped from the END (rendered 9 where the page limit is 10 and the database has more) must fail.
    const db = Array.from({ length: 12 }, (_, i) => `l${i}`);
    expect(stripParityProblems(db.slice(0, 10), db, 10)).toEqual([]);
    expect(stripParityProblems(db.slice(0, 9), db, 10).join()).toMatch(/rendered 9 rows, expected 10/);
    expect(stripParityProblems(["a", "b"], ["a", "b", "c"], 10).join()).toMatch(/rendered 2 rows, expected 3/);
    expect(stripParityProblems(db.slice(0, 9), db).join()).toMatch(/expected 10/); // the real limit
    expect(stripParityProblems(["b", "a"], ["a", "b"]).length).toBeGreaterThan(0);
    expect(stripParityProblems(["a", "x"], ["a", "b"]).length).toBeGreaterThan(0);
    expect(stripParityProblems([], ["a"]).join()).toMatch(/rendered no rows/);
    expect(stripParityProblems(["a", "a"], ["a", "b"]).join()).toMatch(/twice/);
    expect(stripParityProblems(["a", "b", "c"], ["a", "b"]).join()).toMatch(/rendered 3 rows, expected 2/);
  });
});

describe("B1 the limit comes from the source of truth", () => {
  it("the value read from the file equals a real import of CALL_NEXT_LIMIT", () => {
    expect(readCallNextLimit()).toBe(CALL_NEXT_LIMIT);
  });
});
