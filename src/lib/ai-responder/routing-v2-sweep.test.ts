import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { sweepUnstampedV2Inbounds } from "./dispatch";

/**
 * Review B2 (of 72229239848d): the unstamped-inbound sweep must not decide "not v2" when the v2
 * state cannot be read. A read error leaves the text unmarked for the next pass and holds nobody;
 * a dead v2 text never escapes because the database was flaky.
 */
type Result = { data: unknown; error: { message: string; code?: string } | null };
function fake(results: Record<string, Result>) {
  const writes: Array<{ table: string; value: unknown }> = [];
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "lt", "gt", "not", "is", "order", "limit", "in", "neq"]) chain[m] = () => chain;
    chain.update = (value: unknown) => { writes.push({ table, value }); return chain; };
    chain.maybeSingle = async () => results[table] ?? { data: null, error: null };
    chain.then = (res: (v: Result) => unknown) => res(results[table] ?? { data: [], error: null });
    return chain;
  };
  return { db: { from, rpc: async () => ({ data: null, error: null }) } as never, writes };
}

const deadText = { id: "m1", org_id: "o1", property_id: "p1", conversation_id: null, metadata: {} };

describe("lease-death sweep: an unreadable v2 state is never 'not v2' (review B2)", () => {
  it("the flag / config read errors: nothing is marked, nobody is held, the text waits for the next pass", async () => {
    const { db, writes } = fake({
      messages: { data: [deadText], error: null },
      ai_response_claims: { data: [], error: null },
      routing_v2_live_decisions: { data: [], error: null },
      ai_responder_configs: { data: null, error: { message: "connection reset" } },
    });
    expect(await sweepUnstampedV2Inbounds(db, Date.now())).toBe(0);
    expect(writes).toEqual([]);
  });

  it("flags truly off (readable, questions_live false): marked not_v2, nobody held", async () => {
    const { db, writes } = fake({
      messages: { data: [deadText], error: null },
      ai_response_claims: { data: [], error: null },
      routing_v2_live_decisions: { data: [], error: null },
      ai_responder_configs: { data: { routing_v2_flags: { questions_live: false } }, error: null },
    });
    expect(await sweepUnstampedV2Inbounds(db, Date.now())).toBe(0);
    expect(writes.map((w) => w.table)).toEqual(["messages"]);
    expect(JSON.stringify(writes[0]!.value)).toContain("not_v2");
  });
});
