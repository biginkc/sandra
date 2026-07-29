import { afterEach, describe, expect, it, vi } from "vitest";

import {
  describeSandraAccess,
  loadSandraMemberships,
  SANDRA_ORG_ID,
} from "./membership-inventory";

type MembershipFixture = {
  user_id: string;
  role: string;
  access_status?: string | null;
  access_expires_at?: string | null;
  deletion_prepared_at?: string | null;
};

function membership(
  fixture: Pick<MembershipFixture, "user_id" | "role"> &
    Partial<MembershipFixture>,
): MembershipFixture {
  return {
    access_status: "active",
    access_expires_at: null,
    deletion_prepared_at: null,
    ...fixture,
  };
}

function mockAdmin(pages: Array<MembershipFixture[]>) {
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
  afterEach(() => {
    vi.useRealTimers();
  });

  it("paginates beyond Supabase's single-response limit", async () => {
    const firstPage = Array.from({ length: 1_000 }, (_, index) =>
      membership({
        user_id: `user-${index}`,
        role: "member",
      }),
    );
    const mock = mockAdmin([
      firstPage,
      [membership({ user_id: "user-1000", role: "owner" })],
    ]);

    const result = await loadSandraMemberships(mock.client as never);

    expect(result.error).toBeNull();
    expect(result.membershipByUser).toHaveLength(1_001);
    expect(result.membershipByUser.get("user-1000")).toMatchObject({
      role: "owner",
      accessStatus: "active",
      hasActiveAccess: true,
    });
    expect(mock.range).toHaveBeenNthCalledWith(1, 0, 999);
    expect(mock.range).toHaveBeenNthCalledWith(2, 1_000, 1_999);
    expect(mock.order).toHaveBeenCalledWith("user_id", { ascending: true });
  });

  it("filters out roles belonging to other organizations", async () => {
    const mock = mockAdmin([
      [membership({ user_id: "same-user", role: "owner" })],
    ]);

    const result = await loadSandraMemberships(mock.client as never);

    expect(mock.eq).toHaveBeenCalledWith("org_id", SANDRA_ORG_ID);
    expect(result.membershipByUser.get("same-user")?.role).toBe("owner");
  });

  it.each([
    {
      label: "suspended",
      values: { access_status: "suspended" },
      expectedLabel: "suspended",
    },
    {
      label: "revoked",
      values: { access_status: "revoked" },
      expectedLabel: "revoked",
    },
    {
      label: "expired",
      values: { access_expires_at: "2026-07-29T11:59:59.000Z" },
      expectedLabel: "expired",
    },
    {
      label: "prepared for deletion",
      values: { deletion_prepared_at: "2026-07-29T11:00:00.000Z" },
      expectedLabel: "deletion prepared",
    },
  ])(
    "marks $label Hugo lifecycle state as inactive",
    async ({ values, expectedLabel }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));
      const mock = mockAdmin([
        [
          membership({
            user_id: "managed-by-hugo",
            role: "member",
            ...values,
          }),
        ],
      ]);

      const result = await loadSandraMemberships(mock.client as never);
      const saved = result.membershipByUser.get("managed-by-hugo");

      expect(saved?.hasActiveAccess).toBe(false);
      expect(describeSandraAccess(saved!)).toBe(expectedLabel);
    },
  );

  it("reads Hugo lifecycle fields without selecting any mutation surface", async () => {
    const mock = mockAdmin([
      [membership({ user_id: "existing-user", role: "member" })],
    ]);

    await loadSandraMemberships(mock.client as never);

    expect(mock.select).toHaveBeenCalledWith(
      "user_id,role,access_status,access_expires_at,deletion_prepared_at",
    );
  });
});
