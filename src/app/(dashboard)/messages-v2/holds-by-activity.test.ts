import { describe, expect, it } from "vitest";

import { HOLD_SORT_CAP } from "./hold-activity";
import { sortNewestFirst } from "./hold-activity";
import { applyHoldCeiling, collectOpenHoldSources, loadHoldsSlice } from "./holds-by-activity";
import type { OpenHold, RunWithSteps } from "./types";
import type { LooseSupabase } from "./queries";

type Tables = Record<string, Array<Record<string, unknown>>>;

/** A fake PostgREST: every table answers .range() pages, so exhaustion past the 1,000-row page can be tested. */
function client(tables: Tables, failTable?: string, lockedIds: string[] = []): LooseSupabase {
  const from = (table: string) => {
    const q: Record<string, unknown> = {};
    let wantLocked = false;
    let inIds: string[] = [];
    for (const m of ["select", "is", "order", "limit", "gte", "lt"]) q[m] = () => q;
    q.eq = (col: string, v: unknown) => {
      if (col === "is_dnc_locked" && v === true) wantLocked = true;
      return q;
    };
    q.in = (_c: string, ids: string[]) => {
      inIds = ids;
      return q;
    };
    q.range = async (a: number, b: number) =>
      failTable === table ? { data: null, error: { message: "boom" } } : { data: (tables[table] ?? []).slice(a, b + 1), error: null };
    q.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: table === "properties" && wantLocked ? inIds.filter((id) => lockedIds.includes(id)).map((id) => ({ id })) : [], error: null });
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

  it("collects everything with no ceiling: the cut happens only after sorting", async () => {
    const properties = Array.from({ length: HOLD_SORT_CAP + 10 }, (_, i) => prop(i, at(i)));
    const out = await collectOpenHoldSources(client({ properties }), "org");
    expect(out.properties).toHaveLength(HOLD_SORT_CAP + 10);
    expect(out.total).toBe(HOLD_SORT_CAP + 10);
  });

  it("locked properties never count: their pending rows are dropped before anything is loaded or sorted", async () => {
    const properties = Array.from({ length: HOLD_SORT_CAP }, (_, i) => prop(i, at(i)));
    const lockedRows = Array.from({ length: 100 }, (_, i) => ({ property_id: `locked${i}`, conversation_id: "c", source_inbound_message_id: `m${i}`, created_at: at(10_000 + i) }));
    const lockedIds = lockedRows.map((r) => r.property_id);
    const out = await collectOpenHoldSources(client({ properties, jev_lead_decisions: lockedRows }, undefined, lockedIds), "org");
    expect(out.decisions).toHaveLength(0);
    expect(out.total).toBe(HOLD_SORT_CAP); // no slots used by locked holds, so no ceiling is hit
    expect(applyHoldCeiling(Array.from({ length: out.total })).cutFrom).toBeNull();
  });

  it("keeps rows when the lock lookup fails (a visible extra card beats a hidden one)", async () => {
    const bad = client({ jev_lead_decisions: [{ property_id: "p9", conversation_id: "c", source_inbound_message_id: "m", created_at: at(1) }] });
    const orig = (bad as unknown as { from: (t: string) => Record<string, unknown> }).from;
    (bad as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const q = orig(t);
      if (t === "properties") q.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: "x" } });
      return q;
    };
    const out = await collectOpenHoldSources(bad, "org");
    expect(out.decisions).toHaveLength(1);
  });
  it("reports a failed source instead of an empty list", async () => {
    const out = await collectOpenHoldSources(client({ properties: [prop(1, at(1))] }, "ai_reply_drafts"), "org");
    expect(out.failed).toBe(true);
    expect(await loadHoldsSlice(client({}, "ai_reply_drafts"), "org", 0, 10)).toBeNull();
  });
});

describe("applyHoldCeiling", () => {
  const h = (id: string, last: number, since: number): OpenHold<RunWithSteps> => ({
    id, property_id: id, conversation_id: null, sources: ["needs_attention"], since: new Date(since).toISOString(),
    last_activity: new Date(last).toISOString(), reason: "r", run: null,
  });

  it("an OLD hold that was active just now survives the ceiling; the oldest-activity holds are what get cut", () => {
    const many = Array.from({ length: HOLD_SORT_CAP + 20 }, (_, i) => h(`h${i}`, 1_000_000 + i, 1_000_000 + i));
    const oldButActive = h("old-but-active", 9_000_000, 1);
    const { holds, cutFrom } = applyHoldCeiling(sortNewestFirst([...many, oldButActive]));
    expect(cutFrom).toBe(HOLD_SORT_CAP + 21);
    expect(holds).toHaveLength(HOLD_SORT_CAP);
    expect(holds[0].id).toBe("old-but-active");
    expect(holds.some((x) => x.id === "h0")).toBe(false);
  });

  it("does not cut at or below the ceiling", () => {
    expect(applyHoldCeiling(Array.from({ length: HOLD_SORT_CAP })).cutFrom).toBeNull();
  });
});
