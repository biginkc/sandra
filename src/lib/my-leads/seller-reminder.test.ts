import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildSellerReminderBody,
  decideReminder,
  dispatchSellerReminder,
  nextQuietHoursOpen,
  runSellerReminderJob,
  type ClaimedSellerReminder,
  type DecideReminderInputs,
  type SellerReminderAdmin,
  type SellerReminderDeps,
} from "./seller-reminder";
import { SELLER_REMINDER_COPY } from "./seller-reminder-copy";
import type { SendSmsOutcome } from "@/lib/messaging/send";

// Test-only copy. The shipped text is asserted separately and is never used to drive these cases.
const TEST_COPY = "TEST {first_name} at {time}";
const NOW = new Date("2026-10-07T14:00:00Z"); // 09:00 CDT
const DUE = new Date("2026-10-07T19:30:00Z"); // 14:30 CDT
const NEW_KEY = "6f1c2b8e-5a3d-4e7f-9b1a-2c3d4e5f6a7b";

describe("approved copy", () => {
  it("is exactly the text Jarrad approved, with straight ASCII apostrophes", () => {
    expect(SELLER_REMINDER_COPY).toBe(
      "Hi {first_name}, it's Jarrad with BMH Group. Just a reminder I'll give you a call today at {time}. Talk soon!",
    );
    expect(SELLER_REMINDER_COPY).not.toMatch(/[^\x20-\x7e]/);
  });

  it("renders to an approved message under the 320 character cap", () => {
    const body = buildSellerReminderBody(SELLER_REMINDER_COPY!, { firstName: "Sally", localTime: "2:30 PM" });
    expect(body).toBe(
      "Hi Sally, it's Jarrad with BMH Group. Just a reminder I'll give you a call today at 2:30 PM. Talk soon!",
    );
  });
});

describe("buildSellerReminderBody", () => {
  it("replaces tokens, rejects unknown tokens, caps length, needs a first name", () => {
    expect(buildSellerReminderBody(TEST_COPY, { firstName: " Sam ", localTime: "2:30 PM" })).toBe("TEST Sam at 2:30 PM");
    expect(() => buildSellerReminderBody("x {address}", { firstName: "S", localTime: "t" })).toThrow(/Unknown/);
    expect(() => buildSellerReminderBody("x".repeat(321), { firstName: "S", localTime: "t" })).toThrow(/320/);
    expect(() => buildSellerReminderBody(TEST_COPY, { firstName: null, localTime: "t" })).toThrow(/first name/);
    expect(buildSellerReminderBody("no tokens", { firstName: null, localTime: "t" })).toBe("no tokens");
  });
});

describe("nextQuietHoursOpen", () => {
  it("is 08:00 the same day before 08:00 and the next day from 21:00", () => {
    expect(nextQuietHoursOpen("MO", new Date("2026-10-07T11:00:00Z"))?.toISOString()).toBe("2026-10-07T13:00:00.000Z"); // 06:00 CDT -> 08:00 CDT
    expect(nextQuietHoursOpen("MO", new Date("2026-10-08T02:30:00Z"))?.toISOString()).toBe("2026-10-08T13:00:00.000Z"); // 21:30 CDT -> next 08:00
    expect(nextQuietHoursOpen("MO", new Date("2026-10-07T03:30:00Z"))?.toISOString()).toBe("2026-10-07T13:00:00.000Z"); // 22:30 CDT prior night
    expect(nextQuietHoursOpen("ZZ", NOW)).toBeNull();
  });

  it("is DST-safe (CST after the fall-back change)", () => {
    // 2026-11-01 fall back; 08:00 CST is 14:00Z
    expect(nextQuietHoursOpen("MO", new Date("2026-11-01T11:00:00Z"))?.toISOString()).toBe("2026-11-01T14:00:00.000Z");
  });
});

