import { beforeEach, describe, expect, it, vi } from "vitest";

const { assignUnsafe, createClientMock } = vi.hoisted(() => ({
  assignUnsafe: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.mock("../leads/actions", () => ({
  addPropertiesToListBulk: vi.fn(),
  applyTagBulk: vi.fn(),
  assignLeadsBulk: assignUnsafe,
  createAndApplyCustomTagBulk: vi.fn(),
  deletePropertiesBulk: vi.fn(),
  qualifyLeadsBulk: vi.fn(),
  removePropertiesFromListBulk: vi.fn(),
  verifyPropertiesBulk: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));
vi.mock("./actions", () => ({ getAllMatchingProspectIds: vi.fn() }));

import { assignLeadsBulk } from "./dnc-safe-actions";

function queryResult(data: unknown) {
  const promise = Promise.resolve({ data, error: null });
  const builder = {
    select: vi.fn(),
    in: vi.fn(() => promise),
  };
  builder.select.mockReturnValue(builder);
  return builder;
}

describe("Prospects DNC-safe bulk actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assignUnsafe.mockResolvedValue({
      ok: true,
      data: { succeeded: 1, skipped: 0, failed: [] },
    });
    createClientMock.mockResolvedValue({
      from: vi.fn((table: string) =>
        table === "properties"
          ? queryResult([
              {
                id: "locked",
                outreach_dispo: null,
                homeowner: [{
                  phone_1: null,
                  phone_2: null,
                  phone_3: null,
                  do_not_contact: true,
                  sms_opted_out: false,
                }],
              },
              {
                id: "eligible",
                outreach_dispo: null,
                homeowner: [{
                  phone_1: null,
                  phone_2: null,
                  phone_3: null,
                  do_not_contact: false,
                  sms_opted_out: false,
                }],
              },
            ])
          : queryResult([]),
      ),
    });
  });

  it("rechecks DNC on the server and never forwards the locked ID to a mutation", async () => {
    const result = await assignLeadsBulk(["locked", "eligible"], "user-1");

    expect(assignUnsafe).toHaveBeenCalledWith(["eligible"], "user-1");
    expect(result).toEqual({
      ok: true,
      data: {
        succeeded: 1,
        skipped: 0,
        failed: [{
          propertyId: "locked",
          message: "Prospect is locked Do Not Contact and cannot be changed in bulk.",
        }],
      },
    });
  });
});
