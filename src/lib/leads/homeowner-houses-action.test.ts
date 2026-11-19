import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  memberships: vi.fn(),
  load: vi.fn(),
  report: vi.fn(),
  page: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock("@/lib/auth/memberships", () => ({ getCallerMemberships: mocks.memberships }));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.report }));
vi.mock("./homeowner-houses", () => ({
  MAX_HOMEOWNER_IDS: 100,
  MAX_HOUSES_OFFSET: 100_000,
  loadHomeownerHouses: mocks.load,
  loadHomeownerHousesPage: mocks.page,
}));

import { loadHomeownerHousesAction, loadMoreHomeownerHousesAction } from "./homeowner-houses-action";

const C1 = "11111111-1111-4111-8111-111111111111";
const houses = { count: 2, houses: [] };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.memberships.mockResolvedValue([{ user_id: "user-1", org_id: "org-1", role: "member" }]);
  mocks.load.mockResolvedValue({ [C1]: houses });
});

describe("loadHomeownerHousesAction", () => {
  it("reads on the signed-in user's single org", async () => {
    expect(await loadHomeownerHousesAction([C1])).toEqual({ [C1]: houses });
    expect(mocks.load).toHaveBeenCalledWith(expect.anything(), { orgId: "org-1", viewerId: "user-1", contactIds: [C1] });
  });
  it("returns nothing when signed out", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    expect(await loadHomeownerHousesAction([C1])).toEqual({});
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("returns nothing for a member of more than one org", async () => {
    mocks.memberships.mockResolvedValue([
      { user_id: "user-1", org_id: "org-1" },
      { user_id: "user-1", org_id: "org-2" },
    ]);
    expect(await loadHomeownerHousesAction([C1])).toEqual({});
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("refuses too many or no ids without reading", async () => {
    expect(await loadHomeownerHousesAction(Array.from({ length: 101 }, () => C1))).toEqual({});
    expect(await loadHomeownerHousesAction([])).toEqual({});
    expect(mocks.getUser).not.toHaveBeenCalled();
  });
  it("reports a read error and returns nothing", async () => {
    mocks.load.mockRejectedValue(new Error("boom"));
    expect(await loadHomeownerHousesAction([C1])).toEqual({});
    expect(mocks.report).toHaveBeenCalledTimes(1);
  });
});

describe("loadMoreHomeownerHousesAction", () => {
  it("loads the next page on the signed-in user's single org", async () => {
    mocks.page.mockResolvedValue({ houses: [], count: 60, nextOffset: null });
    expect(await loadMoreHomeownerHousesAction({ contactId: C1, offset: 50 })).toEqual({ ok: true, houses: [], count: 60, nextOffset: null });
    expect(mocks.page).toHaveBeenCalledWith(expect.anything(), { orgId: "org-1", viewerId: "user-1", contactId: C1, offset: 50 });
  });
  it("rejects a bad cursor or contact without reading", async () => {
    for (const input of [
      { contactId: C1, offset: -1 },
      { contactId: C1, offset: 2.5 },
      { contactId: C1, offset: 100_001 },
      { contactId: "not-a-uuid", offset: 0 },
      { contactId: C1, offset: "50" as unknown as number },
    ])
      expect(await loadMoreHomeownerHousesAction(input)).toMatchObject({ ok: false });
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.page).not.toHaveBeenCalled();
  });
  it("refuses when signed out or in several orgs", async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: null } });
    expect(await loadMoreHomeownerHousesAction({ contactId: C1, offset: 50 })).toMatchObject({ ok: false });
    mocks.memberships.mockResolvedValueOnce([{ user_id: "user-1", org_id: "a" }, { user_id: "user-1", org_id: "b" }]);
    expect(await loadMoreHomeownerHousesAction({ contactId: C1, offset: 50 })).toMatchObject({ ok: false });
    expect(mocks.page).not.toHaveBeenCalled();
  });
  it("reports a read error", async () => {
    mocks.page.mockRejectedValue(new Error("boom"));
    expect(await loadMoreHomeownerHousesAction({ contactId: C1, offset: 50 })).toMatchObject({ ok: false });
    expect(mocks.report).toHaveBeenCalledTimes(1);
  });
});
