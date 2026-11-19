import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn(), report: vi.fn() }));
vi.mock("@/lib/leads/homeowner-houses", () => ({ loadHomeownerHouses: mocks.load }));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.report }));

import { loadLeadOwnerHouses } from "./lead-owner-houses";

beforeEach(() => vi.resetAllMocks());

describe("loadLeadOwnerHouses", () => {
  it("reads the lead's homeowner in the lead's org on the given client", async () => {
    const client = {};
    mocks.load.mockResolvedValue({ c1: { count: 3, houses: [] } });
    expect(await loadLeadOwnerHouses(client, { orgId: "org-1", viewerId: "u1", contactId: "c1" })).toEqual({ count: 3, houses: [] });
    expect(mocks.load).toHaveBeenCalledWith(client, { orgId: "org-1", viewerId: "u1", contactIds: ["c1"] });
  });
  it("is null without a homeowner, without reading", async () => {
    expect(await loadLeadOwnerHouses({}, { orgId: "org-1", viewerId: "u1", contactId: null })).toBeNull();
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("reports a failed read and shows no badge instead of failing the page", async () => {
    mocks.load.mockRejectedValue(new Error("boom"));
    expect(await loadLeadOwnerHouses({}, { orgId: "org-1", viewerId: "u1", contactId: "c1" })).toBeNull();
    expect(mocks.report).toHaveBeenCalledTimes(1);
  });
});
