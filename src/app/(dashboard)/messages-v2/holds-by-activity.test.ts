import { describe, expect, it } from "vitest";

import { collectOpenHoldSources, HOLDS_LOAD_ERROR, loadHoldsSlice, loadMessagesV2Page, orderingDataComplete } from "./holds-by-activity";
import type { LooseSupabase } from "./queries";

type Tables = Record<string, Array<Record<string, unknown>>>;

/** A fake PostgREST: every table answers .range() pages, so exhaustion past the 1,000-row page can be tested. */
function client(tables: Tables, failTable?: string, lockedIds: string[] = []): LooseSupabase {
  const from = (table: string) => {
    const q: Record<string, unknown> = {};
    let wantLocked = false;
    let inIds: string[] = [];
    let inCol = "";
    for (const m of ["select", "is", "order", "limit", "gte", "lt"]) q[m] = () => q;
    q.eq = (col: string, v: unknown) => {
      if (col === "is_dnc_locked" && v === true) wantLocked = true;
      return q;
    };
    q.in = (c: string, ids: string[]) => {
      inCol = c;
      inIds = ids;
      return q;
    };
    q.range = async (a: number, b: number) =>
      failTable === table ? { data: null, error: { message: "boom" } } : { data: (tables[table] ?? []).slice(a, b + 1), error: null };
    q.then = (resolve: (v: unknown) => unknown) =>
      resolve({
        data:
          table === "properties" && wantLocked
            ? inIds.filter((id) => lockedIds.includes(id)).map((id) => ({ id }))
            : table === "pipeline_runs" && inCol === "id"
              ? (tables.pipeline_runs ?? []).filter((r) => inIds.includes(r.id as string))
              : [],
        error: null,
      });
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

  it("collects everything: there is no ceiling anywhere", async () => {
    const properties = Array.from({ length: 5010 }, (_, i) => prop(i, at(i)));
    const out = await collectOpenHoldSources(client({ properties }), "org");
    expect(out.properties).toHaveLength(5010);
    expect(out.total).toBe(5010);
  });

  it("locked properties never count: their pending rows are dropped before anything is loaded or sorted", async () => {
    const properties = Array.from({ length: 5000 }, (_, i) => prop(i, at(i)));
    const lockedRows = Array.from({ length: 100 }, (_, i) => ({ property_id: `locked${i}`, conversation_id: "c", source_inbound_message_id: `m${i}`, created_at: at(10_000 + i) }));
    const lockedIds = lockedRows.map((r) => r.property_id);
    const out = await collectOpenHoldSources(client({ properties, jev_lead_decisions: lockedRows }, undefined, lockedIds), "org");
    expect(out.decisions).toHaveLength(0);
    expect(out.total).toBe(5000); // no slots used by locked holds, so no ceiling is hit
  });

  it("FAILS CLOSED when the lock lookup fails: no rows from unverified properties", async () => {
    const bad = client({ properties: [prop(1, at(1))], jev_lead_decisions: [{ property_id: "p9", conversation_id: "c", source_inbound_message_id: "m", created_at: at(1) }] });
    const orig = (bad as unknown as { from: (t: string) => Record<string, unknown> }).from;
    (bad as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const q = orig(t);
      if (t === "properties") {
        const eq = q.eq as (c: string, v: unknown) => unknown;
        let wantLocked = false;
        q.eq = (c: string, v: unknown) => ((wantLocked ||= c === "is_dnc_locked" && v === true), eq(c, v));
        q.then = (resolve: (v: unknown) => unknown) => resolve({ data: wantLocked ? null : [], error: wantLocked ? { message: "x" } : null });
      }
      return q;
    };
    const out = await collectOpenHoldSources(bad, "org");
    expect(out.failed).toBe(true);
    expect(out.properties).toHaveLength(0);
    expect(out.decisions).toHaveLength(0);
    expect(out.total).toBe(0);
  });

  it("FAILS CLOSED when one source fails: the others' rows are not used either", async () => {
    const out = await collectOpenHoldSources(client({ properties: [prop(1, at(1))], jev_lead_decisions: [{ property_id: "p1", conversation_id: "c", source_inbound_message_id: "m", created_at: at(2) }] }, "ai_disposition_reviews"), "org");
    expect(out.failed).toBe(true);
    expect(out.properties).toHaveLength(0);
    expect(out.decisions).toHaveLength(0);
  });
  it("reports a failed source instead of an empty list", async () => {
    const out = await collectOpenHoldSources(client({ properties: [prop(1, at(1))] }, "ai_reply_drafts"), "org");
    expect(out.failed).toBe(true);
    expect(await loadHoldsSlice(client({}, "ai_reply_drafts"), "org", null, 10)).toBeNull();
  });
});

