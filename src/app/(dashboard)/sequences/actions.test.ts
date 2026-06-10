import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist `createClient` mock so it's installed before `actions.ts` imports it.
const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createClient,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/errors/report", () => ({
  reportError: vi.fn(),
}));

import { createSequence } from "./actions";

type InsertedRow = {
  org_id: string;
  name: string;
  description: string | null;
  append_opt_out: boolean;
  created_by: string | null;
};

type StubResult<T> = { data: T | null; error: { code?: string; message: string } | null };
type StubUser = { id?: string | null; email?: string | null } | null;

function makeSupabase(opts: {
  org: StubResult<{ id: string }>;
  user: StubResult<{ user: StubUser }>;
  insertResult: StubResult<{ id: string }>;
  insertCapture: { rows: InsertedRow[] };
}) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue(opts.user),
    },
    from: vi.fn((table: string) => {
      if (table === "organizations") {
        return {
          select: () => ({
            limit: () => ({
              maybeSingle: () => Promise.resolve(opts.org),
            }),
          }),
        };
      }
      if (table === "sequences") {
        return {
          insert: (row: InsertedRow) => {
            opts.insertCapture.rows.push(row);
            return {
              select: () => ({
                single: () => Promise.resolve(opts.insertResult),
              }),
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };
}

beforeEach(() => {
  createClient.mockReset();
  vi.stubEnv("ADMIN_EMAILS", "admin@bmhgroupkc.com");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("createSequence", () => {
  it("returns VALIDATION when name is whitespace", async () => {
    const result = await createSequence({ name: "   " });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns VALIDATION when name exceeds 120 chars", async () => {
    const result = await createSequence({ name: "x".repeat(121) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toMatch(/121 characters/);
    }
  });

  it("returns NO_ORG when no organization exists", async () => {
    const insertCapture = { rows: [] as InsertedRow[] };
    createClient.mockResolvedValue(
      makeSupabase({
        org: { data: null, error: null },
        user: {
          data: { user: { id: "u-1", email: "admin@bmhgroupkc.com" } },
          error: null,
        },
        insertResult: { data: { id: "s-1" }, error: null },
        insertCapture,
      }),
    );
    const result = await createSequence({ name: "Hi" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NO_ORG");
    }
    expect(insertCapture.rows).toHaveLength(0);
  });

  it("inserts with trimmed name + default append_opt_out=true and returns the new id", async () => {
    const insertCapture = { rows: [] as InsertedRow[] };
    createClient.mockResolvedValue(
      makeSupabase({
        org: { data: { id: "org-1" }, error: null },
        user: {
          data: { user: { id: "user-1", email: "admin@bmhgroupkc.com" } },
          error: null,
        },
        insertResult: { data: { id: "seq-42" }, error: null },
        insertCapture,
      }),
    );

    const result = await createSequence({
      name: "  RTL smoke  ",
      description: "created by vitest",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ id: "seq-42" });
    }
    expect(insertCapture.rows).toHaveLength(1);
    expect(insertCapture.rows[0]).toEqual({
      org_id: "org-1",
      name: "RTL smoke",
      description: "created by vitest",
      append_opt_out: true,
      created_by: "user-1",
    });
  });

  it("respects an explicit append_opt_out=false", async () => {
    const insertCapture = { rows: [] as InsertedRow[] };
    createClient.mockResolvedValue(
      makeSupabase({
        org: { data: { id: "org-1" }, error: null },
        user: {
          data: { user: { id: null, email: "admin@bmhgroupkc.com" } },
          error: null,
        },
        insertResult: { data: { id: "seq-43" }, error: null },
        insertCapture,
      }),
    );

    const result = await createSequence({
      name: "no opt-out",
      append_opt_out: false,
    });

    expect(result.ok).toBe(true);
    expect(insertCapture.rows[0].append_opt_out).toBe(false);
    expect(insertCapture.rows[0].created_by).toBeNull();
  });

  it("maps Postgres unique-violation 23505 to DUPLICATE_NAME", async () => {
    const insertCapture = { rows: [] as InsertedRow[] };
    createClient.mockResolvedValue(
      makeSupabase({
        org: { data: { id: "org-1" }, error: null },
        user: {
          data: { user: { id: "u-1", email: "admin@bmhgroupkc.com" } },
          error: null,
        },
        insertResult: {
          data: null,
          error: { code: "23505", message: "duplicate key" },
        },
        insertCapture,
      }),
    );

    const result = await createSequence({ name: "First touch new lead" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DUPLICATE_NAME");
      expect(result.error.message).toMatch(/already exists/);
    }
  });
});
