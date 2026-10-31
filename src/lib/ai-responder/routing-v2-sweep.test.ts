import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { reportError } from "@/lib/errors/report";
import { sweepUnstampedV2Inbounds } from "./dispatch";

/**
 * The lease-death sweep's error paths (reviews of 72229239848d B2 and of ffbd57201137 N-1; A-2
 * F3). Candidates come from SQL (routing_v2_sweep_candidates, DB clock); holds go through the one
 * fenced writer (routing_v2_write_hold, safety); the mark is written server-side
 * (routing_v2_mark_inbound_swept). An unreadable v2 state, a thrown read or a failed hold write
 * must never mark the text (it waits for the next pass) and is always reported; a text that is
 * readable on a later pass is held then.
 */
type Result = { data: unknown; error: { message: string; code?: string } | null };
type Step = Result | "throw";
function fake(queues: Record<string, Step[]>, rpcs: Record<string, Step[]>) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const take = (q: Step[] | undefined, fallback: Result): Result => {
    if (!q || q.length === 0) return fallback;
    const step = q.length > 1 ? q.shift()! : q[0]!;
    if (step === "throw") throw new Error("read threw");
    return step;
  };
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "lt", "gt", "not", "is", "order", "limit", "in", "neq", "insert", "update"]) chain[m] = () => chain;
    chain.maybeSingle = async () => take(queues[table], { data: null, error: null });
    chain.then = (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) => {
      try { return res(take(queues[table], { data: [], error: null })); } catch (e) { return rej ? rej(e) : Promise.reject(e); }
    };
    return chain;
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    return take(rpcs[name], { data: null, error: null });
  };
  return { db: { from, rpc } as never, rpcCalls };
}

const PROPERTY = "11111111-1111-4111-8111-111111111111"; // eligibility needs a uuid
const CANDIDATE = { id: "m1", org_id: "o1", property_id: PROPERTY, conversation_id: null, why: "unstamped" };
const LIVE_FLAGS: Result = { data: { routing_v2_flags: { questions_live: true, replies: true, drips: true, canary_percent: 100 } }, error: null };
const JEV_AUTO: Result = { data: { classifier_provider: "jev", classifier_mode: "automatic" }, error: null };
const NINE: Result = { data: { classifier_engine: "nine_questions" }, error: null };
const baseRpcs = (): Record<string, Step[]> => ({
  routing_v2_sweep_candidates: [{ data: [CANDIDATE], error: null }],
  routing_v2_write_hold: [{ data: "held", error: null }],
  routing_v2_mark_inbound_swept: [{ data: true, error: null }],
});
const marks = (calls: Array<{ name: string; args: Record<string, unknown> }>) => calls.filter((c) => c.name === "routing_v2_mark_inbound_swept");
const holds = (calls: Array<{ name: string; args: Record<string, unknown> }>) => calls.filter((c) => c.name === "routing_v2_write_hold");
const sweepReported = () => vi.mocked(reportError).mock.calls.some(([, ctx]) => {
  const surface = (ctx as { tags?: { surface?: string } } | undefined)?.tags?.surface;
  return surface === "routing_v2_unstamped_sweep" || surface === "routing_v2_write_hold";
});

beforeEach(() => vi.mocked(reportError).mockClear());

describe("lease-death sweep: error paths never mark the text, and are reported", () => {
  it("config read error: not marked, nobody held, reported", async () => {
    // reads on ai_responder_configs, in order: flags, config, engine
    const { db, rpcCalls } = fake({ ai_responder_configs: [LIVE_FLAGS, { data: null, error: { message: "connection reset" } }] }, baseRpcs());
    expect(await sweepUnstampedV2Inbounds(db)).toBe(0);
    expect(marks(rpcCalls)).toEqual([]);
    expect(holds(rpcCalls)).toEqual([]);
    expect(sweepReported()).toBe(true);
  });

  it("engine unreadable: not marked, nobody held, reported", async () => {
    const { db, rpcCalls } = fake({ ai_responder_configs: [LIVE_FLAGS, JEV_AUTO, { data: null, error: null }] }, baseRpcs());
    expect(await sweepUnstampedV2Inbounds(db)).toBe(0);
    expect(marks(rpcCalls)).toEqual([]);
    expect(holds(rpcCalls)).toEqual([]);
    expect(sweepReported()).toBe(true);
  });

  it("a read that throws: not marked, nobody held, reported", async () => {
    const { db, rpcCalls } = fake({ ai_responder_configs: [LIVE_FLAGS, "throw"] }, baseRpcs());
    expect(await sweepUnstampedV2Inbounds(db)).toBe(0);
    expect(marks(rpcCalls)).toEqual([]);
    expect(holds(rpcCalls)).toEqual([]);
    expect(sweepReported()).toBe(true);
  });

  it("the hold write fails: the text is NOT marked (waits for the next pass), reported", async () => {
    const rpcs = baseRpcs();
    rpcs.routing_v2_write_hold = [{ data: null, error: { message: "update failed" } }];
    const { db, rpcCalls } = fake({ ai_responder_configs: [LIVE_FLAGS, JEV_AUTO, NINE] }, rpcs);
    expect(await sweepUnstampedV2Inbounds(db)).toBe(0);
    expect(holds(rpcCalls).length).toBeGreaterThan(0);
    expect(marks(rpcCalls)).toEqual([]);
    expect(sweepReported()).toBe(true);
  });

  it("error on pass 1, readable on pass 2: held on pass 2 (safety hold about that text), and only then marked held", async () => {
    const pass1 = fake({ ai_responder_configs: [LIVE_FLAGS, { data: null, error: { message: "connection reset" } }] }, baseRpcs());
    expect(await sweepUnstampedV2Inbounds(pass1.db)).toBe(0);
    expect(marks(pass1.rpcCalls)).toEqual([]);
    expect(sweepReported()).toBe(true);
    const pass2 = fake({
      ai_responder_configs: [LIVE_FLAGS, JEV_AUTO, NINE, LIVE_FLAGS],
      properties: [{ data: { decision_context_revision: 3 }, error: null }],
    }, baseRpcs());
    expect(await sweepUnstampedV2Inbounds(pass2.db)).toBe(1);
    expect(holds(pass2.rpcCalls).map((c) => c.args)).toEqual([{ p_property_id: PROPERTY, p_inbound_message_id: "m1", p_reason: "nine_needs_person", p_kind: "safety" }]);
    expect(marks(pass2.rpcCalls).map((c) => c.args)).toEqual([{ p_message_id: "m1", p_result: "held" }]);
  });

  it("flags truly off (readable, questions_live false): marked not_v2, nobody held", async () => {
    const { db, rpcCalls } = fake({ ai_responder_configs: [{ data: { routing_v2_flags: { questions_live: false } }, error: null }] }, baseRpcs());
    expect(await sweepUnstampedV2Inbounds(db)).toBe(0);
    expect(holds(rpcCalls)).toEqual([]);
    expect(marks(rpcCalls).map((c) => c.args)).toEqual([{ p_message_id: "m1", p_result: "not_v2" }]);
  });

  it("the candidates and their age come from SQL (DB clock): the lease is passed in seconds", async () => {
    const { db, rpcCalls } = fake({ ai_responder_configs: [{ data: { routing_v2_flags: { questions_live: false } }, error: null }] }, baseRpcs());
    await sweepUnstampedV2Inbounds(db);
    expect(rpcCalls.find((c) => c.name === "routing_v2_sweep_candidates")!.args).toEqual({ p_lease_seconds: 300, p_limit: 50 });
  });
});
