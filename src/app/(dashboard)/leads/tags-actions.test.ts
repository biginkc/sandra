import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  recordLeadEvent: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: {
    TAG_APPLIED: "tag_applied",
    TAG_REMOVED: "tag_removed",
  },
  recordLeadEvent: mocks.recordLeadEvent,
}));

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { applyPropertyTag, removePropertyTag } from "./tags-actions";

function makeClient(options: {
  savedApply?: { id: string } | null;
  removed?: { id: string } | null;
}) {
  const tagQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: { name: "Needs roof", category: "custom", system_managed: false },
      error: null,
    }),
  };
  tagQuery.select.mockReturnValue(tagQuery);
  tagQuery.eq.mockReturnValue(tagQuery);

  const applyResult = {
    select: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: options.savedApply ?? null,
      error: null,
    }),
  };
  applyResult.select.mockReturnValue(applyResult);

  const removeResult = {
    eq: vi.fn(),
    select: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: options.removed ?? null,
      error: null,
    }),
  };
  removeResult.eq.mockReturnValue(removeResult);
  removeResult.select.mockReturnValue(removeResult);

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "00000000-0000-4000-8000-000000000001" } },
      }),
    },
    from: vi.fn((table: string) => {
      if (table === "tags") return tagQuery;
      if (table === "property_tags") {
        return {
          upsert: vi.fn(() => applyResult),
          delete: vi.fn(() => removeResult),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    }),
  };
}

beforeEach(() => {
  mocks.createClient.mockReset();
  mocks.recordLeadEvent.mockReset().mockResolvedValue(undefined);
});

describe("property tag events", () => {
  it("records a tag only when the membership insert persisted", async () => {
    mocks.createClient.mockResolvedValue(makeClient({ savedApply: { id: "pt-1" } }));

    await expect(applyPropertyTag("property-1", "tag-1")).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(mocks.recordLeadEvent).toHaveBeenCalledWith({
      propertyId: "property-1",
      actorType: "user",
      actorId: "00000000-0000-4000-8000-000000000001",
      eventType: "tag_applied",
      payload: { tag_id: "tag-1", label: "Needs roof" },
    });
  });

  it("does not record an already-applied tag", async () => {
    mocks.createClient.mockResolvedValue(makeClient({ savedApply: null }));

    await applyPropertyTag("property-1", "tag-1");
    expect(mocks.recordLeadEvent).not.toHaveBeenCalled();
  });

  it("records a tag removal only when a membership was deleted", async () => {
    mocks.createClient.mockResolvedValue(makeClient({ removed: { id: "pt-1" } }));

    await expect(removePropertyTag("property-1", "tag-1")).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(mocks.recordLeadEvent).toHaveBeenCalledWith({
      propertyId: "property-1",
      actorType: "user",
      actorId: "00000000-0000-4000-8000-000000000001",
      eventType: "tag_removed",
      payload: { tag_id: "tag-1", label: "Needs roof" },
    });
  });

  it("does not record a tag removal when no membership existed", async () => {
    mocks.createClient.mockResolvedValue(makeClient({ removed: null }));

    await removePropertyTag("property-1", "tag-1");
    expect(mocks.recordLeadEvent).not.toHaveBeenCalled();
  });
});
