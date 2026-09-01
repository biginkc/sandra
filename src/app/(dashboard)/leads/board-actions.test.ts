import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, revalidatePath, getCallerMemberships, fetchLeadBoardData } = vi.hoisted(() => ({
  createClient: vi.fn(),
  revalidatePath: vi.fn(),
  getCallerMemberships: vi.fn(),
  fetchLeadBoardData: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/auth/memberships", () => ({ getCallerMemberships }));
vi.mock("./board-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./board-query")>();
  return { ...actual, fetchLeadBoardData };
});

import { loadLeadBoardAction, setLeadNextActionAction } from "./board-actions";

beforeEach(() => {
  createClient.mockReset();
  revalidatePath.mockReset();
  getCallerMemberships.mockReset();
  fetchLeadBoardData.mockReset();
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

  it("ignores a spoofed client org and carries every server membership for replacement and load-more", async () => {
    const serverOrgId = "22222222-2222-4222-8222-222222222222";
    const secondServerOrgId = "33333333-3333-4333-8333-333333333333";
    createClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }) },
    });
    getCallerMemberships.mockResolvedValue([
      { user_id: "user-1", org_id: serverOrgId, role: "member" },
      { user_id: "user-1", org_id: secondServerOrgId, role: "member" },
    ]);
    fetchLeadBoardData.mockResolvedValue({ leads: [] });
    const input = {
      status: "new_lead" as const,
      cursor: null,
      filters: {
        search: "", ownership: "all" as const, motivation: "all" as const, urgency: "all" as const,
        attention: null, hotOnly: false, noActiveSequence: false, skipTraced: null,
      },
      orgId: "99999999-9999-4999-8999-999999999999",
    };

    await loadLeadBoardAction(input);
    await loadLeadBoardAction({
      ...input,
      status: undefined,
      cursor: undefined,
    });

    expect(fetchLeadBoardData).toHaveBeenCalledTimes(2);
    expect(
      fetchLeadBoardData.mock.calls.every(([, , context]) =>
        context.orgIds?.join(",") === `${serverOrgId},${secondServerOrgId}`,
      ),
    ).toBe(true);
    expect(fetchLeadBoardData.mock.calls[0]?.[3]).toEqual({});
    expect(fetchLeadBoardData.mock.calls[0]?.[4]).toEqual(["new_lead"]);
  });

  it("fails soft to an undecorated board when no active membership is available", async () => {
    createClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }) },
    });
    getCallerMemberships.mockResolvedValue([]);
    fetchLeadBoardData.mockResolvedValue({ leads: [{ id: "lead-1", latestContract: null }] });
    const input = {
      filters: {
        search: "", ownership: "all" as const, motivation: "all" as const, urgency: "all" as const,
        attention: null, hotOnly: false, noActiveSequence: false, skipTraced: null,
      },
    };

    const result = await loadLeadBoardAction(input);

    expect(result).toEqual({ ok: true, data: { leads: [{ id: "lead-1", latestContract: null }] } });
    expect(fetchLeadBoardData).toHaveBeenCalledWith(
      expect.anything(),
      input.filters,
      expect.objectContaining({ orgIds: [] }),
      {},
      expect.any(Array),
    );
  });
});
