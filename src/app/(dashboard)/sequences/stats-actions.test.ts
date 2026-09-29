import { afterEach, expect, it, vi } from "vitest";
const createClient = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { listSequences, listSequenceNeedsPerson } from "./actions";

afterEach(() => { vi.clearAllMocks(); delete process.env.SEQUENCE_CANARY_USER_ID; });

it("returns typed buckets and strips canary-created overview rows", async () => {
  process.env.SEQUENCE_CANARY_USER_ID = "canary-user";
  const rpc = vi.fn(async (name: string) => ({ data: name === "sequence_overview_stats"
    ? [{ id: "live", name: "Live", created_by: "user", waiting: 1 },
      { id: "test", name: "No smoke name", created_by: "canary-user", waiting: 1 }]
    : [{ property_id: "p", sequence_id: "live", bucket: "couldnt_send", reason: "Ignored", sequence_created_by: "user" }], error: null }));
  createClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: "user" } } }) },
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ is: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { org_id: "org" }, error: null }) }) }) }) }) }) }),
    rpc,
  });
  expect(await listSequences()).toMatchObject({ ok: true, data: [{ id: "live", waiting: 1 }] });
  expect(await listSequenceNeedsPerson()).toMatchObject({ ok: true, data: [{ property_id: "p", bucket: "couldnt_send" }] });
  expect(rpc).toHaveBeenCalledWith("sequence_overview_stats", { p_org: "org" });
  expect(rpc).toHaveBeenCalledWith("sequence_needs_person", { p_org: "org" });
});

it.each(["PGRST202", "42883"])("falls back to the list query when stats RPC is missing (%s)", async (code) => {
  process.env.SEQUENCE_CANARY_USER_ID = "canary-user";
  const calls: string[] = [];
  const rows = [
    { id: "live", name: "Live", created_by: "user", description: null, active: true, append_opt_out: true, archived_at: null, created_at: "2026-09-28" },
    { id: "canary", name: "Looks live", created_by: "canary-user", description: null, active: true, append_opt_out: true, archived_at: null, created_at: "2026-09-28" },
  ];
  createClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: "user" } } }) },
    rpc: async () => ({ data: null, error: { code, message: "missing RPC" } }),
    from: (table: string) => {
      calls.push(table);
      if (table === "memberships") return { select: () => ({ eq: () => ({ eq: () => ({ is: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { org_id: "org" }, error: null }) }) }) }) }) }) };
      if (table === "sequences") return { select: () => ({ eq: () => ({ order: async () => ({ data: rows, error: null }) }) }) };
      return { select: () => ({ in: () => ({ in: async () => ({ data: [{ sequence_id: "live" }], error: null }), then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: table === "sequence_steps" ? [{ sequence_id: "live" }, { sequence_id: "live" }] : [], error: null })) }) }) };
    },
  });
  expect(await listSequences()).toMatchObject({ ok: true, data: [{ id: "live", step_count: 2, active_enrollment_count: 1 }] });
  expect(calls).toEqual(["memberships", "sequences", "sequence_steps", "sequence_enrollments"]);
});
