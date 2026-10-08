import { describe, expect, it, vi } from "vitest";

import { captureUndoSnapshot, recordJevActionUndo, undoJevAction } from "./undo";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

const UNDO_ID = "11111111-1111-4111-8111-111111111111";

describe("captureUndoSnapshot", () => {
  it("reads the prior disposition and follow-up date", async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { outreach_dispo: null, follow_up_at: "2026-10-20T00:00:00Z" },
              error: null,
            }),
          }),
        }),
      }),
    };
    expect(await captureUndoSnapshot(supabase as never, "p1")).toEqual({
      outreachDispo: null,
      followUpAt: "2026-10-20T00:00:00Z",
    });
  });
});

describe("recordJevActionUndo", () => {
  it("stores prior state and the paused enrollment ids", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const supabase = {
      from: vi.fn((table: string) =>
        table === "properties"
          ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { follow_up_at: "2026-10-25T00:00:00Z", decision_context_revision: 7 }, error: null }) }) }) }
          : { insert },
      ),
    };
    await recordJevActionUndo(supabase as never, {
      orgId: "o",
      propertyId: "p",
      inboundMessageId: "m",
      classificationRunId: "c",
      action: "wrong_number",
      appliedDispo: "wrong_number",
      snapshot: { outreachDispo: "nurture", followUpAt: "2026-10-20T00:00:00Z" },
      pausedEnrollmentIds: ["e1", "e2"],
    });
    expect(supabase.from).toHaveBeenCalledWith("jev_action_undo");
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        prior_outreach_dispo: "nurture",
        prior_follow_up_at: "2026-10-20T00:00:00Z",
        applied_follow_up_at: "2026-10-25T00:00:00Z",
        recorded_revision: 7,
        paused_enrollment_ids: ["e1", "e2"],
      }),
    );
  });

  it("writes nothing without a snapshot or inbound message", async () => {
    const insert = vi.fn();
    const supabase = { from: () => ({ insert }) };
    await recordJevActionUndo(supabase as never, {
      orgId: "o", propertyId: "p", inboundMessageId: "m", classificationRunId: null,
      action: "nurture", appliedDispo: "nurture", snapshot: null,
    });
    await recordJevActionUndo(supabase as never, {
      orgId: "o", propertyId: "p", inboundMessageId: null, classificationRunId: null,
      action: "nurture", appliedDispo: "nurture", snapshot: { outreachDispo: null, followUpAt: null },
    });
    expect(insert).not.toHaveBeenCalled();
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
