import { beforeEach, describe, expect, it, vi } from "vitest";

const drain = vi.fn();
const flagRows: Record<string, { comp_queue: boolean } | null> = {};
const adminFrom = vi.fn((_table: string) => {
  let org: string | null = null;
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (_k: string, v: string) => { org = v; return chain; },
    limit: async () => ({ data: [{ org_id: "o1" }], error: null }),
    maybeSingle: async () => ({ data: org ? (flagRows[org] ?? null) : null, error: null }),
  };
  return chain;
});

vi.mock("@/lib/comps", () => ({ drainCompQueue: (...a: unknown[]) => drain(...a) }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/my-leads/schema-ready", () => ({ schemaReady: vi.fn(async () => true) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: adminFrom, rpc: async () => ({ data: 0, error: null }) }) }));

import { GET } from "./route";

describe("comp-queue-drain route", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "s";
    drain.mockReset().mockResolvedValue({ claimed: 0, ok: 0, failed: 0, outcomes: [] });
    flagRows.on = { comp_queue: true };
    flagRows.off = { comp_queue: false };
  });
  it("rejects a bad secret", async () => {
    expect((await GET(new Request("http://x", { headers: { authorization: "Bearer nope" } }))).status).toBe(401);
  });
  it("passes a per-org gate: flag on allowed; flag off, missing row denied", async () => {
    const res = await GET(new Request("http://x", { headers: { authorization: "Bearer s" } }));
    expect(res.status).toBe(200);
    const deps = drain.mock.calls[0][1] as { orgAllowed: (o: string) => Promise<boolean> };
    expect(await deps.orgAllowed("on")).toBe(true);
    expect(await deps.orgAllowed("off")).toBe(false);
    expect(await deps.orgAllowed("missing")).toBe(false);
  });
});
