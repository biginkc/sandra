import { describe, expect, it, vi } from "vitest";

import {
  loadSandraMemberships,
  SANDRA_ORG_ID,
} from "./membership-inventory";

function mockAdmin(pages: Array<Array<{ user_id: string; role: string }>>) {
  const range = vi.fn(async () => ({
    data: pages.shift() ?? [],
    error: null,
  }));
  const order = vi.fn(() => ({ range }));
  const eq = vi.fn(() => ({ order }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { client: { from }, from, select, eq, order, range };
}

describe("loadSandraMemberships", () => {
  it("paginates beyond Supabase's single-response limit", async () => {
    const firstPage = Array.from({ length: 1_000 }, (_, index) => ({
      user_id: `user-${index}`,
      role: "member",
    }));
    const mock = mockAdmin([
      firstPage,
      [{ user_id: "user-1000", role: "owner" }],
    ]);

    const result = await loadSandraMemberships(mock.client as never);

    expect(result.error).toBeNull();
    expect(result.membershipByUser).toHaveLength(1_001);
    expect(result.membershipByUser.get("user-1000")).toBe("owner");
    expect(mock.range).toHaveBeenNthCalledWith(1, 0, 999);
    expect(mock.range).toHaveBeenNthCalledWith(2, 1_000, 1_999);
    expect(mock.order).toHaveBeenCalledWith("user_id", { ascending: true });
  });

  it("filters out roles belonging to other organizations", async () => {
    const mock = mockAdmin([[{ user_id: "same-user", role: "owner" }]]);

    const result = await loadSandraMemberships(mock.client as never);

    expect(mock.eq).toHaveBeenCalledWith("org_id", SANDRA_ORG_ID);
    expect(result.membershipByUser.get("same-user")).toBe("owner");
  });
});
