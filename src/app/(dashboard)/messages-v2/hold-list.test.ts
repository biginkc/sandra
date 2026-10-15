import { decodeSnapshot, encodeSnapshot } from "./snapshot-codec";
import { describe, expect, it } from "vitest";

import { fakePostgrest } from "./fake-postgrest.test-util";
import { parseSnapshotIds } from "./hold-activity";
import { loadHoldsByIds, loadMessagesV2Page } from "./holds-by-activity";
import { buildSnapshot, draftStillOn, enrichPage, effectiveFlagReasons, liveStateOf, loadEligibleHolds, recheckOpen, snapshotFlagReasons } from "./hold-list";
import { deriveTape, holdReasonSentence, withEffectiveReason } from "./tape";
import type { OpenHold, RunWithSteps } from "./types";

type Row = Record<string, unknown>;
const u = (n: number, ns = 0) => `${String(ns).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const t = (sec: number, micros = "000000") => {
  const d = new Date(Date.UTC(2026, 9, 1) + sec * 1000).toISOString().slice(0, 19);
  return `${d}.${micros}+00:00`;
};
/** An unflagged, unlocked property that simply exists in the org (drafts may resolve to it). */
const plainProp = (n: number): Row => ({ id: u(n), org_id: "org", needs_human_attention: false, is_dnc_locked: false });
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
  return fakePostgrest(tables, { ...opts, rpc: { ...latestRpc(tables), hold_alert_latest_status: () => ({ data: [], error: null }), ...(opts.rpc ?? {}) } });
}

const eligible = async (tables: Record<string, Row[]>, opts: Parameters<typeof fakePostgrest>[1] = {}) => {
  const res = await loadEligibleHolds(db(tables, opts).client, "org");
  if (!res.ok) throw new Error(res.error);
  return res;
};

/** Walks a snapshot the way the column does: first page from page 1, then 50 ids at a time against CURRENT data. */
const walkSnapshot = async (tables: Record<string, Row[]>, between?: (page: number) => void) => {
  const first = await loadMessagesV2Page(db(tables).client, "org");
  const entries = decodeSnapshot(first.snapshot).entries;
  w0Order = entries.map((e) => e.id);
  const shown = first.holds.map((h) => h.id);
  const missing: string[] = [];
  let pos = first.holds.length;
  let page = 0;
  while (pos < entries.length) {
    between?.(page++);
    const ids = entries.slice(pos, pos + 50).map((e) => e.id);
    const res = await loadHoldsByIds(db(tables).client, "org", ids);
    if (!res) throw new Error("slice failed");
    const found = new Set(res.holds.map((h) => h.id));
    for (const id of ids) (found.has(id) ? shown : missing).push(id);
    pos += ids.length;
  }
  return { first, shown, missing, order: entries.map((e) => e.id) };
};

describe("I1 every eligible hold is reachable in one snapshot order", () => {
  it("2,500 holds, 50 at a time: every id exactly once, in snapshot order", async () => {
    const properties = Array.from({ length: 2500 }, (_, i) => flagged(i, t(i)));
    const w = await walkSnapshot({ properties });
    expect(w.shown).toEqual(w.order);
    expect(new Set(w.shown).size).toBe(2500);
    expect(w.missing).toEqual([]);
  });

  it("churn between pages (30 resolved, 20 new, 5 re-flagged, a draft approved): no skip, no duplicate; resolved -> missing; new only after reload", async () => {
    const tables: Record<string, Row[]> = {
      properties: Array.from({ length: 300 }, (_, i) => flagged(i, t(i))),
      ai_reply_drafts: [draft(1, { property_id: u(100), run_id: u(1, 5), created_at: t(100) })],
      pipeline_runs: [runRow(1, { property_id: null, started_at: t(9000) })], // the draft's run lifts property 100
    };
    let resolved: string[] = [];
    const w = await walkSnapshot(tables, (page) => {
      if (page !== 0) return;
      const tail = w0Order.slice(-60);
      resolved = tail.slice(0, 30);
      tables.properties = tables.properties
        .filter((p) => !resolved.includes(p.id as string))
        .map((p) => (tail.slice(30, 35).includes(p.id as string) ? { ...p, needs_human_attention_since: t(99_999), last_ai_escalation_at: t(99_999) } : p));
      tables.properties.push(...Array.from({ length: 20 }, (_, i) => flagged(1000 + i, t(50_000 + i))));
      tables.ai_reply_drafts = []; // approved: the run no longer lifts property 100
    });
    expect(new Set(w.shown).size).toBe(w.shown.length); // no duplicate
    expect([...w.shown, ...w.missing].sort()).toEqual([...w.order].sort()); // no skip
    expect(w.missing.sort()).toEqual([...resolved].sort());
    expect(w.order.some((id) => id === u(1000))).toBe(false);
    const reload = await loadMessagesV2Page(db(tables).client, "org");
    const ids = decodeSnapshot(reload.snapshot).entries.map((e) => e.id);
    expect(ids).toContain(u(1000 + 19)); // new ones appear after reload
    expect(ids.slice(0, 5).sort()).toEqual(w0Order.slice(-30, -25).sort()); // re-flagged ones rise to the top
  });
});

let w0Order: string[] = [];

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
      properties: [plainProp(11), plainProp(12)],
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
        // the positive verification read (by id, not the flagged-source read)
        { fail: (tb, _n, ops) => tb === "properties" && ops.some((o) => o.k === "in" && o.col === "id") && !ops.some((o) => "col" in o && o.col === "needs_human_attention") },
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
    const list = await eligible({ jev_lead_decisions: decisions, properties: decisions.map((_, i) => plainProp(i)) }, { cap: 500 });
    expect(list.holds).toHaveLength(1200);
    expect(new Set(list.holds.map((h) => h.id)).size).toBe(1200);
  });
});

describe("I6 / I8 snapshot reasons and counts", () => {
  it("a hold beyond page 1 whose run has no reason shows the flag reason on the tape and the card", async () => {
    const properties = Array.from({ length: 45 }, (_, i) => flagged(i, t(i), { last_ai_escalation_reason: i === 0 ? "model:opt_out" : "model:unclear" }));
    const runs = [runRow(0, { property_id: u(0), reason: null, started_at: t(0) })];
    const page = await loadMessagesV2Page(db({ properties, pipeline_runs: runs }).client, "org");
    expect(page.holds.some((h) => h.id === u(0))).toBe(false);
    const reason = new Map(page.flagReasons).get(u(0, 5));
    expect(reason).toBe("model:opt_out");
    const more = await loadHoldsByIds(db({ properties, pipeline_runs: runs }).client, "org", [u(0)]);
    const hold = more!.holds[0];
    const entry = decodeSnapshot(page.snapshot).entries.find((e) => e.id === u(0))!;
    const snapReason = decodeSnapshot(page.snapshot).reasons[entry.r];
    const eff = withEffectiveReason(hold.run!, snapReason);
    const card = holdReasonSentence(eff, eff.reason ?? snapReason, "Dee");
    const tape = deriveTape(hold.run!, "Dee", reason);
    expect(tape.kind === "decided" && tape.sentence).toBe(card);
    expect(card).toBe("Dee asked to stop. Nothing sent.");
  });

  it("locked and unverifiable holds are never snapshot entries", async () => {
    const page = await loadMessagesV2Page(
      db({
        properties: [...Array.from({ length: 42 }, (_, i) => flagged(i, t(i))), lockedProp(500)],
        jev_lead_decisions: [decision(1, u(500), t(1))],
        ai_reply_drafts: [draft(1)],
      }).client,
      "org",
    );
    expect(decodeSnapshot(page.snapshot).entries).toHaveLength(42);
    expect(page.unverified).toBe(1);
    expect(page.holds).toHaveLength(40);
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
});


describe("spec 2: client-held snapshot", () => {
  const stamp = (tables: Record<string, Row[]>, id: string, reason: string, at: string) => {
    // Mirrors dispatch.ts stampHoldReason / flagConfirmDncHold / number-source refresh: columns overwritten, no event.
    tables.properties = tables.properties.map((p) => (p.id === id ? { ...p, last_ai_escalation_reason: reason, last_ai_escalation_at: at } : p));
  };

  it.each(["stampHoldReason", "flagConfirmDncHold", "number-source refresh"])(
    "R1 (%s): an older hold re-stamped after page 1 keeps its snapshot place; a reload puts it first",
    async () => {
      const tables: Record<string, Row[]> = { properties: Array.from({ length: 60 }, (_, i) => flagged(i, t(i))) };
      const first = await loadMessagesV2Page(db(tables).client, "org");
      const target = decodeSnapshot(first.snapshot).entries[55].id;
      stamp(tables, target, "hostile_needs_confirm", t(99_999));
      const res = await loadHoldsByIds(db(tables).client, "org", decodeSnapshot(first.snapshot).entries.slice(40, 60).map((e) => e.id));
      expect(res!.missing).toEqual([]);
      const card = res!.holds.find((h) => h.id === target)!;
      const entry = decodeSnapshot(first.snapshot).entries[55];
      expect(card.flag_reason).not.toBe(decodeSnapshot(first.snapshot).reasons[entry.r]); // live differs -> the column marks it Updated
      const reload = await loadMessagesV2Page(db(tables).client, "org");
      expect(decodeSnapshot(reload.snapshot).entries[0].id).toBe(target);
    },
  );

  it("I2: a failed lookup inside the slice fails closed (null: no new cards, the client keeps its position)", async () => {
    const tables = { properties: [flagged(1, t(1))], pipeline_runs: [runRow(1, { property_id: u(1) })] };
    expect(await loadHoldsByIds(db(tables, { fail: (tb) => tb === "pipeline_run_steps" }).client, "org", [u(1)])).toBeNull();
  });

  it("I3: a hold locked after page 1 comes back missing and is not rendered", async () => {
    const tables: Record<string, Row[]> = { properties: [flagged(1, t(1)), flagged(2, t(2))] };
    await loadMessagesV2Page(db(tables).client, "org");
    tables.properties = tables.properties.map((p) => (p.id === u(1) ? { ...p, is_dnc_locked: true } : p));
    const res = await loadHoldsByIds(db(tables).client, "org", [u(1), u(2)]);
    expect(res!.missing).toEqual([u(1)]);
    expect(res!.holds.map((h) => h.id)).toEqual([u(2)]);
  });

  it("input validation: more than 100 ids, a non-uuid or nothing is rejected; another org's id leaks nothing", async () => {
    expect(parseSnapshotIds(Array.from({ length: 101 }, (_, i) => u(i)))).toBeNull();
    expect(parseSnapshotIds([u(1), "nope"])).toBeNull();
    expect(parseSnapshotIds([])).toBeNull();
    expect(parseSnapshotIds([u(1), u(1)])).toEqual([u(1)]);
    const other = { properties: [flagged(1, t(1), { org_id: "other-org" })] };
    const res = await loadHoldsByIds(db(other).client, "org", [u(1)]);
    expect(res!.holds).toEqual([]);
    expect(res!.missing).toEqual([u(1)]);
  });

  it("a 10,000-entry snapshot serializes under 2 MB", () => {
    const holds = Array.from({ length: 10_000 }, (_, i) => ({
      id: u(i), property_id: u(i), conversation_id: null, sources: ["needs_attention"], since: t(i), reason: "r",
      flag_reason: i % 2 ? "model:unclear" : "model:opt_out", seen: { through: null, flagReason: "model:unclear", flagAt: t(i) },
      run: { ...runRow(i), steps: [] },
      draft: { id: u(50_000 + i), inbound_message_id: u(60_000 + i), body: "x", sendable: i % 3 === 0 },
    })) as unknown as OpenHold<RunWithSteps>[];
    const snap = buildSnapshot(holds);
    const wire = JSON.stringify(encodeSnapshot(snap));
    expect(wire.length).toBeLessThan(2_000_000);
    expect(decodeSnapshot(JSON.parse(wire))).toEqual(snap);
    expect(snapshotFlagReasons(snap)).toHaveLength(10_000);
  });

  it("display reason is frozen at snapshot time: flag reason, else run reason; flag reason `r` is unchanged", () => {
    const base = { conversation_id: null, sources: ["pending_draft"], since: t(1) };
    const unflagged = { ...base, id: u(1), property_id: u(1), flag_reason: undefined, run: { ...runRow(1, { reason: "model:not_interested" }), steps: [] } };
    const flaggedHold = { ...base, id: u(2), property_id: u(2), flag_reason: "model:hot_lead", run: { ...runRow(2, { reason: "model:not_interested" }), steps: [] } };
    const neither = { ...base, id: u(3), property_id: u(3), flag_reason: undefined, run: { ...runRow(3, { reason: null }), steps: [] } };
    const snap = buildSnapshot([unflagged, flaggedHold, neither] as unknown as OpenHold<RunWithSteps>[]);
    const [a, b, c] = snap.entries;
    expect(a.r).toBe(-1);
    expect(snap.reasons[a.x!]).toBe("model:not_interested");
    expect(snap.reasons[b.r]).toBe("model:hot_lead");
    expect(b.x).toBeUndefined();
    expect(c.r).toBe(-1);
    expect(c.x).toBeUndefined();
    const reasons = new Map(snapshotFlagReasons(snap));
    expect(reasons.get(u(1, 5))).toBe("model:not_interested");
    expect(reasons.get(u(2, 5))).toBe("model:hot_lead");
    expect(reasons.get(u(3, 5))).toBeNull();
    expect(decodeSnapshot(JSON.parse(JSON.stringify(encodeSnapshot(snap))))).toEqual(snap);
  });

  it("production rows (2026-10-15): Martha -> Not interested; Sue, William, Justin -> Wants an offer, on tape and card", () => {
    const rows = [
      { who: "Martha", flag: undefined, run: "model:not_interested", status: "held", tag: "Not interested", sentence: "Martha may have said no. Not sure enough to close it." },
      { who: "Sue", flag: "model:call_request", run: "model:call_request", status: "escalated", tag: "Wants an offer", sentence: "Sue may want an offer. Nothing sent." },
      { who: "William", flag: "model:call_request", run: "model:call_request", status: "escalated", tag: "Wants an offer", sentence: "William may want an offer. Nothing sent." },
      { who: "Justin", flag: "model:call_request", run: "model:call_request", status: "escalated", tag: "Wants an offer", sentence: "Justin may want an offer. Nothing sent." },
    ];
    const holds = rows.map((r, i) => ({
      id: u(i + 1), property_id: u(i + 1), conversation_id: null, sources: ["needs_attention"], since: t(i), flag_reason: r.flag,
      run: { ...runRow(i + 1, { reason: r.run, status: r.status }), steps: [] },
    })) as unknown as OpenHold<RunWithSteps>[];
    const reasons = new Map(snapshotFlagReasons(buildSnapshot(holds)));
    rows.forEach((r, i) => {
      const run = holds[i].run!;
      const pinned = reasons.get(run.id) ?? null;
      const tape = deriveTape(run, r.who, pinned, true);
      expect(tape.kind === "decided" && tape.tag?.label).toBe(r.tag);
      expect(tape.kind === "decided" && tape.sentence).toBe(r.sentence);
      expect(holdReasonSentence({ ...run, reason: pinned }, pinned, r.who, true)).toBe(r.sentence);
    });
  });

  it("snapshot encode/decode round-trips every pinned field, including odd instants and missing values", () => {
    const snap = {
      reasons: ["model:unclear"],
      entries: [
        { id: u(1), at: "2026-10-14T12:00:00.123456Z", r: 0, run: u(2), fa: "2026-10-14T12:00:00.123456Z", th: "2026-10-13T01:02:03.000001Z", d: u(3), ds: true },
        { id: u(4), at: "2026-10-14T12:00:00.000000Z", r: -1, run: null, fa: null, th: null },
        { id: u(5), at: null, r: 0, run: null, fa: "2026-10-01 00:00:00+00", th: "2026-10-02T00:00:00Z", d: u(6), ds: false },
        { id: "not-a-uuid", at: "1969-12-31T23:59:59.999999Z", r: 0, run: "abc", fa: "2026-10-05T00:00:00.000000Z", th: null },
      ],
    };
    expect(decodeSnapshot(JSON.parse(JSON.stringify(encodeSnapshot(snap))))).toEqual(snap);
  });
});

describe("final checks and live re-check", () => {
  it("a hold locked between snapshot build and enrichment is dropped from the cards and reported missing", async () => {
    const tables: Record<string, Row[]> = { properties: [flagged(1, t(1)), flagged(2, t(2))] };
    const client = db(tables).client;
    // Lock property 2 the moment the enrichment step reads draft text (after the snapshot is built).
    const orig = (client as unknown as { from: (t: string) => Record<string, unknown> }).from;
    let locked = false;
    (client as unknown as { from: (t: string) => unknown }).from = (tb: string) => {
      if (tb === "hold_alert_latest_status" || tb === "ai_reply_dead_letters") {
        if (!locked) {
          locked = true;
          tables.properties = tables.properties.map((p) => (p.id === u(2) ? { ...p, is_dnc_locked: true } : p));
        }
      }
      return orig(tb);
    };
    (client as unknown as { rpc: (fn: string, a: Record<string, unknown>) => unknown }).rpc = async (fn: string, a: Record<string, unknown>) => {
      if (fn === "hold_alert_latest_status" && !locked) {
        locked = true;
        tables.properties = tables.properties.map((p) => (p.id === u(2) ? { ...p, is_dnc_locked: true } : p));
      }
      return latestRpc(tables)[fn as "pipeline_runs_latest_for_properties"]?.(a) ?? { data: [], error: null };
    };
    const page = await loadMessagesV2Page(client, "org");
    expect(decodeSnapshot(page.snapshot).entries.map((e) => e.id)).toContain(u(2));
    expect(page.holds.map((h) => h.id)).toEqual([u(1)]);
    expect(page.missing).toEqual([u(2)]);
  });

  it("recheckOpen keeps a draft-only hold whose draft is still pending, and fails closed on an error", async () => {
    const tables = { properties: [plainProp(3)], ai_reply_drafts: [draft(1, { property_id: null, run_id: u(1, 5) })], pipeline_runs: [runRow(1, { property_id: u(3) })] };
    const list = await eligible(tables);
    expect(list.holds.map((h) => h.id)).toEqual([u(3)]);
    expect([...(await recheckOpen(db(tables).client, "org", list.holds))!.open]).toEqual([u(3)]);
    expect(await recheckOpen(db(tables, { fail: () => true }).client, "org", list.holds)).toBeNull();
  });

  it("liveStateOf reports locked/resolved as not eligible and re-stamped flags with the new values", async () => {
    const tables: Record<string, Row[]> = { properties: [flagged(1, t(1)), flagged(2, t(2)), flagged(3, t(3))] };
    tables.properties = tables.properties.map((p) =>
      p.id === u(1) ? { ...p, is_dnc_locked: true } : p.id === u(2) ? { ...p, last_ai_escalation_at: t(900), last_ai_escalation_reason: "hostile_needs_confirm" } : p,
    );
    tables.properties = tables.properties.filter((p) => p.id !== u(3));
    const states = (await liveStateOf(db(tables).client, "org", [u(1), u(2), u(3)]))!;
    expect(states.find((s) => s.id === u(1))!.eligible).toBe(false);
    expect(states.find((s) => s.id === u(3))!.eligible).toBe(false);
    expect(states.find((s) => s.id === u(2))).toMatchObject({ eligible: true, flagReason: "hostile_needs_confirm", flagAt: t(900) });
  });
});

describe("final check re-resolves drafts", () => {
  it("a draft reassigned to a locked property between snapshot and enrichment lands in missing", async () => {
    const tables: Record<string, Row[]> = {
      properties: [lockedProp(9), plainProp(3)],
      ai_reply_drafts: [draft(1, { run_id: u(1, 5) })],
      pipeline_runs: [runRow(1, { property_id: u(3) })],
    };
    const client = db(tables).client;
    let moved = false;
    (client as unknown as { rpc: (fn: string, a: Record<string, unknown>) => unknown }).rpc = async (fn: string, a: Record<string, unknown>) => {
      if (fn === "hold_alert_latest_status" && !moved) {
        moved = true; // during enrichment: the run (and so the draft) now points at locked property 9
        tables.pipeline_runs = tables.pipeline_runs.map((r) => ({ ...r, property_id: u(9) }));
      }
      return latestRpc(tables)[fn as "pipeline_runs_latest_for_properties"]?.(a) ?? { data: [], error: null };
    };
    const page = await loadMessagesV2Page(client, "org");
    expect(decodeSnapshot(page.snapshot).entries.map((e) => e.id)).toEqual([u(3)]);
    expect(page.holds).toHaveLength(0);
    expect(page.missing).toEqual([u(3)]);
  });
});

describe("final check contract: recompute from current data, compare to pins, never carry forward", () => {
  const during = (tables: Record<string, Row[]>, change: () => void) => {
    const client = db(tables).client;
    let moved = false;
    (client as unknown as { rpc: (fn: string, a: Record<string, unknown>) => unknown }).rpc = async (fn: string, a: Record<string, unknown>) => {
      if (fn === "hold_alert_latest_status" && !moved) {
        moved = true;
        change();
      }
      return latestRpc(tables)[fn as "pipeline_runs_latest_for_properties"]?.(a) ?? { data: [], error: null };
    };
    return client;
  };

  it("a pending decision resolves during build while the flag keeps the hold open: card changed, version is the CURRENT one", async () => {
    const tables: Record<string, Row[]> = { properties: [flagged(1, t(1))], jev_lead_decisions: [decision(1, u(1), t(5))] };
    const client = during(tables, () => {
      tables.jev_lead_decisions = tables.jev_lead_decisions.map((d) => ({ ...d, status: "applied" }));
    });
    const page = await loadMessagesV2Page(client, "org");
    expect(page.holds.map((h) => h.id)).toEqual([u(1)]);
    expect(page.holds[0].recheck_changed).toBe(true);
    expect(page.holds[0].seen?.through).toBeNull(); // never the older pending-row time carried forward
  });

  it("a new run-linked draft arrives during build while the flag keeps the hold open: card changed", async () => {
    const tables: Record<string, Row[]> = { properties: [flagged(1, t(1))], pipeline_runs: [runRow(2, { property_id: u(1) })], ai_reply_drafts: [] };
    const client = during(tables, () => {
      tables.ai_reply_drafts = [draft(7, { run_id: u(2, 5), created_at: t(30) })];
    });
    const page = await loadMessagesV2Page(client, "org");
    expect(page.holds.map((h) => h.id)).toEqual([u(1)]);
    expect(page.holds[0].recheck_changed).toBe(true);
  });

  it("nothing changed during build: not marked, version equals the built one", async () => {
    const tables: Record<string, Row[]> = { properties: [flagged(1, t(1))], jev_lead_decisions: [decision(1, u(1), t(5))] };
    const page = await loadMessagesV2Page(db(tables).client, "org");
    expect(page.holds[0].recheck_changed).toBeUndefined();
    expect(page.holds[0].seen?.through).toBe(t(5));
  });

  it("locked during build -> missing; lookup failure -> fail closed", async () => {
    const tables: Record<string, Row[]> = { properties: [flagged(1, t(1))] };
    const client = during(tables, () => {
      tables.properties = tables.properties.map((p) => ({ ...p, is_dnc_locked: true }));
    });
    const page = await loadMessagesV2Page(client, "org");
    expect(page.missing).toEqual([u(1)]);
    const list = await eligible({ properties: [flagged(1, t(1))] });
    expect(await recheckOpen(db({ properties: [flagged(1, t(1))] }, { fail: () => true }).client, "org", list.holds)).toBeNull();
  });
});

describe("fresh version check", () => {
  it("a failed fresh-seen lookup is reported (column pauses actions), never silently kept", async () => {
    const tables: Record<string, Row[]> = { properties: [flagged(1, t(1))] };
    const list = await eligible(tables);
    const res = await enrichPage(db(tables, { fail: (table) => table === "jev_lead_decisions" }).client, "org", list.holds);
    expect(res!.contextErrors).toContain("version check");
    const ok = await enrichPage(db(tables).client, "org", list.holds);
    expect(ok!.contextErrors).not.toContain("version check");
  });

  it("the final check returns each hold's current flag and pending version", async () => {
    const tables: Record<string, Row[]> = { properties: [flagged(1, t(1))] };
    const list = await eligible(tables);
    tables.properties = tables.properties.map((p) => ({ ...p, last_ai_escalation_reason: "hostile_needs_confirm", last_ai_escalation_at: t(50) }));
    const still = (await recheckOpen(db(tables).client, "org", list.holds))!;
    expect(still.version.get(u(1))).toMatchObject({ flagReason: "hostile_needs_confirm", flagAt: t(50) });
  });
});

describe("final check keeps holds another current source still holds open", () => {
  it("the displayed draft resolves and a new run-linked draft arrives: card stays (draft dropped), count unchanged", async () => {
    const tables: Record<string, Row[]> = {
      properties: [plainProp(3)],
      ai_reply_drafts: [draft(1, { property_id: u(3) })],
      pipeline_runs: [runRow(2, { property_id: u(3) })],
    };
    const client = db(tables).client;
    let moved = false;
    (client as unknown as { rpc: (fn: string, a: Record<string, unknown>) => unknown }).rpc = async (fn: string, a: Record<string, unknown>) => {
      if (fn === "hold_alert_latest_status" && !moved) {
        moved = true; // during enrichment: the shown draft is sent, a new draft linked ONLY by run arrives
        tables.ai_reply_drafts = [{ ...tables.ai_reply_drafts[0], status: "sent" }, draft(5, { run_id: u(2, 5), created_at: t(20) })];
      }
      return latestRpc(tables)[fn as "pipeline_runs_latest_for_properties"]?.(a) ?? { data: [], error: null };
    };
    const page = await loadMessagesV2Page(client, "org");
    expect(decodeSnapshot(page.snapshot).entries.map((e) => e.id)).toEqual([u(3)]);
    expect(page.missing).toEqual([]);
    expect(page.holds.map((h) => h.id)).toEqual([u(3)]);
    expect(page.holds[0].draft).toBeUndefined(); // Send/Edit have nothing to act on; the column marks it Updated
  });
});

describe("Codex round: drafts must still belong to the hold, and to the org", () => {
  it("a displayed draft moved to another property mid-enrichment is removed from the card (Send disabled), original flag keeps the hold", async () => {
    const tables: Record<string, Row[]> = {
      properties: [flagged(3, t(1))],
      ai_reply_drafts: [draft(1, { property_id: u(3), created_at: t(5) })],
    };
    const client = db(tables).client;
    let moved = false;
    (client as unknown as { rpc: (fn: string, a: Record<string, unknown>) => unknown }).rpc = async (fn: string, a: Record<string, unknown>) => {
      if (fn === "hold_alert_latest_status" && !moved) {
        moved = true;
        tables.ai_reply_drafts = tables.ai_reply_drafts.map((d) => ({ ...d, property_id: u(4) }));
      }
      return latestRpc(tables)[fn as "pipeline_runs_latest_for_properties"]?.(a) ?? { data: [], error: null };
    };
    const page = await loadMessagesV2Page(client, "org");
    expect(page.holds.map((h) => h.id)).toEqual([u(3)]);
    expect(page.holds[0].draft).toBeUndefined();
  });

  it("the same move on a draft-only hold sends the hold to missing", async () => {
    const tables: Record<string, Row[]> = { ai_reply_drafts: [draft(1, { property_id: u(3), created_at: t(5) })], properties: [{ id: u(3), org_id: "org", needs_human_attention: false, is_dnc_locked: false }, { id: u(4), org_id: "org", needs_human_attention: false, is_dnc_locked: false }] };
    const client = db(tables).client;
    let moved = false;
    (client as unknown as { rpc: (fn: string, a: Record<string, unknown>) => unknown }).rpc = async (fn: string, a: Record<string, unknown>) => {
      if (fn === "hold_alert_latest_status" && !moved) {
        moved = true;
        tables.ai_reply_drafts = tables.ai_reply_drafts.map((d) => ({ ...d, property_id: u(4) }));
      }
      return latestRpc(tables)[fn as "pipeline_runs_latest_for_properties"]?.(a) ?? { data: [], error: null };
    };
    const page = await loadMessagesV2Page(client, "org");
    expect(page.holds).toHaveLength(0);
    expect(page.missing).toEqual([u(3)]);
  });

  it("a draft pointing at another org's property is excluded and counted unverifiable", async () => {
    const list = await eligible({
      properties: [{ id: u(7), org_id: "other-org", needs_human_attention: false, is_dnc_locked: true }],
      ai_reply_drafts: [draft(1, { property_id: u(7) })],
    });
    expect(list.holds).toHaveLength(0);
    expect(list.unverified).toBe(1);
  });
});

describe("Send / Edit guard: the draft must still be on the property the clicker saw", () => {
  it("a draft moved to another (unlocked) property -> a Send with the old property id is STALE", async () => {
    const tables = { properties: [plainProp(3), plainProp(4)], ai_reply_drafts: [draft(1, { property_id: u(4) })] };
    expect(await draftStillOn(db(tables).client, "org", u(1, 4), u(3))).toBe("stale");
    expect(await draftStillOn(db(tables).client, "org", u(1, 4), u(4))).toBe("ok");
  });

  it("a draft now on a locked property, or no longer pending, is STALE; a failed lookup refuses (null)", async () => {
    expect(await draftStillOn(db({ properties: [lockedProp(4)], ai_reply_drafts: [draft(1, { property_id: u(4) })] }).client, "org", u(1, 4), u(4))).toBe("stale");
    expect(await draftStillOn(db({ properties: [plainProp(4)], ai_reply_drafts: [] }).client, "org", u(1, 4), u(4))).toBe("stale");
    expect(await draftStillOn(db({ properties: [plainProp(4)], ai_reply_drafts: [draft(1, { property_id: u(4) })] }, { fail: () => true }).client, "org", u(1, 4), u(4))).toBeNull();
  });

  it("liveStateOf reports the hold's current draft and its property", async () => {
    const states = (await liveStateOf(db({ properties: [flagged(3, t(1)), plainProp(4)], ai_reply_drafts: [draft(1, { property_id: u(4) })] }).client, "org", [u(3)]))!;
    expect(states[0]).toMatchObject({ id: u(3), eligible: true, draftId: null, draftProperty: null }); // the draft now belongs to 4, not 3
  });
});

describe("scale: one light build per request, full steps only for shown runs, checks scoped to shown ids", () => {
  const step = (run: string, seq: number, at: string): Row => ({
    id: `${run}-s${String(seq).padStart(3, "0")}`, run_id: run, org_id: "org", seq, kind: "hold", name: "held", result: "held", detail: { big: "x".repeat(50) }, created_at: at,
  });
  const world = (n: number) => {
    const tables: Record<string, Row[]> = { properties: [], pipeline_runs: [], pipeline_run_steps: [] };
    for (let i = 1; i <= n; i++) {
      tables.properties.push(flagged(i, t(i)));
      tables.pipeline_runs.push(runRow(i, { property_id: u(i), started_at: t(i) }));
      tables.pipeline_run_steps.push(step(u(i, 5), 1, t(i)), step(u(i, 5), 2, t(i + 1)));
    }
    return tables;
  };
  type Log = ReturnType<typeof fakePostgrest>["log"];
  const holdPropertyReads = (log: Log) =>
    log.filter((l) => l.table === "properties" && l.ops.some((o) => o.k === "eq" && "col" in o && o.col === "needs_human_attention"));
  // One keyset read = its first page (no cursor); later pages carry a `gt` on id.
  const unscoped = (log: Log) => holdPropertyReads(log).filter((l) => !l.ops.some((o) => o.k === "in" || o.k === "gt"));
  const inIds = (l: Log[number], col: string) => l.ops.flatMap((o) => (o.k === "in" && o.col === col ? (o.v as string[]) : []));

  it("a list build reads steps with activity columns only (never detail) and in a bounded number of requests", async () => {
    const tables = world(60);
    const { client, log, requests } = db(tables);
    const list = await loadEligibleHolds(client, "org");
    expect(list.ok && list.holds).toHaveLength(60);
    const stepReads = log.filter((l) => l.table === "pipeline_run_steps");
    expect(stepReads.length).toBeGreaterThan(0);
    for (const l of stepReads) expect(l.select).toBe("id, run_id, seq, created_at");
    for (const l of log.filter((x) => x.table === "pipeline_runs")) expect(l.select).not.toContain("detail");
    expect(unscoped(log)).toHaveLength(1);
    expect(requests.get("properties")).toBeLessThanOrEqual(4); // 1 source read (+ its empty last page) + draft org check
  });

  it("the page builds the whole list ONCE; enrichment loads full steps only for first-page runs; the final check is scoped to them", async () => {
    const tables = world(60);
    const { client, log } = db(tables);
    const page = await loadMessagesV2Page(client, "org");
    expect(decodeSnapshot(page.snapshot).entries).toHaveLength(60);
    expect(page.holds).toHaveLength(40);
    expect(unscoped(log)).toHaveLength(1);
    const shown = new Set(page.holds.map((h) => h.id));
    const scopedReads = holdPropertyReads(log).filter((l) => l.ops.some((o) => o.k === "in"));
    expect(scopedReads.length).toBeGreaterThan(0);
    for (const l of scopedReads) for (const id of inIds(l, "id")) expect(shown.has(id)).toBe(true);
    const shownRuns = new Set(page.holds.map((h) => h.run!.id));
    // Full steps are read for every shown run (the feed, loadMessagesV2Data, also reads its own recent runs' steps;
    // the list build itself reads activity columns only, asserted above and in Show older below).
    const fullIds = new Set(log.filter((l) => l.table === "pipeline_run_steps" && l.select === "*").flatMap((l) => inIds(l, "run_id")));
    expect([...shownRuns].every((id) => fullIds.has(id))).toBe(true);
    // Cards render full steps (with detail), in seq order.
    expect(page.holds[0].run!.steps.map((s) => s.seq)).toEqual([1, 2]);
    expect(page.holds[0].run!.steps[0].detail).toEqual({ big: "x".repeat(50) });
  });

  it("Show older and the live re-check never build the whole list: every hold read is scoped to the requested ids", async () => {
    const tables = world(60);
    const ids = [u(3), u(7), u(11)];
    const older = db(tables);
    const slice = (await loadHoldsByIds(older.client, "org", ids))!;
    expect(slice.holds.map((h) => h.id).sort()).toEqual([...ids].sort());
    expect(unscoped(older.log)).toHaveLength(0);
    for (const l of holdPropertyReads(older.log)) for (const id of inIds(l, "id")) expect(ids).toContain(id);
    const full = older.log.filter((l) => l.table === "pipeline_run_steps" && l.select === "*");
    expect(new Set(full.flatMap((l) => inIds(l, "run_id")))).toEqual(new Set(ids.map((id) => tables.pipeline_runs.find((r) => r.property_id === id)!.id)));
    expect(slice.holds.every((h) => h.run!.steps.every((s) => s.detail !== undefined))).toBe(true);

    const live = db(tables);
    const states = (await liveStateOf(live.client, "org", ids))!;
    expect(states.every((s) => s.eligible)).toBe(true);
    expect(unscoped(live.log)).toHaveLength(0);
    expect(live.log.filter((l) => l.table === "pipeline_run_steps").every((l) => l.select === "id, run_id, seq, created_at")).toBe(true);
  });

  it("a scoped build reports no count (null) and still lock-checks every candidate of an in-scope draft", async () => {
    const tables: Record<string, Row[]> = {
      properties: [flagged(1, t(1)), flagged(2, t(2)), lockedProp(9), plainProp(3)],
      // ambiguous (two properties) -> unverified; on a locked property -> hidden, not counted; to hold 2 -> out of scope
      ai_reply_drafts: [
        draft(1, { property_id: u(3), run_id: u(1, 5) }),
        draft(2, { property_id: u(1), run_id: u(2, 5) }),
        draft(3, { property_id: u(2) }),
      ],
      pipeline_runs: [runRow(1, { property_id: u(1) }), runRow(2, { property_id: u(9) })],
    };
    const full = await eligible(tables);
    const scoped = await loadEligibleHolds(db(tables).client, "org", { propertyIds: [u(1)] });
    expect(scoped.ok && scoped.unverified).toBeNull();
    expect(full.unverified).toBe(1);
    expect(scoped.ok && scoped.holds.map((h) => h.id)).toEqual([u(1)]);
    expect(scoped.ok && scoped.holds[0].draft).toBeUndefined(); // draft 2 also resolves to locked 9: never shown
  });

  it("a full-step lookup failure during enrichment fails the page closed (no cards with activity-only steps)", async () => {
    const tables = world(3);
    const list = await eligible(tables);
    const failing = db(tables, { fail: (tb) => tb === "pipeline_run_steps" });
    expect(await enrichPage(failing.client, "org", list.holds)).toBeNull();
  });
});

describe("the test fake refuses forms it does not implement", () => {
  it(".is with a non-null value, .not other than (is, null), and an unregistered RPC all throw", async () => {
    const { client } = fakePostgrest({ t: [] });
    const q = client.from("t") as unknown as { is: (c: string, v: unknown) => unknown; not: (c: string, op: string, v: unknown) => unknown };
    expect(() => q.is("a", true)).toThrow(/unsupported/);
    expect(() => q.not("a", "eq", 1)).toThrow(/unsupported/);
    expect(() => q.not("a", "is", "x")).toThrow(/unsupported/);
    await expect(client.rpc("nope", {})).rejects.toThrow(/not registered/);
  });
});

describe("Astra: an unresolved reference makes a draft unverifiable everywhere (list, paging, re-check, Send/Edit)", () => {
  const review = (n: number, property: string): Row => ({
    id: u(n, 8), org_id: "org", status: "pending", property_id: property, conversation_id: null, source_inbound_message_id: null, disposition: "x", created_at: t(5),
  });
  const cases: Array<[string, Row, Row[]]> = [
    ["a run_id with no row", draft(1, { property_id: u(3), run_id: u(77, 5) }), []],
    ["a run_id on ANOTHER org's run", draft(1, { property_id: u(3), run_id: u(77, 5) }), [runRow(77, { org_id: "other", property_id: u(3) })]],
    ["an inbound_message_id with no row", draft(1, { property_id: u(3), inbound_message_id: u(77, 7) }), []],
  ];
  for (const [name, d, runs] of cases) {
    it(`${name}: hidden + counted, missing on paging, not eligible on re-check, Send refused`, async () => {
      const tables: Record<string, Row[]> = { properties: [plainProp(3)], ai_reply_drafts: [d], pipeline_runs: runs };
      const list = await eligible(tables);
      expect(list.holds).toHaveLength(0);
      expect(list.unverified).toBe(1);
      expect((await loadHoldsByIds(db(tables).client, "org", [u(3)]))!.missing).toEqual([u(3)]);
      expect((await liveStateOf(db(tables).client, "org", [u(3)]))![0].eligible).toBe(false);
      expect(await draftStillOn(db(tables).client, "org", u(1, 4), u(3))).toBe("stale");
    });
  }

  it("a pending review or decision on an absent or another org's property: hidden + counted; never eligible", async () => {
    for (const props of [[], [{ id: u(5), org_id: "other", needs_human_attention: false, is_dnc_locked: false }]] as Row[][]) {
      const tables: Record<string, Row[]> = { properties: props, ai_disposition_reviews: [review(1, u(5))], jev_lead_decisions: [decision(2, u(5), t(3))] };
      const list = await eligible(tables);
      expect(list.holds).toHaveLength(0);
      expect(list.unverified).toBe(2);
      expect((await loadHoldsByIds(db(tables).client, "org", [u(5)]))!.missing).toEqual([u(5)]);
      expect((await liveStateOf(db(tables).client, "org", [u(5)]))![0].eligible).toBe(false);
    }
  });

  it("a property whose lock state is unreadable (null) is unverifiable, and Send refuses", async () => {
    const tables: Record<string, Row[]> = {
      properties: [{ id: u(6), org_id: "org", needs_human_attention: false, is_dnc_locked: null }],
      ai_reply_drafts: [draft(1, { property_id: u(6), inbound_message_id: u(1, 7) })],
      messages: [message(1, { property_id: u(6) })],
    };
    expect((await eligible(tables)).unverified).toBe(1);
    expect(await draftStillOn(db(tables).client, "org", u(1, 4), u(6))).toBe("stale");
  });
});

describe("Astra: revalidation and Show older cost follows the requested ids, not the backlog", () => {
  const world = (n: number) => {
    const tables: Record<string, Row[]> = { properties: [], pipeline_runs: [], pipeline_run_steps: [], ai_reply_drafts: [], messages: [] };
    for (let i = 1; i <= n; i++) {
      tables.properties.push(flagged(i, t(i)));
      tables.pipeline_runs.push(runRow(i, { property_id: u(i), started_at: t(i) }));
      tables.pipeline_run_steps.push({ id: `${u(i, 5)}-s1`, run_id: u(i, 5), org_id: "org", seq: 1, kind: "hold", name: "held", result: "held", detail: {}, created_at: t(i) });
      tables.ai_reply_drafts.push(draft(i, { property_id: u(i), inbound_message_id: u(i, 6), created_at: t(i) }));
      tables.messages.push(message(i, { id: u(i, 6), property_id: u(i) }));
    }
    return tables;
  };
  const tableRequests = (requests: Map<string, number>) => [...requests.values()].reduce((a, b) => a + b, 0);

  it("one-card re-check and a one-card Show older: the same request count at 150 and at 10,000 holds", async () => {
    const counts: Record<string, number[]> = { live: [], older: [] };
    for (const n of [150, 10_000]) {
      const tables = world(n);
      const live = db(tables);
      expect((await liveStateOf(live.client, "org", [u(7)]))![0].eligible).toBe(true);
      counts.live.push(tableRequests(live.requests));
      const older = db(tables);
      expect((await loadHoldsByIds(older.client, "org", [u(7)]))!.holds).toHaveLength(1);
      counts.older.push(tableRequests(older.requests));
    }
    expect(counts.live[0]).toBe(counts.live[1]);
    expect(counts.older[0]).toBe(counts.older[1]);
    expect(counts.live[1]).toBeLessThanOrEqual(40);
    expect(counts.older[1]).toBeLessThanOrEqual(80);
  });

  it("no scoped read touches a property, draft, run or step outside the requested ids' links", async () => {
    const tables = world(150);
    const { client, log } = db(tables);
    await liveStateOf(client, "org", [u(7), u(9)]);
    const ok = new Set([u(7), u(9), u(7, 4), u(9, 4), u(7, 5), u(9, 5), u(7, 6), u(9, 6)]);
    for (const l of log) for (const o of l.ops) if (o.k === "in") for (const v of o.v as string[]) expect(ok.has(v)).toBe(true);
  });
});

describe("Sol: a scoped re-check decides shared-run ownership exactly as the whole list", () => {
  // Holds A (u1) and B (u2) both have a pending decision in conversation C; a property-less run R in C is linked to
  // both. R goes to the hold with the newer uncontested activity.
  const tables = (bNewer: boolean): Record<string, Row[]> => ({
    properties: [plainProp(1), plainProp(2)],
    jev_lead_decisions: [
      decision(1, u(1), t(10), { conversation_id: u(50, 2), source_inbound_message_id: u(1, 3) }),
      decision(2, u(2), bNewer ? t(30) : t(5), { conversation_id: u(50, 2), source_inbound_message_id: u(2, 3) }),
    ],
    pipeline_runs: [runRow(9, { property_id: null, conversation_id: u(50, 2), started_at: t(40), reason: "shared" })],
  });

  it("after the snapshot B gains newer activity: the whole list moves R to B, and the one-card re-check of A agrees", async () => {
    const before = await eligible(tables(false));
    expect(before.holds.find((h) => h.id === u(1))!.run?.id).toBe(u(9, 5));
    const now = tables(true);
    const full = await eligible(now);
    expect(full.holds.find((h) => h.id === u(2))!.run?.id).toBe(u(9, 5));
    const [a] = (await liveStateOf(db(now).client, "org", [u(1)]))!;
    expect(a.runId).toBe(full.holds.find((h) => h.id === u(1))!.run?.id ?? null);
    expect(a.runId).not.toBe(u(9, 5)); // the card's pinned run -> the column marks it Updated (actions paused)
    const still = (await recheckOpen(db(now).client, "org", before.holds.filter((h) => h.id === u(1))))!;
    expect(still.changed.has(u(1))).toBe(true);
  });

  it("a competitor lookup failure fails the scoped re-check closed", async () => {
    const now = tables(true);
    const failing = db(now, { fail: (tb, _n, ops) => tb === "jev_lead_decisions" && ops.some((o) => o.k === "in" && o.col === "conversation_id") });
    expect(await liveStateOf(failing.client, "org", [u(1)])).toBeNull();
  });

  it("scoped reads select only activity columns for runs and steps; whole rows only for the runs a page shows", async () => {
    const now = tables(true);
    const live = db(now);
    await liveStateOf(live.client, "org", [u(1)]);
    for (const l of live.log.filter((x) => x.table === "pipeline_runs")) expect(["id", "id, property_id, inbound_message_id, conversation_id, started_at, reason"]).toContain(l.select);
    for (const l of live.log.filter((x) => x.table === "pipeline_run_steps")) expect(l.select).toBe("id, run_id, seq, created_at");
    const older = db(now);
    const slice = (await loadHoldsByIds(older.client, "org", [u(2)]))!;
    const whole = older.log.filter((x) => x.table === "pipeline_runs" && x.select === "*");
    expect(new Set(whole.flatMap((l) => l.ops.flatMap((o) => (o.k === "in" ? (o.v as string[]) : []))))).toEqual(new Set([u(9, 5)]));
    expect(slice.holds[0].run).toMatchObject({ id: u(9, 5), status: "held", inbound_preview: "x" });
  });
});
