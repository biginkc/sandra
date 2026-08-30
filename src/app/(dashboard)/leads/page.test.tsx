import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  fetchLeadBoardData,
  getCallerMemberships,
  listOrgUsers,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  fetchLeadBoardData: vi.fn(),
  getCallerMemberships: vi.fn(),
  listOrgUsers: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/auth/memberships", () => ({ getCallerMemberships }));
vi.mock("./actions", () => ({ listOrgUsers }));
vi.mock("./board-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./board-query")>();
  return { ...actual, fetchLeadBoardData };
});

import LeadsPage from "./page";

const emptyTotals = {
  new_lead: 0,
  contacted: 0,
  interested: 0,
  appointment_set: 0,
  offer_sent: 0,
  under_contract: 0,
  closed: 0,
  dead: 0,
};

beforeEach(() => {
  createClient.mockReset();
  fetchLeadBoardData.mockReset();
  getCallerMemberships.mockReset();
  listOrgUsers.mockReset();
  createClient.mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }) },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({ data: [] }),
        }),
      }),
    }),
  });
  listOrgUsers.mockResolvedValue({ ok: true, data: [] });
  fetchLeadBoardData.mockResolvedValue({
    leads: [],
    totals: emptyTotals,
    baselineTotals: emptyTotals,
    urgencyCounts: { all: 0, overdue: 0, today: 0, scheduled: 0, none: 0 },
    nextCursors: {},
    hasMore: {},
    snapshotGenerations: {},
    unreadPropertyIds: [],
    listMemberships: {},
    customTags: {},
    lastMessageByPropertyId: {},
    latestContractByPropertyId: {},
  });
});

describe("LeadsPage organization context", () => {
  it("uses the current server membership for the initial board load", async () => {
    const orgId = "22222222-2222-4222-8222-222222222222";
    getCallerMemberships.mockResolvedValue([
      { user_id: "user-1", org_id: orgId, role: "member" },
    ]);

    await LeadsPage({ searchParams: Promise.resolve({}) });

    expect(fetchLeadBoardData).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ orgId }),
    );
  });

  it("keeps the board usable but undecorated when no active membership resolves", async () => {
    getCallerMemberships.mockResolvedValue([]);

    await LeadsPage({ searchParams: Promise.resolve({}) });

    expect(fetchLeadBoardData).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ orgId: null }),
    );
  });
});
