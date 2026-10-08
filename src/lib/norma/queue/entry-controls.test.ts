import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/types";

import { controlNormaQueueEntriesCore } from "./entry-controls";

// RED: testable core behind the pause / resume / cancel server actions (single entry from the lead chip, many from /norma/queue).
// Ruling (derivable from plan + contract s.7): ANY active member of the entry's org may pause/resume/cancel, not only the requester.
// Pattern as queue-calls.ts: the session client (RLS) proves the caller can read the entry; the service-role client calls
// fn_norma_queue_pause / _resume / _cancel (p_entry_id, p_actor). PROPOSED shape: controlNormaQueueEntriesCore(action, entryIds, deps)
// -> { ok:true, results:[{ entryId, ok, code? }] } | { ok:false, code }.
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const REQUESTER = "44444444-4444-4444-8444-444444444444";
const OTHER_MEMBER = "55555555-5555-4555-8555-555555555555";

function setup(opts: { userId?: string | null; readable?: { id: string; org_id: string; requested_by: string }[]; rpc?: (name: string, args: Record<string, unknown>) => unknown } = {}) {
  const readable = opts.readable ?? [{ id: uuid(1), org_id: "o1", requested_by: REQUESTER }];
  const session = {
    from: vi.fn(() => {
      let ids: string[] = [];
      const api: Record<string, unknown> = {
        select: () => api,
        in: (_col: string, vals: string[]) => { ids = vals; return api; },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: readable.filter((e) => ids.includes(e.id)), error: null }),
      };
      return api;
    }),
  } as unknown as SupabaseClient<Database>;
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const admin = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return { data: opts.rpc ? opts.rpc(name, args) : ({ fn_norma_queue_pause: "paused", fn_norma_queue_resume: "resumed", fn_norma_queue_cancel: "cancelled" } as Record<string, string>)[name], error: null };
    }),
  } as unknown as SupabaseClient<Database>;
  const run = (action: "pause" | "resume" | "cancel", ids: string[]) =>
    controlNormaQueueEntriesCore(action, ids, { getUserId: async () => (opts.userId === undefined ? OTHER_MEMBER : opts.userId), sessionClient: session, adminClient: admin });
  return { run, session, admin, rpcCalls };
}

describe("controlNormaQueueEntriesCore", () => {
  it("unauthenticated is refused before any read or RPC", async () => {
    const t = setup({ userId: null });
    expect(await t.run("pause", [uuid(1)])).toEqual({ ok: false, code: "unauthenticated" });
    expect(t.session.from).not.toHaveBeenCalled();
    expect(t.admin.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["pause", "fn_norma_queue_pause"],
    ["resume", "fn_norma_queue_resume"],
    ["cancel", "fn_norma_queue_cancel"],
  ] as const)("%s by an active org member who is NOT the requester calls %s as that member", async (action, fn) => {
    const t = setup(); // current user = OTHER_MEMBER, entry requested by REQUESTER
    const out = await t.run(action, [uuid(1)]);
    expect(out).toMatchObject({ ok: true, results: [{ entryId: uuid(1), ok: true }] });
    expect(t.rpcCalls).toEqual([{ name: fn, args: expect.objectContaining({ p_entry_id: uuid(1), p_actor: OTHER_MEMBER }) }]);
  });

  it("the requester may of course act too", async () => {
    const t = setup({ userId: REQUESTER });
    expect(await t.run("cancel", [uuid(1)])).toMatchObject({ ok: true, results: [{ ok: true }] });
  });

  it("an entry the session cannot read (another org, RLS) is not_found and never reaches the RPC", async () => {
    const t = setup({ readable: [] });
    const out = await t.run("pause", [uuid(1)]);
    expect(out).toMatchObject({ ok: true, results: [{ entryId: uuid(1), ok: false, code: "not_found" }] });
    expect(t.admin.rpc).not.toHaveBeenCalled();
  });

  it("per-entry refusals are reported against their entry; the others still apply (bulk Resume on a non-paused row)", async () => {
    const t = setup({
      readable: [{ id: uuid(1), org_id: "o1", requested_by: REQUESTER }, { id: uuid(2), org_id: "o1", requested_by: REQUESTER }],
      rpc: (_name, args) => (args.p_entry_id === uuid(2) ? "refused:not_paused" : "resumed"),
    });
    const out = await t.run("resume", [uuid(1), uuid(2)]);
    if (!out.ok) throw new Error("unreachable");
    expect(out.results).toEqual([
      expect.objectContaining({ entryId: uuid(1), ok: true }),
      expect.objectContaining({ entryId: uuid(2), ok: false, code: "refused" }),
    ]);
  });

  it("malformed and duplicate ids: no database call for malformed, one RPC per distinct readable entry", async () => {
    const t = setup();
    const out = await t.run("pause", ["nope", uuid(1), uuid(1)]);
    if (!out.ok) throw new Error("unreachable");
    expect(out.results.find((r) => r.entryId === "nope")).toMatchObject({ ok: false, code: "not_found" });
    expect(t.rpcCalls).toHaveLength(1);
  });

  it("a thrown RPC is contained: that entry is an error, the call never throws", async () => {
    const t = setup({ rpc: () => { throw new Error("network"); } });
    const out = await t.run("cancel", [uuid(1)]);
    expect(out).toMatchObject({ ok: true, results: [{ ok: false, code: "error" }] });
  });
});
