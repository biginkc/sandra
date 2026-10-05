import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("./queries", () => ({
  getMyLeadsQueueRow: vi.fn(),
  MyLeadsReadError: class MyLeadsReadError extends Error {
    constructor(public code: string, message: string) { super(message); }
  },
}));
vi.mock("./schema-ready", () => ({ schemaReady: vi.fn() }));

import { MyLeadsReadError } from "./queries";
import {
  abandonOfferIntent, createOfferIntent, precheckOffer, projectOfferNow, resolveOfferIntent, sweepOfferProjections,
} from "./offer-projection";

const row = (over: Record<string, unknown> = {}) => ({
  status: "found" as const,
  snapshotAt: "x",
  row: { propertyId: "p", stage: "needs_offer", queueVersion: 4, sharedStatus: "new_lead", assignmentEpisodeId: "e1", motivationKind: null, offer: null, ...over },
});
const clientWith = (open: unknown[] = []) => ({
  from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ in: () => ({ limit: async () => ({ data: open, error: null }) }) }) }) }) }),
});
const viewer = (open: unknown[] = []) => ({ userId: "u", orgId: "o", client: clientWith(open) });

describe("precheckOffer", () => {
  it("maps every unavailable reason", async () => {
    const cases: Record<string, string> = {
      not_found: "NOT_IN_QUEUE", unassigned: "NOT_IN_QUEUE", other_rep: "NOT_IN_QUEUE",
      no_active_episode: "NOT_IN_QUEUE", archived: "NOT_IN_QUEUE", closed_dead_dnc: "DNC_OR_UNAVAILABLE",
    };
    for (const [reason, code] of Object.entries(cases)) {
      const r = await precheckOffer(viewer(), "p", { getRow: async () => ({ status: "unavailable", reason } as never) });
      expect(r).toMatchObject({ ok: false, code });
    }
  });
  it("maps FEATURE_DISABLED, terminal status, pending offer and open projection", async () => {
    const disabled = async () => { throw new MyLeadsReadError("FEATURE_DISABLED", "off"); };
    expect(await precheckOffer(viewer(), "p", { getRow: disabled as never })).toMatchObject({ code: "FEATURE_DISABLED" });
    for (const s of ["offer_declined", "under_contract", "closed", "dead"]) {
      expect(await precheckOffer(viewer(), "p", { getRow: async () => row({ sharedStatus: s }) as never })).toMatchObject({ code: "STALE_STATE" });
    }
    expect(await precheckOffer(viewer(), "p", { getRow: async () => row({ stage: "under_contract" }) as never })).toMatchObject({ code: "STALE_STATE" });
    expect(await precheckOffer(viewer(), "p", { getRow: async () => row({ offer: { outcome: "pending" } }) as never })).toMatchObject({ code: "PENDING_OFFER_EXISTS" });
    expect(await precheckOffer(viewer([{ id: "x" }]), "p", { getRow: async () => row() as never })).toMatchObject({ code: "OPEN_CONTRACT_EXISTS" });
  });
  it("is ok and reports whether motivation is already recorded", async () => {
    expect(await precheckOffer(viewer(), "p", { getRow: async () => row() as never })).toEqual({ ok: true, queueVersion: 4, episodeId: "e1", motivationRecorded: false });
    expect(await precheckOffer(viewer(), "p", { getRow: async () => row({ motivationKind: "no_motivation" }) as never })).toMatchObject({ motivationRecorded: true });
  });
});

describe("createOfferIntent", () => {
  const input = {
    orgId: "o", propertyId: "p", actorUserId: "u", sendIntentId: "i", requestHash: "h", submissionHash: "s", sendPayload: { a: "b" },
    amountCents: 100, closingDate: "2030-01-01", motivation: { kind: "specified" as const, text: "divorce" }, temperature: "hot" as const,
  };
  const admin = (error: { message?: string; code?: string } | null, data: unknown = "pid") => () => ({ rpc: vi.fn(async () => ({ data, error })), from: vi.fn() });
  it("returns the projection id and maps database errors", async () => {
    expect(await createOfferIntent(input, { admin: admin(null) })).toEqual({ projectionId: "pid" });
    expect(await createOfferIntent(input, { admin: admin({ code: "23505" }) })).toEqual({ error: "OPEN_CONTRACT_EXISTS" });
    expect(await createOfferIntent(input, { admin: admin({ message: "OPEN_CONTRACT_EXISTS" }) })).toEqual({ error: "OPEN_CONTRACT_EXISTS" });
    expect(await createOfferIntent(input, { admin: admin({ message: "PENDING_OFFER_EXISTS" }) })).toEqual({ error: "PENDING_OFFER_EXISTS" });
    expect(await createOfferIntent(input, { admin: admin({ message: "IDEMPOTENCY_CONFLICT" }) })).toEqual({ error: "IDEMPOTENCY_CONFLICT" });
    expect(await createOfferIntent(input, { admin: admin({ message: "boom" }) })).toEqual({ error: "FAILED" });
  });
  it("passes motivation through to the database", async () => {
    const a = admin(null)();
    await createOfferIntent(input, { admin: () => a });
    expect(a.rpc).toHaveBeenCalledWith("fn_create_offer_projection", expect.objectContaining({ p_motivation_kind: "specified", p_motivation_text: "divorce", p_temperature: "hot" }));
  });
});

