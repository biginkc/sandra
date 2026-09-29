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
