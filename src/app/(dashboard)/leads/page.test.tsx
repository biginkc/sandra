import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  fetchLeadBoardData,
  getCallerMemberships,
  loadOrgTeamMembers,
  loadTeamMembersForOrgs,
  notFound,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  fetchLeadBoardData: vi.fn(),
  getCallerMemberships: vi.fn(),
  loadOrgTeamMembers: vi.fn(),
  loadTeamMembersForOrgs: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/auth/memberships", () => ({
  getCallerMemberships,
  getCallerMembershipsOrThrow: getCallerMemberships,
}));
vi.mock("@/lib/auth/team-roster", () => ({
  loadOrgTeamMembers,
  loadTeamMembersForOrgs,
}));
vi.mock("next/navigation", () => ({ notFound }));
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
  loadOrgTeamMembers.mockReset();
  loadTeamMembersForOrgs.mockReset();
  createClient.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }),
    },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({ data: [] }),
        }),
        in: vi.fn((_column: string, ids: string[]) =>
          Promise.resolve({
            data: ids.map((id) => ({ id, name: `Org ${id}` })),
            error: null,
          }),
        ),
      }),
    }),
  });
  loadTeamMembersForOrgs.mockResolvedValue([]);
  loadOrgTeamMembers.mockResolvedValue([]);
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
  it("uses every current server membership for the initial board load", async () => {
    const orgIds = [
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    getCallerMemberships.mockResolvedValue([
      { user_id: "user-1", org_id: orgIds[0], role: "member" },
      { user_id: "user-1", org_id: orgIds[1], role: "member" },
    ]);

    await LeadsPage({ searchParams: Promise.resolve({}) });

    expect(fetchLeadBoardData).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ orgIds }),
    );
  });

  it("denies the Leads board when no active caller membership resolves", async () => {
    getCallerMemberships.mockResolvedValue([]);

    await expect(
      LeadsPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("notFound");

    expect(fetchLeadBoardData).not.toHaveBeenCalled();
  });

  it("denies the Leads board to an active Acquisitions member before board reads", async () => {
    getCallerMemberships.mockResolvedValue([
      {
        user_id: "user-1",
        org_id: "org-1",
        role: "member",
        acquisitions_enabled: true,
        access_status: "active",
        access_expires_at: null,
        deletion_prepared_at: null,
      },
    ]);

    await expect(LeadsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "notFound",
    );
    expect(fetchLeadBoardData).not.toHaveBeenCalled();
  });

  it.each([
    [
      "owner",
      {
        user_id: "owner-1",
        org_id: "org-1",
        role: "owner" as const,
        acquisitions_enabled: false,
      },
    ],
    [
      "non-Acquisitions member",
      {
        user_id: "user-1",
        org_id: "org-1",
        role: "member" as const,
        acquisitions_enabled: false,
      },
    ],
  ])("keeps the Leads board available to an %s", async (_label, membership) => {
    getCallerMemberships.mockResolvedValue([membership]);

    await expect(LeadsPage({ searchParams: Promise.resolve({}) })).resolves.toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
    expect(fetchLeadBoardData).toHaveBeenCalled();
  });
});