function inputs(over: Partial<DecideReminderInputs> = {}): DecideReminderInputs {
  return {
    now: NOW,
    claimedDueAt: DUE,
    task: { status: "open", mode: "phone", dueAt: DUE },
    property: { deletedAt: null, isDncLocked: false, status: "new_lead", state: "MO", outreachDispo: null },
    contact: { doNotContact: false, smsOptedOut: false, firstName: "Sally" },
    consentState: "no_consent",
    needsFirstName: true,
    ...over,
  };
}

describe("decideReminder", () => {
  it("sends in the window and formats the call time in the seller's zone", () => {
    expect(decideReminder(inputs())).toEqual({ action: "send", localTime: "2:30 PM" });
    expect(decideReminder(inputs({ property: { ...inputs().property!, state: "NY" } }))).toEqual({ action: "send", localTime: "3:30 PM" });
  });

  it.each([
    ["rescheduled", { task: { status: "open", mode: "phone", dueAt: new Date(DUE.getTime() + 3_600_000) } }, "cancel", "task_changed"],
    ["completed", { task: { status: "completed", mode: "phone", dueAt: DUE } }, "cancel", "task_changed"],
    ["flipped to in person", { task: { status: "open", mode: "in_person", dueAt: DUE } }, "cancel", "task_changed"],
    ["task gone", { task: null }, "cancel", "task_changed"],
    ["call time already passed", { now: new Date(DUE.getTime() + 1) }, "skip", "appointment_passed"],
    ["property deleted", { property: { ...inputs().property!, deletedAt: "2026-10-01" } }, "skip", "property_unavailable"],
    ["DNC-locked property", { property: { ...inputs().property!, isDncLocked: true } }, "skip", "dnc_locked"],
    ["closed property", { property: { ...inputs().property!, status: "closed" } }, "skip", "property_closed"],
    ["dead property", { property: { ...inputs().property!, status: "dead" } }, "skip", "property_closed"],
    ["no contact", { contact: null }, "skip", "no_contact"],
    ["contact do_not_contact", { contact: { doNotContact: true, smsOptedOut: false, firstName: "S" } }, "skip", "do_not_contact"],
    ["contact sms_opted_out", { contact: { doNotContact: false, smsOptedOut: true, firstName: "S" } }, "skip", "opted_out"],
    ["STOP recorded after scheduling", { consentState: "opted_out" as const }, "skip", "opted_out"],
    ["terminal disposition", { property: { ...inputs().property!, outreachDispo: "wrong_number" } }, "skip", "suppressed_dispo"],
    ["no first name", { contact: { doNotContact: false, smsOptedOut: false, firstName: " " } }, "skip", "no_first_name"],
    ["unknown state", { property: { ...inputs().property!, state: "ZZ" } }, "skip", "unknown_state"],
  ])("%s", (_label, over, action, reason) => {
    expect(decideReminder(inputs(over as Partial<DecideReminderInputs>))).toMatchObject({ action, reason });
  });

  it("does not block a booked appointment (manual suppression variant) or a contact with no consent record", () => {
    expect(decideReminder(inputs({ property: { ...inputs().property!, outreachDispo: "booked_appointment" }, consentState: "no_consent" })).action).toBe("send");
    expect(decideReminder(inputs({ consentState: "can_send_informational_only" })).action).toBe("send");
  });

  it("does not need a first name when the copy does not use one", () => {
    expect(decideReminder(inputs({ needsFirstName: false, contact: { doNotContact: false, smsOptedOut: false, firstName: null } })).action).toBe("send");
  });

  it("defers before 08:00 and from 21:00 local to the next 08:00, or skips when too close to the call", () => {
    const early = new Date("2026-10-07T11:00:00Z"); // 06:00 CDT, call at 14:30
    expect(decideReminder(inputs({ now: early }))).toEqual({ action: "defer", reason: "quiet_hours", retryAt: new Date("2026-10-07T13:00:00Z") });
    const nearCall = new Date("2026-10-07T13:20:00Z"); // 08:20 CDT is in window; use a call at 08:10 with now 07:50
    expect(nearCall).toBeTruthy();
    const closeDue = new Date("2026-10-07T13:10:00Z"); // 08:10 CDT
    const now0750 = new Date("2026-10-07T12:50:00Z"); // 07:50 CDT, quiet; next open 08:00 is only 10 min before the call
    expect(decideReminder(inputs({ now: now0750, claimedDueAt: closeDue, task: { status: "open", mode: "phone", dueAt: closeDue } }))).toMatchObject({ action: "skip", reason: "quiet_hours_missed" });
    const late = new Date("2026-10-08T02:30:00Z"); // 21:30 CDT, call tomorrow 14:30 -> defer to 08:00 CDT tomorrow
    const tomorrow = new Date("2026-10-08T19:30:00Z");
    expect(decideReminder(inputs({ now: late, claimedDueAt: tomorrow, task: { status: "open", mode: "phone", dueAt: tomorrow } }))).toEqual({ action: "defer", reason: "quiet_hours", retryAt: new Date("2026-10-08T13:00:00Z") });
  });
});

