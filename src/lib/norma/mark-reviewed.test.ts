import { describe, expect, it, vi } from "vitest";

import { markNormaReviewedCore, markReviewedText, type MarkNormaReviewedResult } from "./mark-reviewed";
import { NORMA_OUTCOME_LABELS, normaOutcomeLabel } from "./outcome-labels";
import { fakeClient } from "./test-helpers";
import { normaOutcomeTone, normaRequestTone } from "./tone";

const PROPERTY_ID = "55555555-5555-4555-8555-555555555555";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

function setup(opts: { userId?: string | null; answer?: unknown; throws?: boolean } = {}) {
  const rpc = vi.fn().mockImplementation(() => {
    if (opts.throws) throw new Error("boom");
    return "answer" in opts ? opts.answer : { result: "reviewed", status: "completed", task_closed: true, drips_kept_paused: 1 };
  });
  const admin = fakeClient({}, { fn_norma_mark_reviewed: rpc });
  const getUserId = vi.fn(async () => (opts.userId === undefined ? "user-1" : opts.userId));
  const run = (property = PROPERTY_ID, request = REQUEST_ID) =>
    markNormaReviewedCore(property, request, { getUserId, adminClient: admin.client });
  return { run, rpc, getUserId };
}

describe("markNormaReviewedCore", () => {
  it("passes the SESSION user, never anything the caller supplies, to the RPC", async () => {
    const t = setup({ userId: "session-user" });
    expect(await t.run()).toEqual({ ok: true, code: "reviewed" });
    expect(t.rpc).toHaveBeenCalledWith({ p_request_id: REQUEST_ID, p_property_id: PROPERTY_ID, p_user_id: "session-user" });
  });

  it("signed out: no RPC call at all", async () => {
    const t = setup({ userId: null });
    expect(await t.run()).toEqual({ ok: false, code: "unauthenticated" });
    expect(t.rpc).not.toHaveBeenCalled();
  });

  it("malformed ids are refused before the session is even read", async () => {
    const t = setup();
    for (const bad of ["p1", "", "../x", "5555555555554555855555555555555"]) {
      expect(await t.run(bad)).toEqual({ ok: false, code: "not_found" });
      expect(await t.run(PROPERTY_ID, bad)).toEqual({ ok: false, code: "not_found" });
    }
    expect(t.getUserId).not.toHaveBeenCalled();
    expect(t.rpc).not.toHaveBeenCalled();
  });

  it("a replay is a success", async () => {
    const t = setup({ answer: { result: "already_reviewed", status: "completed" } });
    expect(await t.run()).toEqual({ ok: true, code: "already_reviewed" });
  });

  it("maps every refusal and fails closed on errors or an unexpected answer", async () => {
    expect(await setup({ answer: { result: "invalid_state", status: "dispatched" } }).run()).toEqual({ ok: false, code: "not_waiting", status: "dispatched" });
    expect(await setup({ answer: { result: "not_authorized" } }).run()).toEqual({ ok: false, code: "not_authorized" });
    expect(await setup({ answer: { result: "not_found" } }).run()).toEqual({ ok: false, code: "not_found" });
    expect(await setup({ throws: true }).run()).toEqual({ ok: false, code: "error" });
    expect(await setup({ answer: { result: "something_new" } }).run()).toEqual({ ok: false, code: "error" });
    expect(await setup({ answer: null as never }).run()).toEqual({ ok: false, code: "error" });
  });

  it("plain, rep-facing wording; success is a success tone, everything else an error", () => {
    const results: MarkNormaReviewedResult[] = [
      { ok: true, code: "reviewed" },
      { ok: true, code: "already_reviewed" },
      { ok: false, code: "unauthenticated" },
      { ok: false, code: "not_found" },
      { ok: false, code: "not_authorized" },
      { ok: false, code: "error" },
      { ok: false, code: "not_waiting", status: "completed" },
    ];
    for (const r of results) {
      const text = markReviewedText(r);
      expect(text.tone).toBe(r.ok ? "success" : "error");
      expect(text.text.length).toBeGreaterThan(5);
      expect(text.text).not.toMatch(/seller|norma_call|fn_norma/i);
    }
    expect(markReviewedText({ ok: true, code: "reviewed" }).text).toBe("Marked as reviewed.");
  });
});

describe("the reviewed outcome", () => {
  it("has its own plain label and a quiet tone (nothing is waiting, nobody was reached)", () => {
    expect(NORMA_OUTCOME_LABELS.reviewed).toBe("Reviewed by a person");
    expect(normaOutcomeLabel("reviewed")).toBe("Reviewed by a person");
    expect(normaOutcomeTone("reviewed")).toBe("neutral");
    expect(normaRequestTone("completed", "reviewed")).toBe("neutral");
  });
});
