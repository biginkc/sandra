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
    status: "queued",
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
    JSON.stringify({ event: "contact.rvm.status", event_id: "evt-1", data: { status: "success", reason_code: 0, ...data }, ...extra }),
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
    expect((await handleDropCallback(fake.store, callback({ foreign_id: OTHER_ROW_ID }), NOW)).status).toBe(404);
    expect((await handleDropCallback(fake.store, callback({ foreign_id: "not-a-uuid" }), NOW)).status).toBe(404);
    expect((await handleDropCallback(fake.store, callback({ foreign_id: undefined }), NOW)).status).toBe(404);
    expect(fake.drops[0].status).toBe("queued");
  });

  it("persists drop_id, status, cost and proof", async () => {
    const fake = createFakeDropStore([drop()]);
    const res = await handleDropCallback(
      fake.store,
      callback({ product_cost: 0.03, tts_fee: 0.01, proof_of_delivery_url: "https://proof.invalid/1" }),
      NOW,
    );
    expect(res.status).toBe(200);
    expect(fake.drops[0]).toMatchObject({ drop_id: "dc-1", status: "delivered", reason_code: "0", proof_url: "https://proof.invalid/1" });
    expect(fake.drops[0].cost).toBeCloseTo(0.04);
    expect(fake.paused).toEqual([]);
  });

  it("config-class failure pauses step_misconfigured", async () => {
    const fake = createFakeDropStore([drop()]);
    await handleDropCallback(fake.store, callback({ status: "failure", reason_code: 3021, reason: "too long" }), NOW);
    expect(fake.drops[0]).toMatchObject({ status: "failed", reason_code: "3021", reason: "too long" });
    expect(fake.paused).toEqual([{ enrollmentId: "enr-1", reason: PAUSE_STEP_MISCONFIGURED }]);
  });

  it("3007 bad credentials after the 202 pauses step_misconfigured", async () => {
    const fake = createFakeDropStore([drop()]);
    await handleDropCallback(fake.store, callback({ status: "failure", reason_code: 3007 }), NOW);
    expect(fake.paused).toEqual([{ enrollmentId: "enr-1", reason: PAUSE_STEP_MISCONFIGURED }]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("consent-class failure pauses with a visible reason", async () => {
    const fake = createFakeDropStore([drop()]);
    await handleDropCallback(fake.store, callback({ status: "failure", reason_code: 4016 }), NOW);
    expect(fake.paused).toEqual([{ enrollmentId: "enr-1", reason: PAUSE_VOICEMAIL_DROP_CONSENT }]);
  });

  it("delivery-class failure only marks the drop failed", async () => {
    const fake = createFakeDropStore([drop()]);
    await handleDropCallback(fake.store, callback({ status: "failure", reason_code: 4001 }), NOW);
    expect(fake.drops[0].status).toBe("failed");
    expect(fake.paused).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("unclassified failure marks failed and reports, without pausing", async () => {
    const fake = createFakeDropStore([drop()]);
    await handleDropCallback(fake.store, callback({ status: "failure", reason_code: 5555 }), NOW);
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
      drop({ drop_id: "dc-1", status: "delivered", to_phone: "+18165550999" }),
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

  it("does not guess when two rows share a drop_id", async () => {
    const fake = createFakeDropStore([drop({ drop_id: "dc-1" }), drop({ id: OTHER_ROW_ID, drop_id: "dc-1", to_phone: "+18165550202" })]);
    expect(await handleDropStatusEvent(fake.store, statusEvent({ drop_id: "dc-1", to: "+18165550101" }), NOW)).toBe("unmatched");
  });

  it("receipt stores proof_url without changing status", async () => {
    const fake = createFakeDropStore([drop({ drop_id: "dc-1" })]);
    const receipt = parseDropCowboyStatusWebhook(
      JSON.stringify({ event: "contact.rvm.receipt", event_id: "evt-r", data: { drop_id: "dc-1", status: "success", proof_of_delivery_url: "https://proof.invalid/r" } }),
    );
    expect(await handleDropStatusEvent(fake.store, receipt, NOW)).toBe("applied");
    expect(fake.drops[0]).toMatchObject({ status: "queued", proof_url: "https://proof.invalid/r" });
  });

  it("delivery-class and unclassified failures via webhook do not pause", async () => {
    const fake = createFakeDropStore([drop({ drop_id: "dc-1" })]);
    await handleDropStatusEvent(fake.store, statusEvent({ drop_id: "dc-1", status: "failure", reason_code: 4002 }), NOW);
    await handleDropStatusEvent(fake.store, statusEvent({ drop_id: "dc-1", status: "failure", reason_code: 7777 }, { event_id: "evt-2" }), NOW);
    expect(fake.paused).toEqual([]);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
