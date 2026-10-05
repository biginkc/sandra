import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  myLeadsViewer: vi.fn(),
  getMyLeadsQueueRow: vi.fn(),
  getMyLeadsFlag: vi.fn(),
  schemaReady: vi.fn(),
  rpc: vi.fn(),
  maybeSingle: vi.fn(),
  createNextStep: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("@/lib/my-leads/queries", () => ({
  myLeadsViewer: mocks.myLeadsViewer,
  getMyLeadsQueueRow: mocks.getMyLeadsQueueRow,
  MyLeadsReadError: class MyLeadsReadError extends Error {},
}));
vi.mock("@/lib/my-leads/flags", () => ({ getMyLeadsFlag: mocks.getMyLeadsFlag }));
vi.mock("@/lib/my-leads/schema-ready", () => ({ schemaReady: mocks.schemaReady }));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.reportError }));
vi.mock("@/lib/next-steps", () => ({ createNextStep: mocks.createNextStep }));

import { acceptCallFactAction, dismissCallFactsAction } from "./facts-actions";

const propertyId = "11111111-1111-4111-8111-111111111111";
const factId = "33333333-3333-4333-8333-333333333333";
const future = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString();
const factRow = (over: Record<string, unknown> = {}) => ({
  id: factId, property_id: propertyId, status: "proposed", accepted: {},
  facts: { asking_price: { value: "$185,000" }, motivation: { value: "must move" }, next_step: { value: "next Friday", due_at: future } },
  ...over,
});

