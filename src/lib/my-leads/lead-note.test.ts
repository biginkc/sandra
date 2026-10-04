import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), assertUnlocked: vi.fn(), report: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/dnc/property-lock", () => ({ assertPropertyDncUnlocked: mocks.assertUnlocked }));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.report }));

import { createIdempotentLeadNote } from "./lead-note";

const KEY = "22222222-2222-4222-8222-222222222222";

function noteClient(
  insertResult: { data: { id: string } | null; error: { code?: string; message: string } | null },
  existing: { id: string } | null = null,
  user: { id: string } | null = { id: "user-1" },
) {
  const inserts: Record<string, unknown>[] = [];
  const selectEq: Array<[string, unknown]> = [];
  const client = {
    auth: { getUser: async () => ({ data: { user } }) },
    from: vi.fn((table: string) => {
      if (table === "properties") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { org_id: "org-1" }, error: null }) }) }) };
      }
      return {
        insert: (row: Record<string, unknown>) => {
          inserts.push(row);
          return { select: () => ({ single: async () => insertResult }) };
        },
        select: () => {
          const chain = {
            eq: (column: string, value: unknown) => {
              selectEq.push([column, value]);
              return chain;
            },
            maybeSingle: async () => ({ data: existing, error: null }),
          };
          return chain;
        },
      };
    }),
  };
  return { client, inserts, selectEq };
}

describe("createIdempotentLeadNote", () => {
  beforeEach(() => {
    mocks.createClient.mockReset();
    mocks.assertUnlocked.mockReset();
    mocks.assertUnlocked.mockResolvedValue({ ok: true, data: undefined });
  });

  it("inserts the trimmed body with the key, stamped with the lead's org and the session user", async () => {
    const { client, inserts } = noteClient({ data: { id: "n1" }, error: null });
    mocks.createClient.mockResolvedValue(client);
    expect(await createIdempotentLeadNote("prop-1", " hello ", KEY)).toEqual({ ok: true, data: { id: "n1" } });
    expect(inserts).toEqual([{ org_id: "org-1", property_id: "prop-1", author_user_id: "user-1", body: "hello", idempotency_key: KEY }]);
  });

  it("a double submit (unique violation on the key) returns the existing note", async () => {
    const { client, selectEq } = noteClient({ data: null, error: { code: "23505", message: "duplicate key" } }, { id: "existing-note" });
    mocks.createClient.mockResolvedValue(client);
    expect(await createIdempotentLeadNote("prop-1", "hello", KEY)).toEqual({ ok: true, data: { id: "existing-note" } });
    expect(selectEq).toEqual([["org_id", "org-1"], ["idempotency_key", KEY]]);
  });

  it("any other insert error fails, and a unique violation with nothing to return fails", async () => {
    mocks.createClient.mockResolvedValue(noteClient({ data: null, error: { code: "42501", message: "denied" } }, { id: "x" }).client);
    expect(await createIdempotentLeadNote("prop-1", "hello", KEY)).toMatchObject({ ok: false, error: { code: "NOTE_CREATE_FAILED" } });
    mocks.createClient.mockResolvedValue(noteClient({ data: null, error: { code: "23505", message: "dup" } }, null).client);
    expect(await createIdempotentLeadNote("prop-1", "hello", KEY)).toMatchObject({ ok: false, error: { code: "NOTE_CREATE_FAILED" } });
  });

  it("rejects empty and over-long bodies, signed-out callers and DNC-locked leads before writing", async () => {
    const { client, inserts } = noteClient({ data: { id: "n1" }, error: null }, null, null);
    mocks.createClient.mockResolvedValue(client);
    expect(await createIdempotentLeadNote("prop-1", "  ", KEY)).toMatchObject({ ok: false, error: { code: "EMPTY_BODY" } });
    expect(await createIdempotentLeadNote("prop-1", "x".repeat(5001), KEY)).toMatchObject({ ok: false, error: { code: "BODY_TOO_LONG" } });
    expect(await createIdempotentLeadNote("prop-1", "hello", KEY)).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    mocks.assertUnlocked.mockResolvedValue({ ok: false, error: { code: "DNC_LOCKED", message: "locked" } });
    expect(await createIdempotentLeadNote("prop-1", "hello", KEY)).toMatchObject({ ok: false, error: { code: "DNC_LOCKED" } });
    expect(inserts).toEqual([]);
  });
});
