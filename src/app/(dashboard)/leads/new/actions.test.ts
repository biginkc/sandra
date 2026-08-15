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

function cookieClient(orgIds: string[] = ["org-1"]) {
  const memberships = {
    select: vi.fn(() => memberships),
    eq: vi.fn().mockResolvedValue({
      data: orgIds.map((org_id) => ({ org_id })),
      error: null,
    }),
  };
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "user-me" } },
      }),
    },
    from: vi.fn(() => memberships),
  };
}

function adminMembershipResult(member: boolean) {
  const builder = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    limit: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: member ? { user_id: "user-other" } : null,
      error: null,
    }),
  };
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.in.mockReturnValue(builder);
  builder.limit.mockReturnValue(builder);
  return { from: vi.fn(() => builder) };
}

beforeEach(() => {
  vi.clearAllMocks();
  createClient.mockResolvedValue(cookieClient());
  createAdminClient.mockReturnValue(adminMembershipResult(true));
  createLead.mockResolvedValue({
    ok: true,
    data: {
      propertyId: "property-1",
      wasDuplicate: false,
      contactId: "contact-1",
      phoneDropped: null,
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
        assignedUserId: "user-me",
        motivationLevel: "hot",
      }),
    );
    expect(createAdminClient).not.toHaveBeenCalled();
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
        assignedUserId: "user-other",
        motivationLevel: "warm",
      }),
    );
  });

  it("rejects an assignee outside the current user's workspaces", async () => {
    createAdminClient.mockReturnValue(adminMembershipResult(false));

    const result = await createLeadFromForm({
      ...baseInput,
      assigned_user_id: "user-outsider",
      motivation_level: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_ASSIGNEE");
    expect(createLead).not.toHaveBeenCalled();
  });
});