// ------------------------------------------------------------------ dispatch

type Tables = Record<string, Record<string, Record<string, unknown>>>;

function fakeAdmin(tables: Tables, rpcImpl?: (fn: string, args: Record<string, unknown>) => { data?: unknown; error?: { message: string } | null }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const reads: string[] = [];
  const admin = {
    rpc: (fn: string, args: Record<string, unknown> = {}) => {
      calls.push({ fn, args });
      const r = rpcImpl?.(fn, args) ?? {};
      const data = r.data === undefined ? (fn === "fn_finish_seller_reminder" ? true : null) : r.data;
      return Promise.resolve({ data, error: r.error ?? null });
    },
    from: (table: string) => {
      reads.push(table);
      const rowsOf = tables[table];
      if (!rowsOf) throw new Error(`unexpected read of ${table}`);
      return {
        select: () => ({
          eq: (column: string, value: unknown) => {
            const matches = Object.values(rowsOf).filter((r) => r[column] === value);
            const result = { data: matches, error: null };
            return {
              maybeSingle: () => Promise.resolve({ data: matches[0] ?? null, error: null }),
              then: (a: (v: unknown) => unknown, b?: (e: unknown) => unknown) => Promise.resolve(result).then(a, b),
            };
          },
        }),
      };
    },
  };
  return { admin: admin as unknown as SellerReminderAdmin, calls, reads };
}

function row(over: Partial<ClaimedSellerReminder> = {}): ClaimedSellerReminder {
  return {
    id: "r1", org_id: "org1", task_id: "t1", calendar_chain_id: "c1", property_id: "p1", contact_id: "k1",
    due_at: DUE.toISOString(), send_at: NOW.toISOString(), send_local_date: "2026-10-07", attempts: 1,
    claim_token: "tok1", send_key: "11111111-1111-4111-8111-111111111111", ...over,
  };
}

function baseTables(): Tables {
  return {
    seller_reminder_settings: { org1: { org_id: "org1", enabled: true } },
    tasks: { t1: { id: "t1", status: "open", mode: "phone", due_at: DUE.toISOString(), contact_id: "k1" } },
    properties: { p1: { id: "p1", deleted_at: null, is_dnc_locked: false, status: "new_lead", state: "MO", outreach_dispo: null, homeowner_contact_id: "k9" } },
    contacts: {
      k1: { id: "k1", do_not_contact: false, sms_opted_out: false, first_name: "Sally" },
      k9: { id: "k9", do_not_contact: false, sms_opted_out: false, first_name: "Homer" },
    },
  };
}