describe("ordering data must be complete (fail closed)", () => {
  it("a failed run or step lookup makes ordering data incomplete", () => {
    const ok = { failed: [], contextErrors: ["alert status"] };
    expect(orderingDataComplete(ok)).toBe(true);
    expect(orderingDataComplete({ failed: [], contextErrors: ["run lookup by property"] })).toBe(false);
    expect(orderingDataComplete({ failed: [], contextErrors: ["run lookup by message"] })).toBe(false);
    expect(orderingDataComplete({ failed: [], contextErrors: ["step lookup"] })).toBe(false);
    expect(orderingDataComplete({ failed: ["needs_attention"], contextErrors: [] })).toBe(false);
  });

  it("when the latest-run lookup fails the page shows the error and renders zero cards", async () => {
    const supabase = client({ properties: [prop(1, at(1))] });
    (supabase as unknown as { rpc: unknown }).rpc = async (fn: string) =>
      fn === "pipeline_runs_latest_for_properties" ? { data: null, error: { message: "boom" } } : { data: [], error: null };
    const page = await loadMessagesV2Page(supabase, "org");
    expect(page.error).toBe(HOLDS_LOAD_ERROR);
    expect(page.holds).toHaveLength(0);
  });

  it("the same failure makes 'Show older' fail instead of returning an unordered slice", async () => {
    const supabase = client({ properties: [prop(1, at(1))] });
    (supabase as unknown as { rpc: unknown }).rpc = async () => ({ data: null, error: { message: "boom" } });
    expect(await loadHoldsSlice(supabase, "org", null, 10)).toBeNull();
  });
});

describe("the waiting list never shows what it cannot verify or order", () => {
  const run = (id: string, property_id: string | null) => ({
    id, org_id: "o", inbound_message_id: `m-${id}`, property_id, contact_id: null, conversation_id: null, status: "held", mode: "automatic",
    final_outcome: null, reason: null, classification_run_id: null, claim_id: null, outbound_message_id: null, inbound_preview: "x",
    started_at: at(5), completed_at: null,
  });
  const draft = (over: Record<string, unknown> = {}) => ({
    id: "d1", property_id: null, conversation_id: null, inbound_message_id: null, run_id: null, created_at: at(10), body: "hi", edited_body: null, edited_at: null, ...over,
  });

  it("a propertyless draft linked only by run_id to a DNC-locked property's run does not render", async () => {
    const supabase = client({ ai_reply_drafts: [draft({ run_id: "r1" })], pipeline_runs: [run("r1", "locked1")] }, undefined, ["locked1"]);
    const page = await loadMessagesV2Page(supabase, "org");
    expect(page.error).toBeNull();
    expect(page.holds).toHaveLength(0);
  });

  it("the same draft on an UNLOCKED property's run renders, tied to that property", async () => {
    const supabase = client({ ai_reply_drafts: [draft({ run_id: "r1" })], pipeline_runs: [run("r1", "free1")] });
    const page = await loadMessagesV2Page(supabase, "org");
    expect(page.holds.map((h) => h.property_id)).toEqual(["free1"]);
  });

  it("a linked draft whose run cannot be found is hidden and counted, never shown unverified", async () => {
    const supabase = client({ ai_reply_drafts: [draft({ run_id: "ghost" })] });
    const page = await loadMessagesV2Page(supabase, "org");
    expect(page.holds).toHaveLength(0);
    expect(page.unverified).toBe(1);
  });

  it("a draft with no link at all cannot belong to a locked property and still renders", async () => {
    const page = await loadMessagesV2Page(client({ ai_reply_drafts: [draft()] }), "org");
    expect(page.holds).toHaveLength(1);
    expect(page.unverified).toBe(0);
  });

  it("a failing run lookup by draft run_id renders the error state and zero cards", async () => {
    const supabase = client({ ai_reply_drafts: [draft({ run_id: "r1" })] });
    const from = (supabase as unknown as { from: (t: string) => Record<string, unknown> }).from;
    (supabase as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const q = from(t);
      if (t === "pipeline_runs") {
        let byId = false;
        const inFn = q.in as (c: string, ids: string[]) => unknown;
        q.in = (c: string, ids: string[]) => ((byId ||= c === "id"), inFn(c, ids));
        q.then = (resolve: (v: unknown) => unknown) => resolve({ data: byId ? null : [], error: byId ? { message: "boom" } : null });
      }
      return q;
    };
    const page = await loadMessagesV2Page(supabase, "org");
    expect(page.error).toBe(HOLDS_LOAD_ERROR);
    expect(page.holds).toHaveLength(0);
  });

  it("a failing step page renders the error state and zero cards (steps change the order, so a gap is fatal)", async () => {
    const supabase = client({ properties: [prop(1, at(1))], pipeline_runs: [] }, "pipeline_run_steps");
    (supabase as unknown as { rpc: unknown }).rpc = async (fn: string) =>
      fn === "pipeline_runs_latest_for_properties" ? { data: [run("r1", "p1")], error: null } : { data: [], error: null };
    const page = await loadMessagesV2Page(supabase, "org");
    expect(page.error).toBe(HOLDS_LOAD_ERROR);
    expect(page.holds).toHaveLength(0);
    expect(await loadHoldsSlice(supabase, "org", null, 10)).toBeNull();
  });
});