describe("projectOfferNow / abandon", () => {
  it("returns awaiting_send without logging and throws on rpc failure", async () => {
    const rpc = vi.fn(async () => ({ data: { state: "awaiting_send" }, error: null }));
    expect(await projectOfferNow("p", { admin: () => ({ rpc, from: vi.fn() }) })).toEqual({ state: "awaiting_send" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("fn_project_acquisition_offer", { p_projection_id: "p" });
    await expect(projectOfferNow("p", { admin: () => ({ rpc: async () => ({ data: null, error: { message: "x" } }), from: vi.fn() }) })).rejects.toThrow();
    await expect(abandonOfferIntent("p", { admin: () => ({ rpc: async () => ({ data: null, error: { message: "x" } }), from: vi.fn() }) })).rejects.toThrow();
  });
});

describe("resolveOfferIntent", () => {
  const found = (data: unknown) => ({ userId: "u", orgId: "o", client: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error: null }) }) }) }) }) } });
  it("returns the stored intent for a known id and null for a new one", async () => {
    expect(await resolveOfferIntent(found(null), "i")).toBeNull();
    const got = await resolveOfferIntent(found({
      id: "p", actor_user_id: "u", request_hash: "h", submission_hash: "s", send_payload: { a: "b", n: 1 }, state: "logged", esign_request_id: "r", offer_id: "of",
    }), "i");
    expect(got).toEqual({ projectionId: "p", actorUserId: "u", requestHash: "h", submissionHash: "s", sendPayload: { a: "b" }, state: "logged", esignRequestId: "r", offerId: "of" });
  });
});

describe("sweepOfferProjections", () => {
  type Row = Record<string, unknown>;
  const make = (opts: { flagged: string[]; due?: string[]; conflicts?: Row[]; orgOf?: Record<string, string> }) => {
    const rpc = vi.fn(async (name: string) => {
      if (name === "fn_offer_projection_repair") return { data: 2, error: null };
      if (name === "fn_offer_projection_due") return { data: opts.due ?? [], error: null };
      return { data: { state: "logged" }, error: null };
    });
    const alerts: string[] = [];
    const from = vi.fn((table: string) => {
      if (table === "my_leads_feature_flags") return { select: () => ({ eq: async () => ({ data: opts.flagged.map((org_id) => ({ org_id })), error: null }) }) };
      const chain: Record<string, unknown> = {};
      let id = "";
      let mode = "";
      chain.select = (cols: string) => { mode = cols.includes("conflict_code") ? "conflicts" : mode || "meta"; return chain; };
      chain.update = () => { mode = "update"; return chain; };
      chain.eq = (c: string, v: string) => { if (c === "id") id = v; return mode === "conflicts" ? chain : chain; };
      chain.is = () => chain;
      chain.lt = async () => ({ data: opts.conflicts ?? [], error: null });
      chain.maybeSingle = async () => ({ data: { org_id: opts.orgOf?.[id] ?? "o1" }, error: null });
      (chain as { then?: unknown }).then = undefined;
      const upd = () => { alerts.push(id); return { data: [{ id }], error: null }; };
      chain.select = ((cols: string) => (mode === "update" ? upd() : (mode = cols.includes("conflict_code") ? "conflicts" : "meta", chain))) as never;
      return chain;
    });
    return { admin: () => ({ rpc, from }) as never, rpc, alerts };
  };
  const ready = async () => true;
  it("does nothing, with no RPC, when the flag is off for every org", async () => {
    const m = make({ flagged: [] });
    expect(await sweepOfferProjections(10, { admin: m.admin, schemaReady: ready as never })).toEqual({ repaired: 0, projected: 0, conflicts: 0, disabled: "flag_off" });
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("does nothing when the schema is not ready", async () => {
    const m = make({ flagged: ["o1"] });
    expect(await sweepOfferProjections(10, { admin: m.admin, schemaReady: (async () => false) as never })).toMatchObject({ disabled: "not_ready" });
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("repairs, projects due rows of flagged orgs only, and alerts once per old conflict", async () => {
    const report = vi.fn();
    const m = make({
      flagged: ["o1"], due: ["a", "b"], orgOf: { a: "o1", b: "o2" },
      conflicts: [{ id: "c1", org_id: "o1", property_id: "p", conflict_code: "STALE_STATE" }, { id: "c2", org_id: "o2", property_id: "q", conflict_code: "STALE_STATE" }],
    });
    const out = await sweepOfferProjections(10, { admin: m.admin, schemaReady: ready as never, reportError: report });
    expect(out).toEqual({ repaired: 2, projected: 1, conflicts: 1 });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][1]).toMatchObject({ tags: { surface: "offer_projection_conflict" } });
    expect(m.rpc.mock.calls.filter((c) => c[0] === "fn_project_acquisition_offer")).toHaveLength(1);
  });
});
