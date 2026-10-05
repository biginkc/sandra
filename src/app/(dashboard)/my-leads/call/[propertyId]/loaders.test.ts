import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reportError: vi.fn(),
  markMessagesReadForProperty: vi.fn(),
  tables: {} as Record<string, { data: unknown; error: unknown }>,
  selects: [] as { table: string; columns: string }[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.reportError }));
vi.mock("@/app/(dashboard)/leads/actions", () => ({ markMessagesReadForProperty: mocks.markMessagesReadForProperty }));
vi.mock("@/lib/coach/coach-context-actions", () => ({ loadCoachCallContext: vi.fn() }));
vi.mock("@/lib/coach/script-cache", () => ({ loadCachedCoachBundle: vi.fn() }));
vi.mock("./contract-card/contract-card-actions", () => ({ loadContractCard: vi.fn() }));
vi.mock("@/lib/my-leads/flags", () => ({ getMyLeadsFlag: vi.fn() }));
vi.mock("@/lib/my-leads/schema-ready", () => ({ schemaReady: vi.fn() }));
vi.mock("@/lib/my-leads/queries", () => ({
  myLeadsViewer: vi.fn(),
  getMyLeadsQueueRow: vi.fn(),
  MyLeadsReadError: class MockErr extends Error {
    constructor(public code: string, message: string) { super(message); }
  },
}));

import { MyLeadsReadError } from "@/lib/my-leads/queries";
import { loadCallScreen } from "./loaders";

const propertyId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";

function client() {
  const make = (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ["eq", "is", "or", "order", "limit"]) chain[m] = self;
    chain.select = (columns: string) => { mocks.selects.push({ table, columns }); return chain; };
    const result = () => mocks.tables[table] ?? { data: null, error: null };
    chain.maybeSingle = async () => result();
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject);
    return chain;
  };
  return { from: make };
}

const queueRow = { propertyId, stage: "contacted", assignmentEpisodeId: "ep-1", queueVersion: 1, motivationKind: null, motivationText: null, phones: [], contactDnc: false };
const bundle = { schema_version: 1, script: { tokens: [] }, sections: { sections: [] } };
const deps = () => ({
  viewer: vi.fn(async () => ({ userId: "user-1", orgId: "org-1", isOwner: false, client: client() })),
  queueRow: vi.fn(async () => ({ status: "found" as const, row: queueRow, snapshotAt: "2026-10-04T00:00:00Z" })),
  bundle: vi.fn(async (): Promise<{ ref: { slug: string; revision: number; digest: string }; bundle: typeof bundle } | null> => ({ ref: { slug: "closr-outbound", revision: 1, digest: "d" }, bundle })),
  context: vi.fn(async () => ({ sellerName: "Pat", leadSource: null, occupancy: null })),
  flag: vi.fn(async () => true),
  schemaReady: vi.fn(async () => true),
  contractCard: vi.fn(async () => ({ enabled: false as const, reason: "off" })),
});

