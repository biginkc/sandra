import { beforeEach, describe, expect, it, vi } from "vitest";

const { createAdminClient } = vi.hoisted(() => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));

import { validateActiveAssigneeForProperties } from "./assignment-safety";

beforeEach(() => {
  createAdminClient.mockReset();
});

function queryResult(data: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "is", "or"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data, error: null }).then(resolve);
  return builder;
}

describe("validateActiveAssigneeForProperties", () => {
  it("accepts only when the target has active membership in every property organization", async () => {
    const propertyQuery = queryResult([
      { id: "property-a", org_id: "org-a" },
      { id: "property-b", org_id: "org-b" },
    ]);
    const membershipQuery = queryResult([{ org_id: "org-a" }, { org_id: "org-b" }]);
    const supabase = { from: vi.fn(() => propertyQuery) };
    createAdminClient.mockReturnValue({ from: vi.fn(() => membershipQuery) });

    const result = await validateActiveAssigneeForProperties(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      ["property-a", "property-b"],
      "target-user",
      "2026-08-16T00:00:00.000Z",
    );

    expect(result.ok).toBe(true);
    expect((membershipQuery.eq as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("access_status", "active");
    expect((membershipQuery.or as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "access_expires_at.is.null,access_expires_at.gt.2026-08-16T00:00:00.000Z",
    );
  });

  it("rejects a forged non-member target for a single lead", async () => {
    const propertyQuery = queryResult([{ id: "property-a", org_id: "org-a" }]);
    const membershipQuery = queryResult([]);
    createAdminClient.mockReturnValue({ from: vi.fn(() => membershipQuery) });

    const result = await validateActiveAssigneeForProperties(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { from: vi.fn(() => propertyQuery) } as any,
      ["property-a"],
      "forged-user",
    );
    expect(result).toMatchObject({ ok: false, code: "INVALID_ASSIGNEE" });
  });

  it("rejects a mixed-org bulk assignment when the target is missing any org", async () => {
    const propertyQuery = queryResult([
      { id: "property-a", org_id: "org-a" },
      { id: "property-b", org_id: "org-b" },
    ]);
    const membershipQuery = queryResult([{ org_id: "org-a" }]);
    createAdminClient.mockReturnValue({ from: vi.fn(() => membershipQuery) });

    const result = await validateActiveAssigneeForProperties(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { from: vi.fn(() => propertyQuery) } as any,
      ["property-a", "property-b"],
      "stale-user",
    );
    expect(result).toMatchObject({ ok: false, code: "INVALID_ASSIGNEE" });
  });

  it("rejects forged or stale property ids before assignment", async () => {
    const propertyQuery = queryResult([{ id: "property-a", org_id: "org-a" }]);
    const result = await validateActiveAssigneeForProperties(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { from: vi.fn(() => propertyQuery) } as any,
      ["property-a", "missing-property"],
      null,
    );
    expect(result).toMatchObject({ ok: false, code: "PROPERTY_NOT_FOUND" });
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
