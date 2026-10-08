import { describe, expect, it, vi } from "vitest";

import { recordPausedEnrollmentsForUndo, undoJevAction } from "./undo";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

const UNDO_ID = "11111111-1111-4111-8111-111111111111";

describe("recordPausedEnrollmentsForUndo", () => {
  it("stores the enrollment ids Jev's wrong_number paused on the undo row (state itself is written by the RPC)", async () => {
    const calls: Array<{ values: unknown; filters: Array<[string, unknown]> }> = [];
    const supabase = {
      from: vi.fn(() => {
        const rec = { values: undefined as unknown, filters: [] as Array<[string, unknown]> };
        const c: Record<string, unknown> = {};
        c.update = (v: unknown) => {
          rec.values = v;
          calls.push(rec);
          return c;
        };
        c.eq = (k: string, v: unknown) => (rec.filters.push([k, v]), c);
        c.is = (k: string, v: unknown) => (rec.filters.push([k, v]), Promise.resolve({ error: null }));
        return c;
      }),
    };
    await recordPausedEnrollmentsForUndo(supabase as never, { inboundMessageId: "m", pausedEnrollmentIds: ["e1", "e2"] });
    expect(supabase.from).toHaveBeenCalledWith("jev_action_undo");
    expect(calls[0]).toEqual({
      values: { paused_enrollment_ids: ["e1", "e2"] },
      filters: [["source_inbound_message_id", "m"], ["undone_at", null]],
    });
  });

  it("writes nothing when there is nothing to record", async () => {
    const supabase = { from: vi.fn() };
    await recordPausedEnrollmentsForUndo(supabase as never, { inboundMessageId: "m", pausedEnrollmentIds: [] });
    await recordPausedEnrollmentsForUndo(supabase as never, { inboundMessageId: null, pausedEnrollmentIds: ["e"] });
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe("undoJevAction", () => {
  it("restores via the RPC and resumes the drips Jev paused", async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === "fn_undo_jev_action") {
        return { data: { status: "undone", enrollmentIds: ["e1", "e2"] }, error: null };
      }
      return { data: [{ outcome: "resumed" }], error: null };
    });
    const result = await undoJevAction({ rpc } as never, UNDO_ID);
    expect(result).toEqual({ ok: true, status: "undone", resumed: 2, resumeFailed: 0 });
    expect(rpc).toHaveBeenCalledWith("resume_sequence_enrollment", {
      p_enrollment_id: "e1",
      p_expected_pause_reason: "inbound_reply",
    });
  });

  it("refuses when a person changed the lead since (STATE_CHANGED) and resumes nothing", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "STATE_CHANGED" } }));
    const result = await undoJevAction({ rpc } as never, UNDO_ID);
    expect(result).toMatchObject({ ok: false, code: "STATE_CHANGED" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: an already-undone record resumes nothing", async () => {
    const rpc = vi.fn(async () => ({ data: { status: "already_undone", enrollmentIds: [] }, error: null }));
    expect(await undoJevAction({ rpc } as never, UNDO_ID)).toEqual({
      ok: true, status: "already_undone", resumed: 0, resumeFailed: 0,
    });
  });

  it("counts a failed resume but still reports the restore", async () => {
    const rpc = vi.fn(async (name: string) =>
      name === "fn_undo_jev_action"
        ? { data: { status: "undone", enrollmentIds: ["e1"] }, error: null }
        : { data: null, error: { message: "boom" } },
    );
    expect(await undoJevAction({ rpc } as never, UNDO_ID)).toEqual({
      ok: true, status: "undone", resumed: 0, resumeFailed: 1,
    });
  });
});
