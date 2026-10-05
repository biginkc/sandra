import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => { throw new Error("admin client must be injected in tests"); } }));
vi.mock("@/lib/my-leads/flags", () => ({ getMyLeadsFlag: vi.fn(async () => false) }));
vi.mock("@/lib/my-leads/schema-ready", () => ({ schemaReady: vi.fn(async () => false) }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { compLead, drainCompQueue } from "./index";
import { createFixtureProvider } from "./providers/fixture";
import type { CompProvider } from "./types";

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";

type Row = Record<string, unknown>;
/** A tiny in-memory stand-in for the admin client: the handful of query shapes index.ts uses. */
function fakeAdmin(opts: {
  property?: Row | null;
  enqueue?: Row;
  comps?: Row[];
  claim?: Row[];
  rpcLog?: { fn: string; args: Row }[];
  inserted?: Row[];
}) {
  const rpcLog = opts.rpcLog ?? [];
  const comps = opts.comps ?? [];
  const inserted = opts.inserted ?? [];
  const query = (table: string) => {
    const state = { filters: [] as [string, unknown][], payload: null as Row | null };
    const result = () => {
      if (table === "properties") return opts.property === undefined ? { id: PROPERTY, org_id: ORG, address: "1 A St", city: "KC", state: "MO", zip: "64100", is_training: false, deleted_at: null } : opts.property;
      if (table === "lead_comps") return state.payload ? { id: `comp-${inserted.length}` } : (comps[0] ?? null);
      if (table === "org_comp_settings") return null;
      if (table === "comp_fetch_requests") return { id: "req-open" };
      return null;
    };
    const chain: Row = {
      select: () => chain, eq: (k: string, v: unknown) => { state.filters.push([k, v]); return chain; }, in: () => chain,
      order: () => chain, limit: () => chain,
      insert: (payload: Row) => { state.payload = payload; inserted.push(payload); return chain; },
      maybeSingle: async () => ({ data: result(), error: null }),
      single: async () => ({ data: result(), error: null }),
    };
    return chain;
  };
  return {
    rpcLog,
    inserted,
    from: query,
    rpc: async (fn: string, args: Row) => {
      rpcLog.push({ fn, args });
      if (fn === "fn_enqueue_comp_fetch") return { data: opts.enqueue ?? { status: "disabled" }, error: null };
      if (fn === "fn_claim_comp_fetches") return { data: opts.claim ?? [], error: null };
      if (fn === "fn_finish_comp_fetch") return { data: null, error: null };
      return { data: null, error: { message: "unknown rpc" } };
    },
  };
}

const on = { flagEnabled: async () => true, schemaReady: async () => true };
const countingProvider = (): CompProvider & { calls: number } => {
  const inner = createFixtureProvider();
  const p = { name: inner.name, callsPerComp: 0, calls: 0, async fetch(s: Parameters<CompProvider["fetch"]>[0], sig: AbortSignal) { p.calls += 1; return inner.fetch(s, sig); } };
  return p;
};

describe("compLead", () => {
  it("flag off → disabled before any RPC (inert on main before the flag is set)", async () => {
    const admin = fakeAdmin({});
    const r = await compLead(PROPERTY, { deps: { admin, provider: countingProvider(), flagEnabled: async () => false, schemaReady: async () => true } });
    expect(r).toEqual({ status: "disabled" });
    expect(admin.rpcLog).toHaveLength(0);
  });
  it("schema not ready → disabled before any RPC", async () => {
    const admin = fakeAdmin({});
    expect(await compLead(PROPERTY, { deps: { admin, provider: countingProvider(), flagEnabled: async () => true, schemaReady: async () => false } })).toEqual({ status: "disabled" });
    expect(admin.rpcLog).toHaveLength(0);
  });
  it("cap 0: enqueue answers disabled → no provider call", async () => {
    const provider = countingProvider();
    const admin = fakeAdmin({ enqueue: { status: "disabled" } });
    expect(await compLead(PROPERTY, { inline: true, deps: { admin, provider, ...on } })).toEqual({ status: "disabled" });
    expect(provider.calls).toBe(0);
  });
  it("capped → capped, no provider call", async () => {
    const provider = countingProvider();
    expect(await compLead(PROPERTY, { inline: true, deps: { admin: fakeAdmin({ enqueue: { status: "capped" } }), provider, ...on } })).toEqual({ status: "capped" });
    expect(provider.calls).toBe(0);
  });
  it("training lead refused before the RPC", async () => {
    const admin = fakeAdmin({ property: { id: PROPERTY, org_id: ORG, address: "1 A", state: "MO", is_training: true, deleted_at: null } });
    expect(await compLead(PROPERTY, { deps: { admin, provider: countingProvider(), ...on } })).toEqual({ status: "unavailable", reason: "training_lead" });
    expect(admin.rpcLog).toHaveLength(0);
  });
  it("missing address → unavailable", async () => {
    const admin = fakeAdmin({ property: { id: PROPERTY, org_id: ORG, address: "", state: "MO", is_training: false, deleted_at: null } });
    expect(await compLead(PROPERTY, { deps: { admin, provider: countingProvider(), ...on } })).toEqual({ status: "unavailable", reason: "missing_address" });
  });
  it("fresh cache short-circuits with zero provider calls", async () => {
    const provider = countingProvider();
    const admin = fakeAdmin({ enqueue: { status: "fresh" }, comps: [{ id: "comp-fresh" }] });
    expect(await compLead(PROPERTY, { inline: true, deps: { admin, provider, ...on } })).toEqual({ status: "ready", compId: "comp-fresh", cached: true });
    expect(provider.calls).toBe(0);
  });
  it("queued without inline → pending", async () => {
    expect(await compLead(PROPERTY, { deps: { admin: fakeAdmin({ enqueue: { status: "queued", requestId: "r1" } }), provider: countingProvider(), ...on } })).toEqual({ status: "pending", requestId: "r1" });
  });
  it("queued + inline → claims, stores a row with arv_estimate null, trues up the ledger", async () => {
    const provider = countingProvider();
    const admin = fakeAdmin({ enqueue: { status: "queued", requestId: "r1" }, claim: [{ id: "r1", org_id: ORG, property_id: PROPERTY, trigger: "manual", reserved_calls: 3 }] });
    const r = await compLead(PROPERTY, { inline: true, requestedBy: "u1", deps: { admin, provider, ...on } });
    expect(r.status).toBe("ready");
    expect(provider.calls).toBe(1);
    expect(admin.inserted[0]).toMatchObject({ provider: "fixture", arv_estimate: null, arv_method: "none", org_id: ORG, property_id: PROPERTY, request_id: "r1" });
    const finish = admin.rpcLog.find((c) => c.fn === "fn_finish_comp_fetch");
    expect(finish?.args).toMatchObject({ p_request_id: "r1", p_status: "ok", p_billed_calls: 0 });
    expect(admin.rpcLog.find((c) => c.fn === "fn_enqueue_comp_fetch")?.args).toMatchObject({ p_trigger: "manual", p_requested_by: "u1" });
  });
});

describe("enqueue freshness + inline claim + org gate", () => {
  it("backoff → error/BACKOFF; fresh+noMatch → no_match; neither claims or calls the provider", async () => {
    const provider = countingProvider();
    const backoff = fakeAdmin({ enqueue: { status: "backoff" } });
    expect(await compLead(PROPERTY, { inline: true, deps: { admin: backoff, provider, ...on } })).toEqual({ status: "error", code: "BACKOFF" });
    const noMatch = fakeAdmin({ enqueue: { status: "fresh", noMatch: true } });
    expect(await compLead(PROPERTY, { inline: true, deps: { admin: noMatch, provider, ...on } })).toEqual({ status: "no_match" });
    expect(provider.calls).toBe(0);
    expect(backoff.rpcLog.some((c) => c.fn === "fn_claim_comp_fetches")).toBe(false);
    expect(noMatch.rpcLog.some((c) => c.fn === "fn_claim_comp_fetches")).toBe(false);
  });
  it("inline claims only its own request id and never touches another org's claimed row", async () => {
    const provider = countingProvider();
    const admin = fakeAdmin({ enqueue: { status: "queued", requestId: "r1" }, claim: [{ id: "r1", org_id: ORG, property_id: PROPERTY, trigger: "manual", reserved_calls: 3 }] });
    await compLead(PROPERTY, { inline: true, deps: { admin, provider, ...on } });
    expect(admin.rpcLog.find((c) => c.fn === "fn_claim_comp_fetches")?.args).toEqual({ p_limit: 1, p_request_id: "r1" });
    // Non-inline drains never pass a request id.
    const cron = fakeAdmin({ claim: [] });
    await drainCompQueue(3, { admin: cron, provider, ...on });
    expect(cron.rpcLog.find((c) => c.fn === "fn_claim_comp_fetches")?.args).toEqual({ p_limit: 3 });
  });
  it("drain cancels rows for an org whose flag is off, with no provider call; allowed orgs still run", async () => {
    const provider = countingProvider();
    const OFF = "99999999-9999-4999-8999-999999999999";
    const admin = fakeAdmin({ claim: [
      { id: "rOff", org_id: OFF, property_id: PROPERTY, trigger: "top_ten", reserved_calls: 3 },
      { id: "rOn", org_id: ORG, property_id: PROPERTY, trigger: "top_ten", reserved_calls: 3 },
    ] });
    const r = await drainCompQueue(3, { admin, provider, ...on, orgAllowed: async (o) => o === ORG });
    expect(r.outcomes.find((o) => o.requestId === "rOff")?.status).toBe("cancelled");
    expect(r.outcomes.find((o) => o.requestId === "rOn")?.status).toBe("ok");
    expect(provider.calls).toBe(1);
    const cancelled = admin.rpcLog.filter((c) => c.fn === "fn_finish_comp_fetch").find((c) => c.args.p_request_id === "rOff");
    expect(cancelled?.args).toMatchObject({ p_status: "cancelled", p_billed_calls: 0 });
  });
});

describe("drainCompQueue", () => {
  it("no provider configured → requests finish as error/NO_PROVIDER", async () => {
    const admin = fakeAdmin({ claim: [{ id: "r1", org_id: ORG, property_id: PROPERTY, trigger: "top_ten", reserved_calls: 3 }] });
    const r = await drainCompQueue(3, { admin, provider: null, ...on });
    expect(r).toMatchObject({ claimed: 1, ok: 0, failed: 1 });
    expect(admin.rpcLog.find((c) => c.fn === "fn_finish_comp_fetch")?.args).toMatchObject({ p_status: "error", p_error_code: "NO_PROVIDER" });
  });
  it("provider NOT_FOUND → no_match; AUTH → error reported once", async () => {
    const { CompProviderError } = await import("./types");
    const notFound: CompProvider = { name: "attom", callsPerComp: 2, async fetch() { throw new CompProviderError("NOT_FOUND", 1); } };
    const admin = fakeAdmin({ claim: [{ id: "r1", org_id: ORG, property_id: PROPERTY, trigger: "manual", reserved_calls: 3 }] });
    await drainCompQueue(1, { admin, provider: notFound, ...on });
    expect(admin.rpcLog.find((c) => c.fn === "fn_finish_comp_fetch")?.args).toMatchObject({ p_status: "no_match", p_billed_calls: 1 });

    const { reportError } = await import("@/lib/errors/report");
    const auth: CompProvider = { name: "attom", callsPerComp: 2, async fetch() { throw new CompProviderError("AUTH", 1); } };
    const admin2 = fakeAdmin({ claim: [
      { id: "r1", org_id: ORG, property_id: PROPERTY, trigger: "manual", reserved_calls: 3 },
      { id: "r2", org_id: ORG, property_id: PROPERTY, trigger: "manual", reserved_calls: 3 },
    ] });
    const r = await drainCompQueue(2, { admin: admin2, provider: auth, ...on });
    expect(r.failed).toBe(2);
    expect(vi.mocked(reportError)).toHaveBeenCalledTimes(1);
  });
  it("RATE_LIMIT keeps the retry hint in error_code", async () => {
    const { CompProviderError } = await import("./types");
    const limited: CompProvider = { name: "attom", callsPerComp: 2, async fetch() { throw new CompProviderError("RATE_LIMIT", 1, 60); } };
    const admin = fakeAdmin({ claim: [{ id: "r1", org_id: ORG, property_id: PROPERTY, trigger: "manual", reserved_calls: 3 }] });
    await drainCompQueue(1, { admin, provider: limited, ...on });
    expect(admin.rpcLog.find((c) => c.fn === "fn_finish_comp_fetch")?.args).toMatchObject({ p_status: "error", p_error_code: "RATE_LIMIT_RETRY_60" });
  });
});