describe("loadCallScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selects.length = 0;
    mocks.tables = {
      properties: { data: { id: propertyId, org_id: "org-1", address: "123 Main St", city: "Austin", state: "TX", zip: "78701", market: "austin", is_training: false, homeowner_contact_id: contactId }, error: null },
      contacts: { data: { id: contactId, first_name: "Pat", last_name: "Seller", entity_name: null, contact_type: "person", email: "p@example.com", phone_1: "+15555550101", phone_1_type: "mobile", phone_2: null, phone_2_type: "mobile", phone_3: null, phone_3_type: "mobile" }, error: null },
      lead_comps: { data: { id: "c1", as_is_value: "250000.00", as_is_low: "240000", as_is_high: "260000", arv_estimate: null, verify_first: false, verify_reasons: [], comps: [], provider: "fixture", arv_method: "none" }, error: null },
      comp_fetch_requests: { data: { status: "ok", trigger: "manual" }, error: null },
      org_comp_settings: { data: { monthly_call_cap: 100 }, error: null },
      lead_valuation_inputs: { data: { arv: "300000", rehab: "20000" }, error: null },
      lead_notes: { data: [{ id: "n1", body: "hi" }], error: null },
      messages: { data: [{ id: "m2", created_at: "2026-10-02" }, { id: "m1", created_at: "2026-10-01" }], error: null },
    };
  });

  it("returns every section and never marks texts read", async () => {
    const result = await loadCallScreen(propertyId, deps() as never);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.lead.homeowner).toEqual({ contactId, name: "Pat Seller", email: "p@example.com", phones: [{ slot: 1, value: "+15555550101", type: "mobile" }] });
    expect(result.data.script.ok).toBe(true);
    expect(result.data.comps).toEqual({ ok: true, data: expect.objectContaining({
      latest: expect.objectContaining({ as_is_value: 250000, as_is_low: 240000, as_is_high: 260000, arv_estimate: null }),
      request: { status: "ok", trigger: "manual" },
      settings: { enabled: true, capped: false },
      valuation: { arv: 300000, rehab: 20000 },
    }) });
    expect(result.data.notes).toEqual({ ok: true, data: [{ id: "n1", body: "hi" }] });
    // Oldest first for the thread.
    expect(result.data.messages.ok && result.data.messages.data.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(result.data.contract.ok).toBe(false);
    expect(result.data.facts.ok).toBe(false);
    expect(mocks.markMessagesReadForProperty).not.toHaveBeenCalled();
  });

  it("mounts the contract section only when the card state is enabled; a throw degrades it alone", async () => {
    const on = { ...deps(), contractCard: vi.fn(async () => ({ enabled: true as const, marker: 1 })) };
    const a = await loadCallScreen(propertyId, on as never);
    expect(a.status === "ok" && a.data.contract.ok).toBe(true);
    const boom = { ...deps(), contractCard: vi.fn(async () => { throw new Error("x"); }) };
    const b = await loadCallScreen(propertyId, boom as never);
    expect(b.status).toBe("ok");
    expect(b.status === "ok" && b.data.contract.ok).toBe(false);
  });

  it("never requests the service-only raw column from lead_comps", async () => {
    await loadCallScreen(propertyId, deps() as never);
    const compsSelect = mocks.selects.find((s) => s.table === "lead_comps");
    expect(compsSelect).toBeDefined();
    expect(compsSelect!.columns.split(",").map((c) => c.trim())).not.toContain("raw");
  });

  it("degrades each section alone: a failing script, comps, notes or texts read still returns the others", async () => {
    const d = deps();
    d.bundle.mockResolvedValue(null);
    mocks.tables.lead_notes = { data: null, error: { message: "boom" } };
    mocks.tables.messages = { data: null, error: { message: "boom" } };
    mocks.tables.lead_comps = { data: null, error: { message: "boom" } };
    const result = await loadCallScreen(propertyId, d as never);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.script).toEqual({ ok: false, message: "The script could not be loaded." });
    expect(result.data.comps).toEqual({ ok: false, message: "Numbers could not be loaded." });
    expect(result.data.notes).toEqual({ ok: false, message: "Notes could not be loaded." });
    expect(result.data.messages).toEqual({ ok: false, message: "Texts could not be loaded." });
    expect(result.data.queueRow).toBe(queueRow);
    expect(mocks.reportError).toHaveBeenCalledTimes(4);
  });

  it("returns the disabled comps state without touching Phase 3 tables when the schema is not ready", async () => {
    const d = deps();
    d.schemaReady.mockResolvedValue(false);
    const result = await loadCallScreen(propertyId, d as never);
    expect(result.status === "ok" && result.data.comps).toEqual({ ok: true, data: { latest: null, request: null, settings: { enabled: false, capped: false }, valuation: { arv: null, rehab: null } } });
    expect(mocks.selects.map((s) => s.table)).not.toContain("lead_comps");
    expect(d.flag).not.toHaveBeenCalled();
  });

  it("maps a lead outside the queue to the shared unavailable reason", async () => {
    const d = deps();
    d.queueRow.mockResolvedValue({ status: "unavailable", reason: "other_rep" } as never);
    expect(await loadCallScreen(propertyId, d as never)).toEqual({ status: "unavailable", reason: "other_rep" });
  });

  it("rejects an invalid id and maps read errors", async () => {
    expect(await loadCallScreen("nope")).toEqual({ status: "invalid" });
    const d = deps();
    d.queueRow.mockRejectedValue(new MyLeadsReadError("FORBIDDEN", "You can view only your own queue."));
    expect(await loadCallScreen(propertyId, d as never)).toEqual({ status: "error", message: "You can view only your own queue." });
  });
});
