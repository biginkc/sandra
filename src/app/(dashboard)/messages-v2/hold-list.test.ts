import { describe, expect, it } from "vitest";

import { normalizeInstant } from "./chicago-time";
import { fakePostgrest } from "./fake-postgrest.test-util";
import { holdCursor } from "./hold-activity";
import { loadHoldsSlice, loadMessagesV2Page } from "./holds-by-activity";
import { effectiveFlagReasons, loadEligibleHolds, pageHolds } from "./hold-list";
import { deriveTape, holdReasonSentence, withEffectiveReason } from "./tape";
import type { HoldCursor } from "./hold-activity";
import type { OpenHold, RunWithSteps } from "./types";

type Row = Record<string, unknown>;
const SNAP = "2099-01-01T00:00:00.000000Z";
const u = (n: number, ns = 0) => `${String(ns).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const t = (sec: number, micros = "000000") => {
  const d = new Date(Date.UTC(2026, 9, 1) + sec * 1000).toISOString().slice(0, 19);
  return `${d}.${micros}+00:00`;
};
const flagged = (n: number, at: string, over: Row = {}): Row => ({
  id: u(n), org_id: "org", needs_human_attention: true, is_dnc_locked: false,
  last_ai_escalation_at: at, last_ai_escalation_reason: "model:unclear", updated_at: at, needs_human_attention_since: at, ...over,
});
const lockedProp = (n: number): Row => ({ id: u(n), org_id: "org", needs_human_attention: false, is_dnc_locked: true });
const decision = (n: number, property: string, at: string, over: Row = {}): Row => ({
  id: u(n, 1), org_id: "org", status: "pending", property_id: property, conversation_id: u(n, 2), source_inbound_message_id: u(n, 3), created_at: at, ...over,
});
const draft = (n: number, over: Row = {}): Row => ({
  id: u(n, 4), org_id: "org", status: "pending", property_id: null, conversation_id: null, inbound_message_id: null, run_id: null, created_at: t(10), ...over,
});
const runRow = (n: number, over: Row = {}): Row => ({
  id: u(n, 5), org_id: "org", inbound_message_id: u(n, 6), property_id: null, contact_id: null, conversation_id: null, status: "held", mode: "automatic",
  final_outcome: null, reason: null, classification_run_id: null, claim_id: null, outbound_message_id: null, inbound_preview: "x", started_at: t(1), completed_at: null, ...over,
});
const message = (n: number, over: Row = {}): Row => ({ id: u(n, 7), org_id: "org", conversation_id: null, property_id: null, direction: "inbound", body: "b", created_at: t(1), ...over });

/** The latest-run RPC, computed from the fake pipeline_runs table like the SQL function. */
const latestRpc = (tables: Record<string, Row[]>) => ({
  pipeline_runs_latest_for_properties: (args: Record<string, unknown>) => {
    const ids = args.p_property_ids as string[];
    const best = new Map<string, Row>();
    for (const r of tables.pipeline_runs ?? []) {
      const p = r.property_id as string | null;
      if (!p || !ids.includes(p)) continue;
      const cur = best.get(p);
      if (!cur || String(r.started_at) > String(cur.started_at)) best.set(p, r);
    }
    return { data: [...best.values()], error: null };
  },
});

function db(tables: Record<string, Row[]>, opts: Parameters<typeof fakePostgrest>[1] = {}) {
  return fakePostgrest(tables, { ...opts, rpc: { ...latestRpc(tables), ...(opts.rpc ?? {}) } });
}

const eligible = async (tables: Record<string, Row[]>, opts: Parameters<typeof fakePostgrest>[1] = {}) => {
  const res = await loadEligibleHolds(db(tables, opts).client, "org");
  if (!res.ok) throw new Error(res.error);
  return res;
};

const walk = (sorted: OpenHold<RunWithSteps>[], limit: number) => {
  const ids: string[] = [];
  let cursor: HoldCursor | null = null;
  for (;;) {
    const page = pageHolds(sorted, cursor, limit, SNAP);
    ids.push(...page.holds.map((h) => h.id));
    if (!page.nextCursor) return ids;
    cursor = page.nextCursor;
  }
};

describe("I1 every eligible hold is reachable in one order", () => {
  it("2,500 holds, 41 per page: walking the server's nextCursor yields every id exactly once", async () => {
    const properties = Array.from({ length: 2500 }, (_, i) => flagged(i, t(i)));
    const list = await eligible({ properties });
    const ids = walk(list.holds, 41);
    expect(ids).toHaveLength(2500);
    expect(new Set(ids).size).toBe(2500);
  });

  it("a hold resolved between pages does not shift the rest", async () => {
    const tables: Record<string, Row[]> = { properties: Array.from({ length: 100 }, (_, i) => flagged(i, t(i))) };
    const first = pageHolds((await eligible(tables)).holds, null, 41, SNAP);
    const resolved = (await eligible(tables)).holds[50].id; // on what would be page 2
    tables.properties = tables.properties.filter((p) => p.id !== resolved);
    const rest = walk((await eligible(tables)).holds, 41).filter((id) => !first.holds.some((h) => h.id === id));
    const expected = (await eligible(tables)).holds.map((h) => h.id).filter((id) => !first.holds.some((h) => h.id === id));
    expect(rest).toEqual(expected);
    const second = pageHolds((await eligible(tables)).holds, first.nextCursor, 1000, SNAP);
    expect(second.holds.map((h) => h.id)).toEqual(expected); // nothing skipped, nothing repeated
  });

  it("the first page and a 'Show older' slice give the identical order, even for a conversation-matched run", async () => {
    const tables: Record<string, Row[]> = {
      properties: [flagged(1, t(100)), flagged(2, t(200))],
      jev_lead_decisions: [decision(1, u(1), t(100), { conversation_id: u(9, 2) })],
      pipeline_runs: [runRow(1, { conversation_id: u(9, 2), property_id: null, started_at: t(900) })], // newest; also in the feed window
    };
    const page = await loadMessagesV2Page(db(tables).client, "org");
    const listed = await eligible(tables);
    expect(page.holds.map((h) => h.id)).toEqual([u(1), u(2)]); // the conversation run lifted property 1
    expect(listed.holds.map((h) => h.id)).toEqual(page.holds.map((h) => h.id)); // slices walk this same list
  });
});

describe("I2 latest activity, microsecond precise, never from incomplete data", () => {
  it(".123456 vs .123457 order correctly", async () => {
    const list = await eligible({ properties: [flagged(1, t(5, "123456")), flagged(2, t(5, "123457"))] });
    expect(list.holds.map((h) => h.id)).toEqual([u(2), u(1)]);
  });

  it("a newer property-less run in the hold's conversation lifts it; a run on ANOTHER property does not", async () => {
    const base = {
      properties: [flagged(1, t(100)), flagged(2, t(200)), flagged(3, t(300))],
      jev_lead_decisions: [decision(1, u(1), t(100), { conversation_id: u(7, 2) }), decision(3, u(3), t(300), { conversation_id: u(8, 2) })],
    };
    const lifted = await eligible({ ...base, pipeline_runs: [runRow(1, { conversation_id: u(7, 2), started_at: t(999) })] });
    expect(lifted.holds[0].id).toBe(u(1));
    const notLifted = await eligible({ ...base, pipeline_runs: [runRow(2, { conversation_id: u(7, 2), property_id: u(3), started_at: t(999) })] });
    expect(notLifted.holds.map((h) => h.id).slice(0, 1)).toEqual([u(3)]); // the other property's own run lifts property 3, not 1
  });

  it.each([
    ["latest-run RPC", { rpc: { pipeline_runs_latest_for_properties: () => ({ data: null, error: { message: "x" } }) } }],
    ["message-run lookup", { fail: (tb: string, _n: number, ops: Array<{ k: string; col?: string }>) => tb === "pipeline_runs" && ops.some((o) => o.col === "inbound_message_id") }],
    ["draft-run lookup", { fail: (tb: string, _n: number, ops: Array<{ k: string; col?: string; v?: unknown }>) => tb === "pipeline_runs" && ops.some((o) => o.k === "in" && o.col === "id") }],
    ["conversation-run lookup", { fail: (tb: string, _n: number, ops: Array<{ k: string; col?: string }>) => tb === "pipeline_runs" && ops.some((o) => o.col === "conversation_id") }],
    ["step lookup", { fail: (tb: string) => tb === "pipeline_run_steps" }],
  ])("a failed %s fails the list closed: error, zero cards", async (_name, opts) => {
    const tables = {
      properties: [flagged(1, t(1))],
      jev_lead_decisions: [decision(1, u(1), t(2))],
      ai_reply_drafts: [draft(1, { property_id: u(1), run_id: u(1, 5) })],
      pipeline_runs: [runRow(1, { property_id: u(1) })],
    };
    const page = await loadMessagesV2Page(db(tables, opts as Parameters<typeof fakePostgrest>[1]).client, "org");
    expect(page.error).not.toBeNull();
    expect(page.holds).toHaveLength(0);
  });

  it("a run with more than 1,000 steps (server cap) still uses its newest step", async () => {
    const steps = Array.from({ length: 1500 }, (_, i) => ({
      id: u(i, 8), org_id: "org", run_id: u(1, 5), seq: i + 1, kind: "gate", name: "g", result: "pass", detail: {}, created_at: t(1000 + i),
    }));
    const list = await eligible(
      { properties: [flagged(1, t(1)), flagged(2, t(2000))], pipeline_runs: [runRow(1, { property_id: u(1) })], pipeline_run_steps: steps },
      { cap: 1000 },
    );
    expect(list.holds[0].id).toBe(u(1)); // newest step (t(2499)) beats property 2's flag (t(2000))
    expect(list.holds[0].run?.steps).toHaveLength(1500);
  });
});

describe("I3 no locked property renders; every hold has exactly one property", () => {
  it("a draft linked only by run_id to a locked property's run is hidden and NOT counted unverified", async () => {
    const list = await eligible({
      properties: [lockedProp(5)],
      ai_reply_drafts: [draft(1, { run_id: u(1, 5) })],
      pipeline_runs: [runRow(1, { property_id: u(5) })],
    });
    expect(list.holds).toHaveLength(0);
    expect(list.unverified).toBe(0);
  });

  it("conversation-only and inbound-only drafts resolve through messages", async () => {
    const list = await eligible({
      ai_reply_drafts: [draft(1, { conversation_id: u(1, 9) }), draft(2, { inbound_message_id: u(2, 7) })],
      messages: [message(1, { conversation_id: u(1, 9), property_id: u(11) }), message(2, { property_id: u(12) })],
    });
    expect(list.holds.map((h) => h.id).sort()).toEqual([u(11), u(12)]);
    expect(list.unverified).toBe(0);
  });

  it("a run with no property but an inbound message on a locked property is lock-checked (hidden)", async () => {
    const list = await eligible({
      properties: [lockedProp(5)],
      ai_reply_drafts: [draft(1, { run_id: u(1, 5), inbound_message_id: u(1, 7) })],
      pipeline_runs: [runRow(1, { property_id: null })],
      messages: [message(1, { property_id: u(5) })],
    });
    expect(list.holds).toHaveLength(0);
    expect(list.unverified).toBe(0);
  });

  it("a no-link draft and an ambiguous draft are hidden and counted", async () => {
    const list = await eligible({
      ai_reply_drafts: [draft(1), draft(2, { conversation_id: u(2, 9) })],
      messages: [message(1, { conversation_id: u(2, 9), property_id: u(21) }), message(2, { conversation_id: u(2, 9), property_id: u(22) })],
    });
    expect(list.holds).toHaveLength(0);
    expect(list.unverified).toBe(2);
  });

  it("decisions on locked properties never render", async () => {
    const list = await eligible({ properties: [lockedProp(5)], jev_lead_decisions: [decision(1, u(5), t(1))] });
    expect(list.holds).toHaveLength(0);
  });

  it("a failed lock lookup fails closed", async () => {
    const page = await loadMessagesV2Page(
      db(
        { properties: [flagged(1, t(1))], jev_lead_decisions: [decision(1, u(9), t(2))] },
        { fail: (tb, _n, ops) => tb === "properties" && ops.some((o) => o.k === "eq" && "col" in o && o.col === "is_dnc_locked" && o.v === true) },
      ).client,
      "org",
    );
    expect(page.error).not.toBeNull();
    expect(page.holds).toHaveLength(0);
  });
});

describe("I4 every list query pages by keyset to exhaustion", () => {
  it("a 500-row server cap still reads all 1,200 flagged properties", async () => {
    const list = await eligible({ properties: Array.from({ length: 1200 }, (_, i) => flagged(i, t(i))) }, { cap: 500 });
    expect(list.holds).toHaveLength(1200);
  });

  it("an error on page 3 of a source fails closed", async () => {
    const decisions = Array.from({ length: 1200 }, (_, i) => decision(i, u(i), t(i)));
    const page = await loadMessagesV2Page(
      db({ properties: Array.from({ length: 1200 }, (_, i) => flagged(i, t(i))), jev_lead_decisions: decisions }, { cap: 500, fail: (tb, n) => tb === "jev_lead_decisions" && n === 3 }).client,
      "org",
    );
    expect(page.error).not.toBeNull();
    expect(page.holds).toHaveLength(0);
  });

  it("decisions with tied created_at are neither duplicated nor dropped", async () => {
    const decisions = Array.from({ length: 1200 }, (_, i) => decision(i, u(i), t(1)));
    const list = await eligible({ jev_lead_decisions: decisions }, { cap: 500 });
    expect(list.holds).toHaveLength(1200);
    expect(new Set(list.holds.map((h) => h.id)).size).toBe(1200);
  });
});

describe("I6 one effective reason from the complete list", () => {
  it("a hold on an older slice whose run has no reason shows its flag reason on the tape and the card", async () => {
    const properties = Array.from({ length: 45 }, (_, i) => flagged(i, t(i), { last_ai_escalation_reason: i === 0 ? "model:opt_out" : "model:unclear" }));
    const runs = [runRow(0, { property_id: u(0), reason: null, started_at: t(0) })];
    const page = await loadMessagesV2Page(db({ properties, pipeline_runs: runs }).client, "org");
    expect(page.holds.some((h) => h.id === u(0))).toBe(false); // oldest: not on page 1
    const reason = new Map(page.flagReasons).get(u(0, 5));
    expect(reason).toBe("model:opt_out");
    const slice = await loadHoldsSlice(db({ properties, pipeline_runs: runs }).client, "org", page.nextCursor!, 50);
    const hold = slice!.holds.find((h) => h.id === u(0))!;
    const eff = withEffectiveReason(hold.run!, hold.flag_reason);
    const card = holdReasonSentence(eff, eff.reason ?? hold.flag_reason, "Dee");
    const tape = deriveTape(hold.run!, "Dee", reason);
    expect(tape.kind === "decided" && tape.sentence).toBe(card);
    expect(card).toBe("Dee asked to stop. Nothing sent.");
    expect(effectiveFlagReasons([hold])).toEqual([[u(0, 5), "model:opt_out"]]);
  });
});

describe("I8 totals exclude locked and unverifiable holds", () => {
  it("total, remaining and the next cursor only count eligible holds", async () => {
    const page = await loadMessagesV2Page(
      db({
        properties: [...Array.from({ length: 42 }, (_, i) => flagged(i, t(i))), lockedProp(500)],
        jev_lead_decisions: [decision(1, u(500), t(1))],
        ai_reply_drafts: [draft(1)],
      }).client,
      "org",
    );
    expect(page.total).toBe(42);
    expect(page.remaining).toBe(2);
    expect(page.unverified).toBe(1);
    expect(page.nextCursor).toMatchObject(holdCursor(page.holds[page.holds.length - 1]));
    expect(page.nextCursor?.snapshotAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(page.nextCursor?.at).toBe(normalizeInstant(t(2)));
  });
});

describe("Codex round 9", () => {
  it("a later step on an OLDER related run lifts the hold (steps load for every related run)", async () => {
    const steps = [{ id: u(1, 8), org_id: "org", run_id: u(1, 5), seq: 1, kind: "gate", name: "g", result: "pass", detail: {}, created_at: t(900) }];
    const list = await eligible({
      properties: [flagged(1, t(100)), flagged(2, t(800))],
      ai_reply_drafts: [draft(1, { property_id: u(1), run_id: u(1, 5), created_at: t(100) })],
      pipeline_runs: [runRow(1, { property_id: null, started_at: t(200) }), runRow(2, { property_id: u(1), started_at: t(500) })],
      pipeline_run_steps: steps,
    });
    expect(list.holds[0].id).toBe(u(1)); // t(900) step on the older run beats property 2's t(800)
    expect(list.holds[0].run?.id).toBe(u(2, 5)); // the card still shows the newest run
  });

  it("under a 1-row server cap every lookup is read in full, so the order matches the uncapped order", async () => {
    const tables = {
      properties: [flagged(1, t(1)), flagged(2, t(2)), flagged(3, t(3))],
      jev_lead_decisions: [decision(1, u(1), t(1)), decision(2, u(2), t(2)), decision(3, u(1), t(4), { source_inbound_message_id: u(9, 3) })],
      pipeline_runs: [runRow(1, { inbound_message_id: u(9, 3), started_at: t(950) }), runRow(2, { inbound_message_id: u(2, 3), started_at: t(940) })],
      pipeline_run_steps: [],
    };
    const capped = await eligible(tables, { cap: 1 });
    const uncapped = await eligible(tables);
    expect(capped.holds.map((h) => h.id)).toEqual(uncapped.holds.map((h) => h.id));
    expect(capped.holds.map((h) => h.id)).toEqual([u(1), u(2), u(3)]);
  });

  it("a failed source-message run page fails the list rather than ordering on partial runs", async () => {
    const page = await loadMessagesV2Page(
      db(
        { properties: [flagged(1, t(1))], jev_lead_decisions: [decision(1, u(1), t(2))], pipeline_runs: [runRow(1, { inbound_message_id: u(1, 3) })] },
        { cap: 1, fail: (tb, _n, ops) => tb === "pipeline_runs" && ops.some((o) => o.k === "gt") && ops.some((o) => "col" in o && o.col === "inbound_message_id") },
      ).client,
      "org",
    );
    expect(page.error).not.toBeNull();
    expect(page.holds).toHaveLength(0);
  });

  it("a property-less run in a shared conversation is shown by ONE hold only, so tape and card agree", async () => {
    const tables = {
      properties: [flagged(1, t(1), { last_ai_escalation_reason: "model:opt_out" }), flagged(2, t(2), { last_ai_escalation_reason: "model:price_or_offer" })],
      jev_lead_decisions: [decision(1, u(1), t(1), { conversation_id: u(5, 2) }), decision(2, u(2), t(2), { conversation_id: u(5, 2) })],
      pipeline_runs: [runRow(1, { property_id: null, conversation_id: u(5, 2), started_at: t(900), reason: null })],
    };
    const list = await eligible(tables);
    const shown = list.holds.filter((h) => h.run?.id === u(1, 5));
    expect(shown.map((h) => h.id)).toEqual([u(2)]); // property 2 had the newer activity before the run
    const other = list.holds.find((h) => h.id === u(1))!;
    expect(other.run).toBeNull(); // the second hold does not display the shared run
    const reasons = new Map(effectiveFlagReasons(list.holds));
    expect(reasons.get(u(1, 5))).toBe("model:price_or_offer");
    const owner = shown[0];
    const eff = withEffectiveReason(owner.run!, owner.flag_reason);
    const card = holdReasonSentence(eff, eff.reason ?? owner.flag_reason, "Dee");
    const tape = deriveTape(owner.run!, "Dee", reasons.get(u(1, 5)));
    expect(tape.kind === "decided" && tape.sentence).toBe(card);
  });

  it("an older run linked only by property_id with a newer step lifts the hold", async () => {
    const list = await eligible({
      properties: [flagged(1, t(100)), flagged(2, t(800))],
      pipeline_runs: [runRow(1, { property_id: u(1), started_at: t(200) }), runRow(2, { property_id: u(1), started_at: t(500) })],
      pipeline_run_steps: [{ id: u(1, 8), org_id: "org", run_id: u(1, 5), seq: 1, kind: "gate", name: "g", result: "pass", detail: {}, created_at: t(900) }],
    });
    expect(list.holds[0].id).toBe(u(1));
    expect(list.holds[0].run?.id).toBe(u(2, 5)); // display run stays the newest
  });

  it("when the sharing holds agree, the tape claims that reason", async () => {
    const tables = {
      properties: [flagged(1, t(1), { last_ai_escalation_reason: "model:opt_out" }), flagged(2, t(2), { last_ai_escalation_reason: "model:opt_out" })],
      jev_lead_decisions: [decision(1, u(1), t(1), { conversation_id: u(5, 2) }), decision(2, u(2), t(2), { conversation_id: u(5, 2) })],
      pipeline_runs: [runRow(1, { property_id: null, conversation_id: u(5, 2), started_at: t(900), reason: null })],
    };
    expect(effectiveFlagReasons((await eligible(tables)).holds)).toEqual([[u(1, 5), "model:opt_out"]]);
  });
});

describe("Codex round 11", () => {
  it("a property-less run linked to A by inbound message and to B by conversation is owned by ONE hold; tape and cards agree", async () => {
    const tables = {
      properties: [flagged(1, t(10), { last_ai_escalation_reason: "model:opt_out" }), flagged(2, t(20), { last_ai_escalation_reason: "model:price_or_offer" })],
      jev_lead_decisions: [
        decision(1, u(1), t(10), { source_inbound_message_id: u(1, 6), conversation_id: u(8, 2) }),
        decision(2, u(2), t(20), { conversation_id: u(5, 2) }),
      ],
      pipeline_runs: [runRow(1, { property_id: null, inbound_message_id: u(1, 6), conversation_id: u(5, 2), started_at: t(900), reason: null })],
    };
    const list = await eligible(tables);
    const showing = list.holds.filter((h) => h.run?.id === u(1, 5));
    expect(showing).toHaveLength(1);
    expect(showing[0].id).toBe(u(2)); // newer activity before the run wins
    const reasons = new Map(effectiveFlagReasons(list.holds));
    for (const h of list.holds) {
      if (!h.run) continue;
      const eff = withEffectiveReason(h.run, h.flag_reason);
      const card = holdReasonSentence(eff, eff.reason ?? h.flag_reason, "Dee");
      const tape = deriveTape(h.run, "Dee", reasons.get(h.run.id));
      expect(tape.kind === "decided" && tape.sentence).toBe(card);
    }
  });

  it("snapshot paging: a hold that gains activity after the snapshot keeps its place; a brand-new hold waits for a reload", async () => {
    const tables: Record<string, Row[]> = {
      properties: [flagged(1, t(500)), flagged(2, t(400)), flagged(3, t(300))],
      pipeline_runs: [],
    };
    const snap = normalizeInstant(t(600))!;
    const page1 = pageHolds((await eligible(tables)).holds.filter(() => true), null, 1, snap);
    expect(page1.holds.map((h) => h.id)).toEqual([u(1)]);
    // Between pages: hold 3 gets a fresh run, and a brand-new hold 4 is flagged.
    tables.pipeline_runs = [runRow(3, { property_id: u(3), started_at: t(900) })];
    tables.properties = [...tables.properties, flagged(4, t(950))];
    const ids: string[] = [...page1.holds.map((h) => h.id)];
    let cursor = page1.nextCursor;
    while (cursor) {
      const slice = await loadHoldsSlice(db(tables).client, "org", cursor, 1);
      ids.push(...slice!.holds.map((h) => h.id));
      cursor = slice!.nextCursor;
    }
    expect(ids).toEqual([u(1), u(2), u(3)]); // 3 is still reached at its snapshot place; 4 is not in this walk
    const reloaded = await loadEligibleHolds(db(tables).client, "org", normalizeInstant(t(1000)));
    expect(reloaded.ok && reloaded.holds.map((h) => h.id).slice(0, 2)).toEqual([u(4), u(3)]); // a reload shows both at the top
  });
});

describe("Codex round 12: one snapshot rule for every input", () => {
  const walkFrom = async (tables: Record<string, Row[]>, snap: string) => {
    const first = await loadEligibleHolds(db(tables).client, "org", snap);
    if (!first.ok) throw new Error(first.error);
    const page1 = pageHolds(first.holds, null, 1, snap);
    return { page1, next: async () => {
      const ids: string[] = [];
      let cursor = page1.nextCursor;
      while (cursor) {
        const s = await loadHoldsSlice(db(tables).client, "org", cursor, 1);
        ids.push(...s!.holds.map((h) => h.id));
        cursor = s!.nextCursor;
      }
      return ids;
    } };
  };

  it("an escalation AFTER the snapshot on an older flag does not move the hold ahead of the cursor", async () => {
    const tables: Record<string, Row[]> = { properties: [flagged(1, t(500)), flagged(2, t(400)), flagged(3, t(300))] };
    const snap = normalizeInstant(t(600))!;
    const { page1, next } = await walkFrom(tables, snap);
    expect(page1.holds.map((h) => h.id)).toEqual([u(1)]);
    tables.properties = tables.properties.map((p) => (p.id === u(3) ? { ...p, last_ai_escalation_at: t(950) } : p)); // flag time kept
    tables.lead_events = [{ id: u(3, 9), org_id: "org", event_type: "ai_escalated", property_id: u(3), created_at: t(950) }];
    expect(await next()).toEqual([u(2), u(3)]);
    const reloaded = await loadEligibleHolds(db(tables).client, "org", normalizeInstant(t(1000)));
    expect(reloaded.ok && reloaded.holds[0].id).toBe(u(3)); // a reload sees the escalation
  });

  it("a message added after the snapshot does not change draft resolution within the walk; it does after reload", async () => {
    const tables: Record<string, Row[]> = {
      properties: [flagged(1, t(500)), flagged(2, t(400))],
      ai_reply_drafts: [draft(1, { conversation_id: u(3, 9), created_at: t(450) })], // no property yet: unverifiable
      messages: [],
    };
    const snap = normalizeInstant(t(600))!;
    const first = await loadEligibleHolds(db(tables).client, "org", snap);
    expect(first.ok && first.unverified).toBe(1);
    const { next } = await walkFrom(tables, snap);
    tables.messages = [message(1, { conversation_id: u(3, 9), property_id: u(30), created_at: t(900) })];
    expect(await next()).toEqual([u(2)]); // the late message does not make the draft eligible mid-walk
    const reloaded = await loadEligibleHolds(db(tables).client, "org", normalizeInstant(t(1000)));
    expect(reloaded.ok && reloaded.holds.map((h) => h.id)).toContain(u(30));
  });

  it("a DNC lock set after the snapshot still hides the hold (the lock is never snapshotted)", async () => {
    const tables: Record<string, Row[]> = { properties: [flagged(1, t(500)), flagged(2, t(400)), flagged(3, t(300))] };
    const { next } = await walkFrom(tables, normalizeInstant(t(600))!);
    tables.properties = tables.properties.map((p) => (p.id === u(3) ? { ...p, is_dnc_locked: true } : p));
    expect(await next()).toEqual([u(2)]);
  });
});

describe("Codex round 13: immutable escalation history", () => {
  const esc = (n: number, property: string, at: string): Row => ({ id: u(n, 9), org_id: "org", event_type: "ai_escalated", property_id: property, created_at: at });

  it("a hold shown on page 1 that escalates again between pages is neither repeated nor skipped", async () => {
    const tables: Record<string, Row[]> = {
      properties: [flagged(1, t(100)), flagged(2, t(90)), flagged(3, t(80))],
      lead_events: [esc(1, u(1), t(500)), esc(2, u(2), t(400)), esc(3, u(3), t(300))],
    };
    const snap = normalizeInstant(t(600))!;
    const first = await loadEligibleHolds(db(tables).client, "org", snap);
    const page1 = pageHolds(first.ok ? first.holds : [], null, 1, snap);
    expect(page1.holds.map((h) => h.id)).toEqual([u(1)]);
    // Re-escalation after the snapshot: the mutable column is overwritten and a new event is logged.
    tables.properties = tables.properties.map((p) => (p.id === u(1) ? { ...p, last_ai_escalation_at: t(900) } : p));
    tables.lead_events = [...tables.lead_events, esc(4, u(1), t(900))];
    const ids: string[] = [];
    let cursor = page1.nextCursor;
    while (cursor) {
      const s = await loadHoldsSlice(db(tables).client, "org", cursor, 1);
      ids.push(...s!.holds.map((h) => h.id));
      cursor = s!.nextCursor;
    }
    expect(ids).toEqual([u(2), u(3)]);
  });

  it("the mutable escalation column never drives order; the event log does", async () => {
    const list = await eligible({
      properties: [flagged(1, t(10), { last_ai_escalation_at: t(999) }), flagged(2, t(20))],
      lead_events: [esc(1, u(2), t(500))],
    });
    expect(list.holds.map((h) => h.id)).toEqual([u(2), u(1)]);
  });

  it("a failed escalation-history read fails the list closed", async () => {
    const page = await loadMessagesV2Page(db({ properties: [flagged(1, t(1))] }, { fail: (tb) => tb === "lead_events" }).client, "org");
    expect(page.error).not.toBeNull();
    expect(page.holds).toHaveLength(0);
  });
});
