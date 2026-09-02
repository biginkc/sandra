import { beforeEach, describe, expect, it, vi } from "vitest";

const { createLead, createClient, createAdminClient } = vi.hoisted(() => ({
  createLead: vi.fn(),
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/leads/create", () => ({ createLead }));
vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));

import { createLeadFromForm } from "./actions";

const baseInput = {
  source: "cold_call",
  address: "123 Main St",
  city: "Kansas City",
  state: "MO",
  zip: "64111",
  market: "Jackson County MO",
  first_name: "Taylor",
  last_name: "Seller",
  phone_1: "",
  email: "taylor@example.com",
};

function cookieClient() {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "user-me" } },
      }),
    },
    from: vi.fn(),
  };
}

function adminMembershipResult({
  actorMemberships = [
    { org_id: "org-1", created_at: "2026-01-01T00:00:00.000Z" },
  ],
  assigneeMember = true,
}: {
  actorMemberships?: Array<{ org_id: string; created_at: string }>;
  assigneeMember?: boolean;
} = {}) {
  let queryNumber = 0;
  return {
    from: vi.fn(() => {
      const response =
        queryNumber++ === 0
          ? { data: actorMemberships, error: null }
          : {
              data: assigneeMember ? { user_id: "user-other" } : null,
              error: null,
            };
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "or", "order", "limit"]) {
        builder[method] = vi.fn(() => builder);
      }
      builder.maybeSingle = vi.fn().mockResolvedValue(response);
      builder.then = (resolve: (value: typeof response) => unknown) =>
        Promise.resolve(response).then(resolve);
      return builder;
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createClient.mockResolvedValue(cookieClient());
  createAdminClient.mockReturnValue(adminMembershipResult());
  createLead.mockResolvedValue({
    ok: true,
    data: {
      propertyId: "property-1",
      wasDuplicate: false,
      contactId: "contact-1",
      phoneUnverified: false,
    },
  });
});

describe("createLeadFromForm quick-entry fields", () => {
  it("persists the current-user assignee and motivation through createLead", async () => {
    const result = await createLeadFromForm({
      ...baseInput,
      assigned_user_id: "user-me",
      motivation_level: "hot",
    });

    expect(result.ok).toBe(true);
    expect(createLead).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: "org-1",
        assignedUserId: "user-me",
        motivationLevel: "hot",
      }),
    );
    expect(createAdminClient).toHaveBeenCalledTimes(1);
  });

  it("persists a teammate only after shared-workspace membership is verified", async () => {
    const result = await createLeadFromForm({
      ...baseInput,
      assigned_user_id: "user-other",
      motivation_level: "warm",
    });

    expect(result.ok).toBe(true);
    expect(createLead).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: "org-1",
        assignedUserId: "user-other",
        motivationLevel: "warm",
      }),
    );
  });

  it("returns the saved-but-unverified phone flag to the form", async () => {
    createLead.mockResolvedValue({
      ok: true,
      data: {
        propertyId: "property-1",
        wasDuplicate: false,
        contactId: "contact-1",
        phoneUnverified: true,
      },
    });

    const result = await createLeadFromForm({
      ...baseInput,
      phone_1: "8165550100",
    });

    expect(result).toEqual({
      ok: true,
      data: {
        propertyId: "property-1",
        wasDuplicate: false,
        phoneUnverified: true,
      },
    });
  });

  it("rejects an assignee outside the current user's workspaces", async () => {
    createAdminClient.mockReturnValue(
      adminMembershipResult({ assigneeMember: false }),
    );

    const result = await createLeadFromForm({
      ...baseInput,
      assigned_user_id: "user-outsider",
      motivation_level: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_ASSIGNEE");
    expect(createLead).not.toHaveBeenCalled();
  });

  it("rejects creation when the creator has no active workspace", async () => {
    createAdminClient.mockReturnValue(
      adminMembershipResult({ actorMemberships: [] }),
    );

    const result = await createLeadFromForm({
      ...baseInput,
      assigned_user_id: "user-me",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "NO_ACTIVE_WORKSPACE" },
    });
    expect(createLead).not.toHaveBeenCalled();
  });

  it("uses the deterministic earliest active workspace and rejects an assignee outside it", async () => {
    createAdminClient.mockReturnValue(
      adminMembershipResult({
        actorMemberships: [
          { org_id: "org-earliest", created_at: "2025-01-01T00:00:00.000Z" },
          { org_id: "org-later", created_at: "2026-01-01T00:00:00.000Z" },
        ],
        assigneeMember: false,
      }),
    );

    const result = await createLeadFromForm({
      ...baseInput,
      assigned_user_id: "user-other",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_ASSIGNEE" },
    });
    expect(createLead).not.toHaveBeenCalled();
  });
});