function deps(tables: Tables, over: Partial<SellerReminderDeps> = {}, rpcImpl?: Parameters<typeof fakeAdmin>[1]) {
  const fake = fakeAdmin(tables, rpcImpl);
  const send = vi.fn(async (): Promise<SendSmsOutcome> => ({ status: "sent", messageId: "m1", externalId: "e1" }));
  const d: SellerReminderDeps = {
    admin: fake.admin,
    send,
    getConsent: vi.fn(async () => "no_consent" as const),
    getFlag: vi.fn(async () => true),
    schemaReady: vi.fn(async () => true),
    getCopy: () => TEST_COPY,
    now: () => NOW,
    newSendKey: () => NEW_KEY,
    ...over,
  };
  return { d, send, ...fake };
}
const finishArgs = (calls: Array<{ fn: string; args: Record<string, unknown> }>) =>
  calls.filter((c) => c.fn === "fn_finish_seller_reminder").map((c) => c.args);

describe("dispatchSellerReminder", () => {
  it("sends with origin manual, the persisted send key, tagged metadata and the substituted body", async () => {
    const { d, send, calls } = deps(baseTables());
    expect(await dispatchSellerReminder(d, row())).toEqual({ status: "sent", reason: undefined });
    expect(send).toHaveBeenCalledWith({
      origin: "manual",
      contactId: "k1",
      propertyId: "p1",
      body: "TEST Sally at 2:30 PM",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      metadata: { kind: "seller_appointment_reminder", reminderId: "r1", taskId: "t1" },
    });
    expect(finishArgs(calls)).toEqual([expect.objectContaining({ p_status: "sent", p_message_id: "m1", p_token: "tok1" })]);
  });

  it("falls back to the property's homeowner when the task has no contact, and never reads rep reminder prefs", async () => {
    const t = baseTables();
    t.tasks.t1.contact_id = null;
    const { d, send, reads } = deps(t);
    await dispatchSellerReminder(d, row());
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ contactId: "k9", body: "TEST Homer at 2:30 PM" }));
    expect(reads).not.toContain("user_integration_prefs");
  });

  it("disable after claim: org setting off -> nothing sent, row cancelled reminders_disabled", async () => {
    const t = baseTables();
    t.seller_reminder_settings.org1.enabled = false;
    const { d, send, calls } = deps(t);
    await dispatchSellerReminder(d, row());
    expect(send).not.toHaveBeenCalled();
    expect(finishArgs(calls)).toEqual([expect.objectContaining({ p_status: "cancelled", p_reason: "reminders_disabled" })]);
  });

  it("disable after claim: flag off -> nothing sent, cancelled reminders_disabled", async () => {
    const { d, send, calls } = deps(baseTables(), { getFlag: async () => false });
    await dispatchSellerReminder(d, row());
    expect(send).not.toHaveBeenCalled();
    expect(finishArgs(calls)).toEqual([expect.objectContaining({ p_status: "cancelled", p_reason: "reminders_disabled" })]);
  });

  it("a missing settings row reads as off", async () => {
    const t = baseTables();
    delete t.seller_reminder_settings.org1;
    const { d, send } = deps(t);
    await dispatchSellerReminder(d, row());
    expect(send).not.toHaveBeenCalled();
  });

  it("copy null at dispatch -> cancelled copy_not_approved, no send", async () => {
    const { d, send, calls } = deps(baseTables(), { getCopy: () => null });
    await dispatchSellerReminder(d, row());
    expect(send).not.toHaveBeenCalled();
    expect(finishArgs(calls)).toEqual([expect.objectContaining({ p_status: "cancelled", p_reason: "copy_not_approved" })]);
  });

  it.each([
    ["rescheduled between claim and dispatch", (t: Tables) => { t.tasks.t1.due_at = new Date(DUE.getTime() + 3_600_000).toISOString(); }, "cancelled", "task_changed"],
    ["mode flipped to in person", (t: Tables) => { t.tasks.t1.mode = "in_person"; }, "cancelled", "task_changed"],
    ["task completed", (t: Tables) => { t.tasks.t1.status = "completed"; }, "cancelled", "task_changed"],
    ["contact do_not_contact", (t: Tables) => { t.contacts.k1.do_not_contact = true; }, "skipped", "do_not_contact"],
    ["contact sms_opted_out", (t: Tables) => { t.contacts.k1.sms_opted_out = true; }, "skipped", "opted_out"],
    ["property DNC-locked", (t: Tables) => { t.properties.p1.is_dnc_locked = true; }, "skipped", "dnc_locked"],
    ["property closed", (t: Tables) => { t.properties.p1.status = "closed"; }, "skipped", "property_closed"],
    ["property dead", (t: Tables) => { t.properties.p1.status = "dead"; }, "skipped", "property_closed"],
    ["unknown state", (t: Tables) => { t.properties.p1.state = "ZZ"; }, "skipped", "unknown_state"],
  ])("gate: %s -> no send", async (_l, mutate, status, reason) => {
    const t = baseTables();
    mutate(t);
    const { d, send, calls } = deps(t);
    await dispatchSellerReminder(d, row());
    expect(send).not.toHaveBeenCalled();
    expect(finishArgs(calls)).toEqual([expect.objectContaining({ p_status: status, p_reason: reason })]);
  });

  it("STOP recorded after scheduling (consent_events) -> skipped opted_out", async () => {
    const { d, send, calls } = deps(baseTables(), { getConsent: async () => "opted_out" });
    await dispatchSellerReminder(d, row());
    expect(send).not.toHaveBeenCalled();
    expect(finishArgs(calls)).toEqual([expect.objectContaining({ p_status: "skipped", p_reason: "opted_out" })]);
  });

  it("quiet hours: before 08:00 local defers to the next 08:00; too close to the call skips", async () => {
    const early = deps(baseTables(), { now: () => new Date("2026-10-07T11:00:00Z") });
    expect(await dispatchSellerReminder(early.d, row())).toMatchObject({ status: "pending", reason: "quiet_hours" });
    expect(finishArgs(early.calls)).toEqual([
      expect.objectContaining({ p_status: "pending", p_retry_at: "2026-10-07T13:00:00.000Z", p_new_send_key: null }),
    ]);
    expect(early.send).not.toHaveBeenCalled();

    const t = baseTables();
    const closeDue = new Date("2026-10-07T13:10:00Z");
    t.tasks.t1.due_at = closeDue.toISOString();
    const close = deps(t, { now: () => new Date("2026-10-07T12:50:00Z") });
    await dispatchSellerReminder(close.d, row({ due_at: closeDue.toISOString() }));
    expect(finishArgs(close.calls)).toEqual([expect.objectContaining({ p_status: "skipped", p_reason: "quiet_hours_missed" })]);
  });

  it("a transport quiet-hours block outside the handler's own window is skipped, not looped", async () => {
    // The handler judged 09:00 local sendable; if the transport still blocks (clock skew), the next
    // 08:00 is tomorrow, after the call, so the reminder is skipped.
    const { d, calls } = deps(baseTables());
    (d.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ status: "blocked_quiet_hours", reason: "x", check: { ok: false, reason: "outside_window", localTime: "21:05", zone: "America/Chicago" } });
    await dispatchSellerReminder(d, row());
    expect(finishArgs(calls)).toEqual([expect.objectContaining({ p_status: "skipped", p_reason: "quiet_hours_missed" })]);
  });

  describe("outcome mapping", () => {
    const run = async (outcome: SendSmsOutcome, attempts = 1) => {
      const { d, calls } = deps(baseTables());
      (d.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(outcome);
      await dispatchSellerReminder(d, row({ attempts }));
      return finishArgs(calls)[0];
    };

    it.each([
      "blocked_provider_off", "blocked_no_approved_sender", "blocked_no_phone", "blocked_landline", "blocked_terminal_dispo",
      "blocked_no_consent", "blocked_automated_suppressed", "blocked_fresh_state_unavailable", "blocked_not_due",
      "blocked_campaign_paused", "blocked_sequence_authorization", "contact_not_found", "property_not_found",
      "skipped_duplicate_destination",
    ])("%s -> skipped with the status as the reason", async (status) => {
      expect(await run({ status, reason: "r", messageId: "m" } as unknown as SendSmsOutcome)).toMatchObject({ p_status: "skipped", p_reason: status });
    });

    it("provider_failed re-queues as pending with a NEW key and a growing delay", async () => {
      const a = await run({ status: "provider_failed", messageId: "m", error: "boom" }, 1);
      expect(a).toMatchObject({ p_status: "pending", p_reason: "provider_failed", p_new_send_key: NEW_KEY, p_retry_at: new Date(NOW.getTime() + 5 * 60_000).toISOString() });
      const b = await run({ status: "provider_failed", messageId: "m", error: "boom" }, 2);
      expect(b.p_retry_at).toBe(new Date(NOW.getTime() + 10 * 60_000).toISOString());
      expect(await run({ status: "provider_deferred", messageId: "m", error: "x", attempt: 1, retryAt: "x" }, 1)).toMatchObject({ p_status: "pending", p_new_send_key: NEW_KEY });
    });

    it("the third failed attempt is final", async () => {
      expect(await run({ status: "provider_failed", messageId: "m", error: "boom" }, 3)).toMatchObject({ p_status: "failed", p_reason: "provider_failed", p_new_send_key: null });
    });

    it("a retry that would land after the call starts is final", async () => {
      const t = baseTables();
      const { d, calls } = deps(t, { now: () => new Date(DUE.getTime() - 60_000) });
      (d.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ status: "provider_failed", messageId: "m", error: "x" });
      await dispatchSellerReminder(d, row({ attempts: 2 }));
      expect(finishArgs(calls)[0]).toMatchObject({ p_status: "failed" });
    });

    it("provider_unknown is uncertain and keeps the key", async () => {
      expect(await run({ status: "provider_unknown", messageId: "m", error: "x" })).toMatchObject({ p_status: "uncertain", p_reason: "unknown_delivery", p_new_send_key: null, p_message_id: "m" });
    });

    it("db_error after the provider may have accepted is uncertain; before any message row it retries with a new key", async () => {
      expect(await run({ status: "db_error", error: "x", messageId: "m" })).toMatchObject({ p_status: "uncertain" });
      expect(await run({ status: "db_error", error: "x", messageId: "m", externalId: "e" })).toMatchObject({ p_status: "uncertain" });
      expect(await run({ status: "db_error", error: "x", deliveryOutcome: "accepted" })).toMatchObject({ p_status: "uncertain" });
      expect(await run({ status: "db_error", error: "x" })).toMatchObject({ p_status: "pending", p_new_send_key: NEW_KEY });
    });

    it("the transport's opening-identity refusal is skipped with a clear reason, not retried", async () => {
      expect(await run({ status: "db_error", error: 'Opening SMS must identify the sender as "Mel with BMH".' })).toMatchObject({
        p_status: "skipped", p_reason: "opening_identity_required", p_new_send_key: null,
      });
    });

    it("queued/paused are held as uncertain, never resent", async () => {
      expect(await run({ status: "queued", messageId: "m" })).toMatchObject({ p_status: "uncertain", p_reason: "unexpected_queued" });
    });
  });

  it("reports a lost lease and leaves the transport result alone", async () => {
    const { d } = deps(baseTables(), {}, (fn) => (fn === "fn_finish_seller_reminder" ? { data: false } : {}));
    expect(await dispatchSellerReminder(d, row())).toEqual({ status: "fence_lost" });
  });
});

