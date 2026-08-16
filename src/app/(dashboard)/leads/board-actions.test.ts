import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, revalidatePath } = vi.hoisted(() => ({
  createClient: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { loadLeadBoardAction, setLeadNextActionAction } from "./board-actions";

beforeEach(() => {
  createClient.mockReset();
  revalidatePath.mockReset();
});

describe("setLeadNextActionAction", () => {
  const input = {
    propertyId: "11111111-1111-4111-8111-111111111111",
    dueAt: "2026-08-16T14:00:00.000Z",
    idempotencyKey: "22222222-2222-4222-8222-222222222222",
  };

  it("reports zero returned rows as not saved", async () => {
    createClient.mockResolvedValue({ rpc: vi.fn().mockResolvedValue({ data: [], error: null }) });
    await expect(setLeadNextActionAction(input)).resolves.toMatchObject({
      ok: false,
      error: { code: "NEXT_ACTION_NOT_SAVED" },
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("normalizes a database DNC lock so the stale card can be removed", async () => {
    createClient.mockResolvedValue({
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { code: "P0001", message: "DNC_LOCKED: This lead is permanently read-only" },
      }),
    });
    await expect(setLeadNextActionAction(input)).resolves.toEqual({
      ok: false,
      error: { code: "DNC_LOCKED", message: "This lead is permanently read-only." },
    });
  });

  it("returns only a proven task row and refreshes its read surfaces", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ id: "task-1", title: "Follow up on 1 Main St", due_at: input.dueAt, was_created: false }],
      error: null,
    });
    createClient.mockResolvedValue({ rpc });
    await expect(setLeadNextActionAction(input)).resolves.toEqual({
      ok: true,
      data: { id: "task-1", title: "Follow up on 1 Main St", dueAt: input.dueAt, created: false },
    });
    expect(rpc).toHaveBeenCalledWith("set_lead_next_action", {
      p_property_id: input.propertyId,
      p_due_at: input.dueAt,
      p_idempotency_key: input.idempotencyKey,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/leads");
  });
});

describe("loadLeadBoardAction validation", () => {
  it("rejects an untrusted keyset cursor before it reaches PostgREST", async () => {
    const result = await loadLeadBoardAction({
      status: "new_lead",
      cursor: { dueAt: "2026-08-15T05:00:00.000Z),status.eq.closed", id: "not-a-uuid" },
      filters: {
        search: "", ownership: "all", motivation: "all", urgency: "all",
        attention: null, hotOnly: false, noActiveSequence: false, skipTraced: null,
      },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_LEAD_CURSOR" } });
    expect(createClient).not.toHaveBeenCalled();
  });
});
