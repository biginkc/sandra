import { describe, expect, it } from "vitest";

import { HOLD_SORT_CAP } from "./hold-activity";
import { collectOpenHoldSources, loadHoldsSlice } from "./holds-by-activity";
import type { LooseSupabase } from "./queries";

type Tables = Record<string, Array<Record<string, unknown>>>;

/** A fake PostgREST: every table answers .range() pages, so exhaustion past the 1,000-row page can be tested. */
function client(tables: Tables, failTable?: string): LooseSupabase {
  const from = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "is", "order", "limit", "gte", "lt"]) q[m] = () => q;
    q.range = async (a: number, b: number) =>
      failTable === table ? { data: null, error: { message: "boom" } } : { data: (tables[table] ?? []).slice(a, b + 1), error: null };
    q.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
    return q;
  };
  return { from, rpc: async () => ({ data: [], error: null }) } as unknown as LooseSupabase;
}

const prop = (i: number, since: string) => ({ id: `p${i}`, last_ai_escalation_at: since, last_ai_escalation_reason: null, updated_at: null, needs_human_attention_since: since });
const at = (n: number) => new Date(1_700_000_000_000 + n * 1000).toISOString();

describe("collectOpenHoldSources", () => {
  it("pages every source to exhaustion, past the 1,000-row page and the old caps", async () => {
    const properties = Array.from({ length: 2500 }, (_, i) => prop(i, at(i)));
    const out = await collectOpenHoldSources(client({ properties }), "org");
    expect(out.properties).toHaveLength(2500);
    expect(out.total).toBe(2500);
    expect(out.cut).toBe(false);
  });

  it("includes propertyless pending drafts beyond the old 200-row window, and counts them in the total", async () => {
    const drafts = Array.from({ length: 450 }, (_, i) => ({ id: `d${i}`, property_id: null, conversation_id: null, inbound_message_id: null, run_id: null, created_at: at(i), body: "x" }));
    const out = await collectOpenHoldSources(client({ properties: [prop(1, at(1))], ai_reply_drafts: drafts }), "org");
    expect(out.drafts).toHaveLength(450);
    expect(out.total).toBe(451);
  });

  it("counts a property once however many sources point at it", async () => {
    const out = await collectOpenHoldSources(
      client({
        properties: [prop(1, at(1))],
        jev_lead_decisions: [{ property_id: "p1", conversation_id: "c", source_inbound_message_id: "m", created_at: at(5) }],
        ai_disposition_reviews: [{ property_id: "p1", conversation_id: "c", source_inbound_message_id: "m", disposition: "x", created_at: at(6) }],
      }),
      "org",
    );
    expect(out.total).toBe(1);
  });

  it("above the ceiling keeps the newest holds and says it cut, never silently", async () => {
    const properties = Array.from({ length: HOLD_SORT_CAP + 10 }, (_, i) => prop(i, at(i)));
    const out = await collectOpenHoldSources(client({ properties }), "org");
    expect(out.cut).toBe(true);
    expect(out.total).toBe(HOLD_SORT_CAP + 10);
    expect(out.properties).toHaveLength(HOLD_SORT_CAP);
    expect(out.properties.some((p) => p.id === `p${HOLD_SORT_CAP + 9}`)).toBe(true); // newest kept
    expect(out.properties.some((p) => p.id === "p0")).toBe(false); // oldest dropped
  });

  it("reports a failed source instead of an empty list", async () => {
    const out = await collectOpenHoldSources(client({ properties: [prop(1, at(1))] }, "ai_reply_drafts"), "org");
    expect(out.failed).toBe(true);
    expect(await loadHoldsSlice(client({}, "ai_reply_drafts"), "org", 0, 10)).toBeNull();
  });
});
