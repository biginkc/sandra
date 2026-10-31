import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { reportError } from "@/lib/errors/report";
import { sweepUnstampedV2Inbounds } from "./dispatch";

/**
 * The unstamped-inbound (lease-death) sweep's error paths (reviews of 72229239848d B2 and of
 * ffbd57201137 N-1). An unreadable v2 state, a thrown read or a failed hold write must never mark
 * the text (it waits for the next pass) and is always reported; a text that is readable on a
 * later pass is held then.
 */
type Result = { data: unknown; error: { message: string; code?: string } | null };
type Step = Result | "throw";
/** Per-table results, consumed in call order (the last one repeats). */
function fake(queues: Record<string, Step[]>) {
  const writes: Array<{ table: string; value: unknown }> = [];
  const next = (table: string): Result => {
    const q = queues[table];
    if (!q || q.length === 0) return { data: null, error: null };
    const step = q.length > 1 ? q.shift()! : q[0]!;
    if (step === "throw") throw new Error(`${table} read threw`);
    return step;
  };
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "lt", "gt", "not", "is", "order", "limit", "in", "neq", "insert"]) chain[m] = () => chain;
    chain.update = (value: unknown) => { writes.push({ table, value }); return chain; };
    chain.maybeSingle = async () => next(table);
    chain.then = (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) => {
      try { return res(queues[table] ? next(table) : { data: [], error: null }); } catch (e) { return rej ? rej(e) : Promise.reject(e); }
    };
    return chain;
  };
  return { db: { from, rpc: async () => ({ data: null, error: null }) } as never, writes };
}

const PROPERTY = "11111111-1111-4111-8111-111111111111"; // eligibility needs a uuid
const deadText = { id: "m1", org_id: "o1", property_id: PROPERTY, conversation_id: null, metadata: {} };
const LIVE_FLAGS: Result = { data: { routing_v2_flags: { questions_live: true, replies: true, drips: true, canary_percent: 100 } }, error: null };
const JEV_AUTO: Result = { data: { classifier_provider: "jev", classifier_mode: "automatic" }, error: null };
const NINE: Result = { data: { classifier_engine: "nine_questions" }, error: null };
const base = () => ({
  messages: [{ data: [deadText], error: null } as Step],
  ai_response_claims: [{ data: [], error: null } as Step],
  routing_v2_live_decisions: [{ data: [], error: null } as Step],
});
const messageMarks = (writes: Array<{ table: string; value: unknown }>) => writes.filter((w) => w.table === "messages");
const sweepReported = () => vi.mocked(reportError).mock.calls.some(([, ctx]) => {
  const surface = (ctx as { tags?: { surface?: string } } | undefined)?.tags?.surface;
  return surface === "routing_v2_unstamped_sweep" || surface === "ai_responder_mark_attention";
});

beforeEach(() => vi.mocked(reportError).mockClear());

describe("lease-death sweep: error paths never mark the text, and are reported", () => {
  it("config read error: not marked, nobody held, reported", async () => {
    // reads on ai_responder_configs, in order: flags, config, engine
    const { db, writes } = fake({ ...base(), ai_responder_configs: [LIVE_FLAGS, { data: null, error: { message: "connection reset" } }] });
    expect(await sweepUnstampedV2Inbounds(db, Date.now())).toBe(0);
    expect(writes).toEqual([]);
    expect(sweepReported()).toBe(true);
  });

  it("engine unreadable: not marked, nobody held, reported", async () => {
    const { db, writes } = fake({ ...base(), ai_responder_configs: [LIVE_FLAGS, JEV_AUTO, { data: null, error: null }] });
    expect(await sweepUnstampedV2Inbounds(db, Date.now())).toBe(0);
    expect(writes).toEqual([]);
    expect(sweepReported()).toBe(true);
  });

  it("a read that throws: not marked, nobody held, reported", async () => {
    const { db, writes } = fake({ ...base(), ai_responder_configs: [LIVE_FLAGS, "throw"] });
    expect(await sweepUnstampedV2Inbounds(db, Date.now())).toBe(0);
    expect(writes).toEqual([]);
    expect(sweepReported()).toBe(true);
  });

  it("the hold write fails: the text is NOT marked held (waits for the next pass), reported", async () => {
    const { db, writes } = fake({
      ...base(),
      ai_responder_configs: [LIVE_FLAGS, JEV_AUTO, NINE],
      properties: [{ data: null, error: { message: "update failed" } }],
    });
    expect(await sweepUnstampedV2Inbounds(db, Date.now())).toBe(0);
    expect(messageMarks(writes)).toEqual([]);
    expect(sweepReported()).toBe(true);
  });

  it("error on pass 1, readable on pass 2: held on pass 2 (and only then marked held)", async () => {
    const pass1 = fake({ ...base(), ai_responder_configs: [LIVE_FLAGS, { data: null, error: { message: "connection reset" } }] });
    expect(await sweepUnstampedV2Inbounds(pass1.db, Date.now())).toBe(0);
    expect(pass1.writes).toEqual([]);
    expect(sweepReported()).toBe(true);
    // Pass 2: the text was not marked, so it is picked again; every read works.
    const pass2 = fake({
      ...base(),
      ai_responder_configs: [LIVE_FLAGS, JEV_AUTO, NINE, LIVE_FLAGS],
      properties: [{ data: { id: PROPERTY }, error: null }, { data: { decision_context_revision: 3 }, error: null }],
    });
    expect(await sweepUnstampedV2Inbounds(pass2.db, Date.now())).toBe(1);
    expect(pass2.writes.filter((w) => w.table === "properties")).toHaveLength(1);
    const marks = messageMarks(pass2.writes);
    expect(marks).toHaveLength(1);
    expect(JSON.stringify(marks[0]!.value)).toContain('"result":"held"');
  });

  it("flags truly off (readable, questions_live false): marked not_v2, nobody held", async () => {
    const { db, writes } = fake({ ...base(), ai_responder_configs: [{ data: { routing_v2_flags: { questions_live: false } }, error: null }] });
    expect(await sweepUnstampedV2Inbounds(db, Date.now())).toBe(0);
    expect(writes.map((w) => w.table)).toEqual(["messages"]);
    expect(JSON.stringify(writes[0]!.value)).toContain("not_v2");
  });
});