describe("call fact actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) chain[m] = () => chain;
    chain.maybeSingle = mocks.maybeSingle;
    mocks.myLeadsViewer.mockResolvedValue({ userId: "user-1", orgId: "org-1", client: { rpc: mocks.rpc, from: () => chain } });
    mocks.getMyLeadsFlag.mockResolvedValue(true);
    mocks.getMyLeadsQueueRow.mockResolvedValue({ status: "found", row: { address: "12 Elm St", contactId: "c1" }, snapshotAt: "x" });
    mocks.schemaReady.mockResolvedValue(true);
    mocks.maybeSingle.mockResolvedValue({ data: factRow(), error: null });
    mocks.rpc.mockResolvedValue({ data: { duplicate: false }, error: null });
    mocks.createNextStep.mockResolvedValue({ ok: true, data: { duplicate: false } });
  });

  it("accepts a plain fact with the STORED value (not the client's) and writes nothing else", async () => {
    const out = await acceptCallFactAction({ propertyId, factId, field: "asking_price" });
    expect(out).toEqual({ ok: true, field: "asking_price", value: "$185,000", duplicate: false, nextStepCreated: false });
    expect(mocks.rpc).toHaveBeenCalledWith("fn_accept_call_fact", { p_org_id: "org-1", p_fact_id: factId, p_field: "asking_price", p_value: "$185,000" });
    expect(mocks.createNextStep).not.toHaveBeenCalled();
  });

  it("accepting next_step records the acceptance FIRST (verbatim value), then creates the phone appointment from due_at", async () => {
    const order: string[] = [];
    mocks.rpc.mockImplementation(async (fn: string) => { order.push(fn); return { data: { duplicate: false }, error: null }; });
    mocks.createNextStep.mockImplementation(async () => { order.push("createNextStep"); return { ok: true, data: { duplicate: false } }; });
    const out = await acceptCallFactAction({ propertyId, factId, field: "next_step" });
    expect(out).toMatchObject({ ok: true, field: "next_step", value: "next Friday", nextStepCreated: true });
    expect(order).toEqual(["fn_accept_call_fact", "createNextStep"]);
    expect(mocks.rpc).toHaveBeenCalledWith("fn_accept_call_fact", { p_org_id: "org-1", p_fact_id: factId, p_field: "next_step", p_value: "next Friday" });
    expect(mocks.createNextStep).toHaveBeenCalledWith(expect.objectContaining({
      kind: "appointment", mode: "phone", propertyId, contactId: "c1", assigneeId: "user-1", dueAt: future, title: "Call 12 Elm St", origin: "app",
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    }));
  });

  it("a refused accept (dismissed or not yours) creates no appointment", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "22023" } });
    expect((await acceptCallFactAction({ propertyId, factId, field: "next_step" })).ok).toBe(false);
    expect(mocks.createNextStep).not.toHaveBeenCalled();
  });

  it("the next_step key is stable across retries; a failed createNextStep undoes the acceptance so the chip returns", async () => {
    await acceptCallFactAction({ propertyId, factId, field: "next_step" });
    await acceptCallFactAction({ propertyId, factId, field: "next_step" });
    const keys = mocks.createNextStep.mock.calls.map((c) => c[0].idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    mocks.rpc.mockClear();
    mocks.createNextStep.mockResolvedValue({ ok: false, error: { code: "X", message: "nope" } });
    const out = await acceptCallFactAction({ propertyId, factId, field: "next_step" });
    expect(out).toEqual({ ok: false, message: "Next step not set: nope" });
    expect(mocks.rpc).toHaveBeenCalledWith("fn_unaccept_call_fact", { p_org_id: "org-1", p_fact_id: factId, p_field: "next_step" });
  });

  it("refuses a next_step whose resolved time has passed or is missing", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: factRow({ facts: { next_step: { value: "x", due_at: "2020-01-01T00:00:00.000Z" } } }), error: null });
    expect((await acceptCallFactAction({ propertyId, factId, field: "next_step" })).ok).toBe(false);
    mocks.maybeSingle.mockResolvedValue({ data: factRow({ facts: { next_step: { value: "x" } } }), error: null });
    expect((await acceptCallFactAction({ propertyId, factId, field: "next_step" })).ok).toBe(false);
    expect(mocks.createNextStep).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuses unknown fields, fields with no proposal, dismissed facts and malformed ids", async () => {
    expect((await acceptCallFactAction({ propertyId, factId, field: "owner_ssn" })).ok).toBe(false);
    expect((await acceptCallFactAction({ propertyId, factId, field: "timeline" })).ok).toBe(false);
    mocks.maybeSingle.mockResolvedValue({ data: factRow({ status: "dismissed" }), error: null });
    expect((await acceptCallFactAction({ propertyId, factId, field: "asking_price" })).ok).toBe(false);
    expect((await acceptCallFactAction({ propertyId: "nope", factId, field: "asking_price" })).ok).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("an already accepted field comes back as a duplicate from the database (no second note)", async () => {
    mocks.rpc.mockResolvedValue({ data: { duplicate: true }, error: null });
    expect(await acceptCallFactAction({ propertyId, factId, field: "asking_price" })).toMatchObject({ ok: true, duplicate: true });
  });

  it("is gated by the call_screen flag, the caller's own queue and the schema", async () => {
    mocks.getMyLeadsFlag.mockResolvedValue(false);
    expect((await acceptCallFactAction({ propertyId, factId, field: "asking_price" })).ok).toBe(false);
    mocks.getMyLeadsFlag.mockResolvedValue(true);
    mocks.getMyLeadsQueueRow.mockResolvedValue({ status: "unavailable", reason: "other_rep" });
    expect((await dismissCallFactsAction({ propertyId, factId })).ok).toBe(false);
    mocks.getMyLeadsQueueRow.mockResolvedValue({ status: "found", row: {}, snapshotAt: "x" });
    mocks.schemaReady.mockResolvedValue(false);
    expect((await dismissCallFactsAction({ propertyId, factId })).ok).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("a fact that RLS hides (another org or lead) is not found", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await acceptCallFactAction({ propertyId, factId, field: "asking_price" })).toEqual({ ok: false, message: "That lead could not be found." });
  });

  it("dismiss calls fn_dismiss_call_facts only", async () => {
    expect(await dismissCallFactsAction({ propertyId, factId })).toEqual({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledWith("fn_dismiss_call_facts", { p_org_id: "org-1", p_fact_id: factId });
    expect(mocks.createNextStep).not.toHaveBeenCalled();
  });

  it("maps database errors to plain messages and reports unknown ones", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    expect((await dismissCallFactsAction({ propertyId, factId })).ok).toBe(false);
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    const out = await dismissCallFactsAction({ propertyId, factId });
    expect(out.ok).toBe(false);
    expect(mocks.reportError).toHaveBeenCalled();
  });
});
