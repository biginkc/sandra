import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
let flagRows: { org_id: string }[] = [{ org_id: "o1" }];
let ready = true;
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/my-leads/schema-ready", () => ({ schemaReady: vi.fn(async () => ready) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: (...a: unknown[]) => rpc(...a),
    from: () => {
      const chain: Record<string, unknown> = { select: () => chain, eq: () => chain, limit: async () => ({ data: flagRows, error: null }) };
      return chain;
    },
  }),
}));

import { GET } from "./route";

const authed = () => new Request("http://x", { headers: { authorization: "Bearer s" } });

describe("call-facts-sweep route", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "s";
    delete process.env.TYPESAFE_API_KEY;
    rpc.mockReset().mockResolvedValue({ data: { claims: [], exhausted: [] }, error: null });
    flagRows = [{ org_id: "o1" }];
    ready = true;
  });

  it("rejects a missing or wrong secret", async () => {
    expect((await GET(new Request("http://x"))).status).toBe(401);
    expect((await GET(new Request("http://x", { headers: { authorization: "Bearer nope" } }))).status).toBe(401);
  });

  it("is inert while the facts_job flag is off: nothing is claimed", async () => {
    flagRows = [];
    const res = await GET(authed());
    expect(await res.json()).toEqual({ ok: true, disabled: "flag_off" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("is inert while the schema is not ready", async () => {
    ready = false;
    expect(await (await GET(authed())).json()).toEqual({ ok: true, disabled: "schema_not_ready" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("with the flag on and no extractor it completes a claim with the summary-only result", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "fn_claim_call_facts"
        ? { data: { claims: [{ fact_id: "f1", claim_token: "t1", call_activity_id: "a1", summary: "s", transcript: "t" }], exhausted: [] }, error: null }
        : { data: { replayed: false }, error: null });
    const body = await (await GET(authed())).json();
    expect(body).toEqual({ ok: true, claimed: 1, completed: 1, failed: 0, exhausted: 0 });
    expect(rpc).toHaveBeenCalledWith("fn_claim_call_facts", { p_limit: 1, p_lease_seconds: 900, p_window_hours: 48 });
    expect(rpc).toHaveBeenCalledWith("fn_complete_call_facts", { p_fact_id: "f1", p_claim_token: "t1", p_facts: {}, p_status: "no_facts", p_model: null });
  });
});
