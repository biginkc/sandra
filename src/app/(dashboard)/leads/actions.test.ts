import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createClient,
}));

vi.mock("@/lib/errors/report", () => ({
  reportError: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { addPropertiesToListBulk } from "./actions";

type StubResult<T> = {
  data: T | null;
  error: { code?: string; message: string } | null;
};

type UpsertCapture = {
  rows: Array<{
    org_id: string;
    property_id: string;
    list_id: string;
    last_added_at: string;
    last_added_by: string | null;
  }>;
  options: { onConflict?: string; ignoreDuplicates?: boolean } | null;
};

function makeSupabase(opts: {
  lookupResult: StubResult<{ id: string; org_id: string }[]>;
  upsertResult: StubResult<null>;
  user: StubResult<{ user: { id: string } | null }>;
  capture: UpsertCapture;
}) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue(opts.user),
    },
    from: vi.fn((table: string) => {
      if (table === "properties") {
        return {
          select: () => ({
            in: () => Promise.resolve(opts.lookupResult),
          }),
        };
      }
      if (table === "property_lists") {
        return {
          upsert: (
            rows: UpsertCapture["rows"],
            options: { onConflict?: string; ignoreDuplicates?: boolean },
          ) => {
            opts.capture.rows.push(...rows);
            opts.capture.options = options;
            return Promise.resolve(opts.upsertResult);
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };
}

beforeEach(() => {
  createClient.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("addPropertiesToListBulk", () => {
  it("no-ops when the property id list is empty", async () => {
    const result = await addPropertiesToListBulk([], "list-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ succeeded: 0, skipped: 0, failed: [] });
    }
    expect(createClient).not.toHaveBeenCalled();
  });

  it("upserts one row per property with matching org_id and list_id", async () => {
    const capture: UpsertCapture = { rows: [], options: null };
    createClient.mockResolvedValue(
      makeSupabase({
        lookupResult: {
          data: [
            { id: "p1", org_id: "org-1" },
            { id: "p2", org_id: "org-1" },
            { id: "p3", org_id: "org-1" },
          ],
          error: null,
        },
        upsertResult: { data: null, error: null },
        user: { data: { user: { id: "user-42" } }, error: null },
        capture,
      }),
    );

    const result = await addPropertiesToListBulk(
      ["p1", "p2", "p3"],
      "list-pkc",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.succeeded).toBe(3);
      expect(result.data.failed).toEqual([]);
    }

    expect(capture.rows).toHaveLength(3);
    expect(capture.rows.map((r) => r.property_id).sort()).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
    for (const row of capture.rows) {
      expect(row.list_id).toBe("list-pkc");
      expect(row.org_id).toBe("org-1");
      expect(row.last_added_by).toBe("user-42");
      expect(typeof row.last_added_at).toBe("string");
    }
    expect(capture.options).toEqual({
      onConflict: "property_id,list_id",
      ignoreDuplicates: false,
    });
  });

  it("records ids the lookup did not return as failed entries", async () => {
    const capture: UpsertCapture = { rows: [], options: null };
    createClient.mockResolvedValue(
      makeSupabase({
        lookupResult: {
          data: [{ id: "p1", org_id: "org-1" }],
          error: null,
        },
        upsertResult: { data: null, error: null },
        user: { data: { user: null }, error: null },
        capture,
      }),
    );

    const result = await addPropertiesToListBulk(
      ["p1", "p-missing"],
      "list-1",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.succeeded).toBe(1);
      expect(result.data.failed).toEqual([
        { propertyId: "p-missing", message: "Property not found" },
      ]);
    }
    expect(capture.rows).toHaveLength(1);
    expect(capture.rows[0].last_added_by).toBeNull();
  });

  it("returns ADD_TO_LIST_FAILED when the lookup query errors", async () => {
    const capture: UpsertCapture = { rows: [], options: null };
    createClient.mockResolvedValue(
      makeSupabase({
        lookupResult: {
          data: null,
          error: { code: "42501", message: "permission denied" },
        },
        upsertResult: { data: null, error: null },
        user: { data: { user: { id: "u-1" } }, error: null },
        capture,
      }),
    );

    const result = await addPropertiesToListBulk(["p1"], "list-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ADD_TO_LIST_FAILED");
      expect(result.error.message).toMatch(/permission denied/);
    }
    expect(capture.rows).toHaveLength(0);
  });
});
