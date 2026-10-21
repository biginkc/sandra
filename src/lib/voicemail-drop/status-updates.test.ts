import { beforeEach, describe, expect, it, vi } from "vitest";

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock("@/lib/errors/report", () => ({ reportError, reportInfo: vi.fn() }));

import { createFakeDropStore, type FakeDrop } from "./status-updates.fake";
import {
  failureActionFor,
  handleDropCallback,
  handleDropStatusEvent,
  PAUSE_STEP_MISCONFIGURED,
  PAUSE_VOICEMAIL_DROP_CONSENT,
} from "./status-updates";
import { parseDropCowboyCallback, parseDropCowboyStatusWebhook } from "./webhook";

const NOW = new Date("2026-10-21T15:00:00Z");
const DROP_ROW_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ROW_ID = "22222222-2222-4222-8222-222222222222";

function drop(overrides: Partial<FakeDrop> = {}): FakeDrop {
  return {
    id: DROP_ROW_ID,
    enrollment_id: "enr-1",
    step_run_id: "run-1",
    status: "queued",
    attempt_outcome: "queued",
    drop_id: null,
    to_phone: "+18165550101",
    queued_at: "2026-10-21T12:00:00Z",
    ...overrides,
  };
}

const callback = (body: Record<string, unknown>) =>
  parseDropCowboyCallback(JSON.stringify({ foreign_id: DROP_ROW_ID, drop_id: "dc-1", status: "success", reason_code: 0, ...body }));