// ------------------------------------------------------------------ job

describe("runSellerReminderJob", () => {
  const jobTables = () => ({ ...baseTables() });
  const rpcNames = (calls: Array<{ fn: string }>) => calls.map((c) => c.fn);

  it("flag off for every enabled org -> nothing scheduled or claimed", async () => {
    const { d, calls } = deps(jobTables(), { getFlag: async () => false });
    expect(await runSellerReminderJob(d)).toEqual({ ok: true, disabled: "flag_off" });
    expect(calls).toEqual([]);
  });

  it("no org enabled -> nothing scheduled or claimed", async () => {
    const t = jobTables();
    t.seller_reminder_settings.org1.enabled = false;
    const { d, calls } = deps(t);
    expect(await runSellerReminderJob(d)).toEqual({ ok: true, disabled: "flag_off" });
    expect(calls).toEqual([]);
  });

  it("schema not ready -> flag_off, no reads", async () => {
    const { d, calls, reads } = deps(jobTables(), { schemaReady: async () => false });
    expect(await runSellerReminderJob(d)).toEqual({ ok: true, disabled: "flag_off" });
    expect(calls).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("copy null -> copy_not_approved and no scheduling or claims", async () => {
    const { d, calls, send } = deps(jobTables(), { getCopy: () => null });
    expect(await runSellerReminderJob(d)).toEqual({ ok: true, disabled: "copy_not_approved" });
    expect(calls).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("only flag-on orgs are scheduled and claimed", async () => {
    const t = jobTables();
    t.seller_reminder_settings.org2 = { org_id: "org2", enabled: true };
    const { d, calls } = deps(t, { getFlag: async (org) => org === "org1" });
    await runSellerReminderJob(d);
    expect(calls[0]).toEqual({ fn: "fn_schedule_seller_reminders", args: { p_org_ids: ["org1"] } });
    expect(calls[1]).toEqual({ fn: "fn_claim_seller_reminders", args: { p_limit: 1, p_org_ids: ["org1"] } });
  });

  it("claims one at a time, dispatches each, and stops when none are left", async () => {
    const queue = [row({ id: "r1", claim_token: "a" }), row({ id: "r2", claim_token: "b" })];
    const { d, calls, send } = deps(jobTables(), {}, (fn) => {
      if (fn === "fn_claim_seller_reminders") return { data: queue.length ? [queue.shift()] : [] };
      if (fn === "fn_schedule_seller_reminders") return { data: { scheduled: 2 } };
      return {};
    });
    const result = await runSellerReminderJob(d);
    expect(result).toMatchObject({ ok: true, claimed: 2, results: { sent: 2 }, budgetExhausted: false, schedule: { scheduled: 2 } });
    expect(send).toHaveBeenCalledTimes(2);
    expect(rpcNames(calls)).toEqual([
      "fn_schedule_seller_reminders", "fn_claim_seller_reminders", "fn_finish_seller_reminder",
      "fn_claim_seller_reminders", "fn_finish_seller_reminder", "fn_claim_seller_reminders",
    ]);
  });

  it("budget exhaustion leaves unclaimed rows for the next run", async () => {
    let t = 0;
    const queue = [row({ id: "r1" }), row({ id: "r2" }), row({ id: "r3" })];
    const { d, send } = deps(jobTables(), { budgetMs: 1000, now: () => new Date(NOW.getTime() + (t += 600)) }, (fn) =>
      fn === "fn_claim_seller_reminders" ? { data: queue.length ? [queue.shift()] : [] } : {});
    const result = await runSellerReminderJob(d);
    expect(result).toMatchObject({ budgetExhausted: true });
    expect(queue.length).toBeGreaterThan(0);
    expect(send.mock.calls.length).toBeLessThan(3);
  });

  it("a dispatch that throws is reported and the lease is left for reclaim", async () => {
    const report = vi.fn();
    const queue = [row()];
    const { d, calls } = deps(jobTables(), { report }, (fn) =>
      fn === "fn_claim_seller_reminders" ? { data: queue.length ? [queue.shift()] : [] } : {});
    (d.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("network"));
    const result = await runSellerReminderJob(d);
    expect(result).toMatchObject({ claimed: 1, results: { error: 1 } });
    expect(report).toHaveBeenCalledWith(expect.any(Error), "seller_reminder_dispatch");
    expect(finishArgs(calls)).toEqual([]);
  });
});