const statusEvent = (data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  parseDropCowboyStatusWebhook(
    JSON.stringify({ event: "contact.rvm.status", event_id: "evt-1", data: { status: "success", reason_code: 0, campaign_type: "rvm", ...data }, ...extra }),
  );

beforeEach(() => reportError.mockClear());

describe("failure classes", () => {
  it.each([
    [3021, "pause_misconfigured"],
    [4010, "pause_misconfigured"],
    [3007, "pause_misconfigured"],
    [4016, "pause_consent"],
    [6005, "pause_consent"],
    [6011, "pause_consent"],
    [4001, "mark_failed"],
    [4002, "mark_failed"],
    [4007, "mark_failed"],
    [4019, "mark_failed"],
    [4005, "mark_failed"],
    [4013, "mark_failed"],
    [4017, "pause_consent"],
    [3002, "pause_misconfigured"],
    [5000, "pause_misconfigured"],
    [9999, "mark_failed_and_report"],
    [null, "mark_failed_and_report"],
  ])("code %s → %s", (code, action) => {
    const event = callback({ status: "failure", reason_code: code });
    expect(failureActionFor(event.reasonCode, event.reasonClass)).toBe(action);
  });
});

describe("callback", () => {
  it("rejects an unknown or malformed foreign_id", async () => {
    const fake = createFakeDropStore([drop()]);
    expect((await handleDropCallback(fake.store, callback({ foreign_id: OTHER_ROW_ID }))).status).toBe(404);
    expect((await handleDropCallback(fake.store, callback({ foreign_id: "not-a-uuid" }))).status).toBe(404);
    expect((await handleDropCallback(fake.store, callback({ foreign_id: undefined }))).status).toBe(404);
    expect(fake.drops[0].status).toBe("queued");
  });

  it("persists drop_id, status, cost and proof", async () => {
    const fake = createFakeDropStore([drop()]);
    const res = await handleDropCallback(
      fake.store,
      callback({ product_cost: 0.03, tts_fee: 0.01, proof_of_delivery_url: "https://proof.invalid/1" }),
    );
    expect(res.status).toBe(200);
    expect(fake.drops[0]).toMatchObject({ drop_id: "dc-1", status: "delivered", reason_code: "0", proof_url: "https://proof.invalid/1" });
    expect(fake.drops[0].cost).toBeCloseTo(0.04);
    expect(fake.paused).toEqual([]);
  });

  it("config-class failure pauses step_misconfigured", async () => {
    const fake = createFakeDropStore([drop()]);
    await handleDropCallback(fake.store, callback({ status: "failure", reason_code: 3021, reason: "too long" }));
    expect(fake.drops[0]).toMatchObject({ status: "failed", reason_code: "3021", reason: "too long" });
    expect(fake.paused).toEqual([{ enrollmentId: "enr-1", reason: PAUSE_STEP_MISCONFIGURED }]);
  });

  it("3007 bad credentials after the 202 pauses step_misconfigured", async () => {
    const fake = createFakeDropStore([drop()]);
    await handleDropCallback(fake.store, callback({ status: "failure", reason_code: 3007 }));
    expect(fake.paused).toEqual([{ enrollmentId: "enr-1", reason: PAUSE_STEP_MISCONFIGURED }]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("consent-class failure pauses with a visible reason", async () => {
    const fake = createFakeDropStore([drop()]);
    await handleDropCallback(fake.store, callback({ status: "failure", reason_code: 4016 }));
    expect(fake.paused).toEqual([{ enrollmentId: "enr-1", reason: PAUSE_VOICEMAIL_DROP_CONSENT }]);
  });

  it("delivery-class failure only marks the drop failed", async () => {
    const fake = createFakeDropStore([drop()]);
    await handleDropCallback(fake.store, callback({ status: "failure", reason_code: 4001 }));
    expect(fake.drops[0].status).toBe("failed");
    expect(fake.paused).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("unclassified failure marks failed and reports, without pausing", async () => {
    const fake = createFakeDropStore([drop()]);
    await handleDropCallback(fake.store, callback({ status: "failure", reason_code: 5555 }));
    expect(fake.drops[0].status).toBe("failed");
    expect(fake.paused).toEqual([]);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

describe("signed status webhook", () => {
  it("dedupes on event_id", async () => {
    const fake = createFakeDropStore([drop({ drop_id: "dc-1" })]);
    expect(await handleDropStatusEvent(fake.store, statusEvent({ drop_id: "dc-1", status: "failure", reason_code: 4016 }), NOW)).toBe("applied");
    expect(await handleDropStatusEvent(fake.store, statusEvent({ drop_id: "dc-1", status: "failure", reason_code: 4016 }), NOW)).toBe("duplicate");
    expect(fake.paused).toHaveLength(1);
  });

  it("matches on drop_id before phone", async () => {
    const fake = createFakeDropStore([
      drop({ drop_id: "dc-1", to_phone: "+18165550999" }),
      drop({ id: OTHER_ROW_ID, enrollment_id: "enr-2" }),
    ]);
    await handleDropStatusEvent(fake.store, statusEvent({ drop_id: "dc-1", to: "+18165550101", status: "failure", reason_code: 3021 }), NOW);
    expect(fake.paused).toEqual([{ enrollmentId: "enr-1", reason: PAUSE_STEP_MISCONFIGURED }]);
    expect(fake.drops[1].status).toBe("queued");
  });

  it("falls back to a unique queued drop to that phone within 72h and persists drop_id", async () => {
    const fake = createFakeDropStore([drop()]);
    expect(await handleDropStatusEvent(fake.store, statusEvent({ drop_id: "dc-9", to: "8165550101" }), NOW)).toBe("applied");
    expect(fake.drops[0]).toMatchObject({ status: "delivered", drop_id: "dc-9" });
  });

  it.each([
    ["two queued drops to the phone", [drop(), drop({ id: OTHER_ROW_ID })]],
    ["only a drop older than 72h", [drop({ queued_at: "2026-10-18T14:00:00Z" })]],
    ["only a non-queued drop", [drop({ status: "delivered" })]],
    ["no drops", []],
  ])("stores unmatched when %s", async (_label, rows) => {
    const fake = createFakeDropStore(rows as FakeDrop[]);
    expect(await handleDropStatusEvent(fake.store, statusEvent({ to: "+18165550101", status: "failure", reason_code: 4016 }), NOW)).toBe("unmatched");
    expect(fake.events.get("contact.rvm.status:evt-1")).toEqual({ status: "error", message: "unmatched voicemail drop" });
    expect(fake.paused).toEqual([]);
  });

  it.each(["ai_broadcast", "voice_broadcast", "sms"])(
    "an unrelated %s outcome to the same phone never touches the drop; a later real 4016 still pauses",
    async (campaignType) => {
      const fake = createFakeDropStore([drop()]);
      const broadcast = statusEvent({ campaign_type: campaignType, drop_id: "bc-1", to: "+18165550101" }, { event_id: "evt-bc" });
      expect(await handleDropStatusEvent(fake.store, broadcast, NOW)).toBe("unmatched");
      expect(fake.drops[0]).toMatchObject({ status: "queued", drop_id: null });
      const real = statusEvent({ drop_id: "dc-1", to: "+18165550101", status: "failure", reason_code: 4016 }, { event_id: "evt-rvm" });
      expect(await handleDropStatusEvent(fake.store, real, NOW)).toBe("applied");
      expect(fake.drops[0]).toMatchObject({ status: "failed", drop_id: "dc-1" });
      expect(fake.paused).toEqual([{ enrollmentId: "enr-1", reason: PAUSE_VOICEMAIL_DROP_CONSENT }]);
    },
  );

  it("phone fallback needs campaign_type rvm", async () => {
    const fake = createFakeDropStore([drop()]);
    expect(await handleDropStatusEvent(fake.store, statusEvent({ campaign_type: null, to: "+18165550101" }), NOW)).toBe("unmatched");
    expect(fake.drops[0].status).toBe("queued");
  });

  it("phone fallback never picks a drop holding a different drop_id", async () => {
    const fake = createFakeDropStore([drop({ drop_id: "dc-mine" })]);
    expect(await handleDropStatusEvent(fake.store, statusEvent({ drop_id: "dc-other", to: "+18165550101" }), NOW)).toBe("unmatched");
    expect(fake.drops[0]).toMatchObject({ status: "queued", drop_id: "dc-mine" });
  });

  it("R1-1: a 4016 whose resolve fails commits nothing; the retry fails the drop and pauses consent", async () => {
    const fake = createFakeDropStore([drop({ drop_id: "dc-1" })]);
    fake.faults.resolveFailures = 1;
    const event = statusEvent({ drop_id: "dc-1", status: "failure", reason_code: 4016 });
    await expect(handleDropStatusEvent(fake.store, event, NOW)).rejects.toThrow("resolveOutcome");
    expect(fake.events.get("contact.rvm.status:evt-1")?.status).toBe("error");
    expect(fake.paused).toEqual([]);
    expect(fake.drops[0].status).toBe("queued");
    expect(await handleDropStatusEvent(fake.store, event, NOW)).toBe("applied");
    expect(fake.paused).toEqual([{ enrollmentId: "enr-1", reason: PAUSE_VOICEMAIL_DROP_CONSENT }]);
    expect(fake.drops[0].status).toBe("failed");
    expect(fake.events.get("contact.rvm.status:evt-1")?.status).toBe("processed");
  });

  it("a retried 4016 on a drop already failed (pause pending) still pauses", async () => {
    const fake = createFakeDropStore([drop({ drop_id: "dc-1", status: "failed" })]);
    const event = statusEvent({ drop_id: "dc-1", status: "failure", reason_code: 4016 });
    expect(await handleDropStatusEvent(fake.store, event, NOW)).toBe("applied");
    expect(fake.paused).toEqual([{ enrollmentId: "enr-1", reason: PAUSE_VOICEMAIL_DROP_CONSENT }]);
  });

  it("does not guess when two rows share a drop_id", async () => {
    const fake = createFakeDropStore([drop({ drop_id: "dc-1" }), drop({ id: OTHER_ROW_ID, drop_id: "dc-1", to_phone: "+18165550202" })]);
    expect(await handleDropStatusEvent(fake.store, statusEvent({ drop_id: "dc-1", to: "+18165550101" }), NOW)).toBe("unmatched");
  });

  const receipt = (data: Record<string, unknown>, eventId = "evt-r") =>
    parseDropCowboyStatusWebhook(
      JSON.stringify({ event: "contact.rvm.receipt", event_id: eventId, data: { status: "success", proof_of_delivery_url: "https://proof.invalid/r", ...data } }),
    );

  it("23: a receipt matched by drop_id changes only proof_url (never status, outcome or enrollment)", async () => {
    const fake = createFakeDropStore([drop({ drop_id: "dc-1" })]);
    const before = { ...fake.drops[0] };
    expect(await handleDropStatusEvent(fake.store, receipt({ drop_id: "dc-1", to: "+18165550101", campaign_type: "rvm" }), NOW)).toBe("applied");
    expect(fake.drops[0]).toEqual({ ...before, proof_url: "https://proof.invalid/r" });
    expect(fake.resolved).toEqual([]);
  });

  it("23: a receipt with campaign_type voice is ignored even with a matching drop_id", async () => {
    const fake = createFakeDropStore([drop({ drop_id: "dc-1" })]);
    expect(await handleDropStatusEvent(fake.store, receipt({ drop_id: "dc-1", campaign_type: "voice" }), NOW)).toBe("unmatched");
    expect(fake.drops[0].proof_url).toBeUndefined();
  });

  it("R2-1: a broadcast receipt to the same phone with no stored drop_id is unmatched; the real 4016 still pauses", async () => {
    const fake = createFakeDropStore([drop({ attempt_outcome: "unknown" })]);
    expect(await handleDropStatusEvent(fake.store, receipt({ drop_id: "bc-9", to: "+18165550101" }, "evt-bcr"), NOW)).toBe("unmatched");
    expect(await handleDropStatusEvent(fake.store, receipt({ to: "+18165550101", campaign_type: "rvm" }, "evt-bcr2"), NOW)).toBe("unmatched");
    expect(fake.drops[0]).toMatchObject({ status: "queued", drop_id: null });
    const real = statusEvent({ drop_id: "dc-1", to: "+18165550101", status: "failure", reason_code: 4016 }, { event_id: "evt-real" });
    expect(await handleDropStatusEvent(fake.store, real, NOW)).toBe("applied");
    expect(fake.drops[0]).toMatchObject({ status: "failed", drop_id: "dc-1" });
    expect(fake.paused).toEqual([{ enrollmentId: "enr-1", reason: PAUSE_VOICEMAIL_DROP_CONSENT }]);
    expect(fake.enrollments["enr-1"]).toEqual({ status: "paused", pause_reason: PAUSE_VOICEMAIL_DROP_CONSENT, current_step_index: 1 });
  });

  it("delivery-class and unclassified failures via webhook do not pause", async () => {
    const fake = createFakeDropStore([drop({ drop_id: "dc-1" }), drop({ id: OTHER_ROW_ID, drop_id: "dc-2", to_phone: "+18165550202" })]);
    await handleDropStatusEvent(fake.store, statusEvent({ drop_id: "dc-1", status: "failure", reason_code: 4002 }), NOW);
    await handleDropStatusEvent(fake.store, statusEvent({ drop_id: "dc-2", status: "failure", reason_code: 7777 }, { event_id: "evt-2" }), NOW);
    expect(fake.paused).toEqual([]);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

describe("late and replayed outcomes never flip a terminal drop", () => {
  it("a failure callback after delivered keeps delivered and does not pause", async () => {
    const fake = createFakeDropStore([drop({ status: "delivered", reason_code: "0" })]);
    await handleDropCallback(fake.store, callback({ status: "failure", reason_code: 4016, proof_of_delivery_url: "https://proof.invalid/late" }));
    expect(fake.drops[0]).toMatchObject({ status: "delivered", reason_code: "0", proof_url: "https://proof.invalid/late" });
    expect(fake.paused).toEqual([]);
  });

  it("a success webhook after failed keeps failed", async () => {
    const fake = createFakeDropStore([drop({ drop_id: "dc-1", status: "failed", reason_code: "4001" })]);
    expect(await handleDropStatusEvent(fake.store, statusEvent({ drop_id: "dc-1", status: "success" }), NOW)).toBe("applied");
    expect(fake.drops[0]).toMatchObject({ status: "failed", reason_code: "4001" });
  });

  it("a replayed same-state failure callback does not pause or report again", async () => {
    const fake = createFakeDropStore([drop()]);
    await handleDropCallback(fake.store, callback({ status: "failure", reason_code: 5555 }));
    await handleDropCallback(fake.store, callback({ status: "failure", reason_code: 5555 }));
    expect(fake.drops[0].status).toBe("failed");
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

describe("reconciling a drop held at attempt_outcome unknown", () => {
  const held = () =>
    createFakeDropStore(
      [drop({ attempt_outcome: "unknown" })],
      { "run-1": { attempt_outcome: "unknown", claim_active: true } },
      { "enr-1": { status: "paused", pause_reason: "reconciliation_required", current_step_index: 0 } },
    );

  it("a callback proves it queued: run accepted (claim kept), enrollment advanced, outcome applied", async () => {
    const fake = held();
    expect((await handleDropCallback(fake.store, callback({}))).status).toBe(200);
    expect(fake.drops[0]).toMatchObject({ attempt_outcome: "queued", status: "delivered", drop_id: "dc-1" });
    expect(fake.runs["run-1"]).toEqual({ attempt_outcome: "accepted", claim_active: true, recovery_action: "voicemail_drop_reconciled" });
    expect(fake.enrollments["enr-1"]).toEqual({ status: "active", pause_reason: null, current_step_index: 1 });
  });

  it("a signed status event reconciles too, and replays are no-ops", async () => {
    const fake = held();
    const event = statusEvent({ to: "+18165550101", drop_id: "dc-7" });
    expect(await handleDropStatusEvent(fake.store, event, NOW)).toBe("applied");
    expect(await handleDropCallback(fake.store, callback({ drop_id: "dc-7" }))).toMatchObject({ status: 200 });
    expect(await handleDropStatusEvent(fake.store, statusEvent({ to: "+18165550101", drop_id: "dc-7" }, { event_id: "evt-9" }), NOW)).toBe("applied");
    expect(fake.enrollments["enr-1"].current_step_index).toBe(1);
    expect(fake.runs["run-1"].attempt_outcome).toBe("accepted");
    expect(fake.drops[0]).toMatchObject({ attempt_outcome: "queued", status: "delivered" });
  });

  it("a held drop whose failure is consent-class lands paused on the next step in one write", async () => {
    const fake = held();
    await handleDropCallback(fake.store, callback({ status: "failure", reason_code: 4016 }));
    expect(fake.runs["run-1"].attempt_outcome).toBe("accepted");
    expect(fake.paused).toEqual([{ enrollmentId: "enr-1", reason: PAUSE_VOICEMAIL_DROP_CONSENT }]);
    expect(fake.enrollments["enr-1"]).toEqual({ status: "paused", pause_reason: PAUSE_VOICEMAIL_DROP_CONSENT, current_step_index: 1 });
  });

  it("14: callback replays and a duplicate event id never advance twice; the duplicate is skipped", async () => {
    const fake = held();
    await handleDropCallback(fake.store, callback({}));
    await handleDropCallback(fake.store, callback({}));
    const event = statusEvent({ drop_id: "dc-1" }, { event_id: "evt-dup" });
    expect(await handleDropStatusEvent(fake.store, event, NOW)).toBe("applied");
    expect(await handleDropStatusEvent(fake.store, event, NOW)).toBe("duplicate");
    expect(fake.enrollments["enr-1"]).toEqual({ status: "active", pause_reason: null, current_step_index: 1 });
    expect(fake.resolved).toHaveLength(3);
  });

  it("a drop skipped before the POST (status skipped) is never reconciled", async () => {
    const fake = createFakeDropStore(
      [drop({ attempt_outcome: "unknown", status: "skipped" })],
      { "run-1": { attempt_outcome: "unknown", claim_active: true } },
      { "enr-1": { status: "paused", pause_reason: "reconciliation_required", current_step_index: 0 } },
    );
    await handleDropCallback(fake.store, callback({}));
    expect(fake.runs["run-1"].attempt_outcome).toBe("unknown");
    expect(fake.enrollments["enr-1"].status).toBe("paused");
  });

  it("an enrollment a human already moved is left alone; the run is still marked accepted", async () => {
    const fake = createFakeDropStore(
      [drop({ attempt_outcome: "unknown" })],
      { "run-1": { attempt_outcome: "unknown", claim_active: true } },
      { "enr-1": { status: "opted_out", pause_reason: null, current_step_index: 0 } },
    );
    await handleDropCallback(fake.store, callback({}));
    expect(fake.runs["run-1"].attempt_outcome).toBe("accepted");
    expect(fake.enrollments["enr-1"]).toEqual({ status: "opted_out", pause_reason: null, current_step_index: 0 });
  });
});
