import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  myLeadsViewer: vi.fn(),
  getMyLeadsQueueRow: vi.fn(),
  getMyLeadsFlag: vi.fn(),
  schemaReady: vi.fn(),
  authenticate: vi.fn(),
  send: vi.fn(),
  load: vi.fn(),
  revalidatePath: vi.fn(),
  reportError: vi.fn(),
  loadProjection: vi.fn(),
  updateAssignee: vi.fn(),
  voidContract: vi.fn(),
  resolveIntent: vi.fn(),
  precheck: vi.fn(),
  createIntent: vi.fn(),
  projectNow: vi.fn(),
  abandon: vi.fn(),
}));

vi.mock("@/lib/my-leads/queries", () => ({
  myLeadsViewer: mocks.myLeadsViewer,
  getMyLeadsQueueRow: mocks.getMyLeadsQueueRow,
  MyLeadsReadError: class MyLeadsReadError extends Error {
    constructor(public code: string, message: string) { super(message); }
  },
}));
vi.mock("@/lib/my-leads/flags", () => ({ getMyLeadsFlag: mocks.getMyLeadsFlag }));
vi.mock("@/lib/my-leads/schema-ready", () => ({ schemaReady: mocks.schemaReady }));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.reportError }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/app/(dashboard)/leads/[id]/lead-esign-bindings", () => ({
  authenticateLeadEsignActor: mocks.authenticate,
  createBoundLeadEsignCore: () => ({ send: mocks.send }),
}));
vi.mock("./contract-card-projection", () => ({ loadProjectionView: mocks.loadProjection }));
vi.mock("@/app/(dashboard)/leads/actions", () => ({ updateLeadAssignee: mocks.updateAssignee }));
vi.mock("@/app/(dashboard)/leads/[id]/lead-esign-actions", () => ({ voidContractAction: mocks.voidContract }));
vi.mock("@/lib/my-leads/offer-projection", () => ({
  resolveOfferIntent: mocks.resolveIntent, precheckOffer: mocks.precheck, createOfferIntent: mocks.createIntent,
  projectOfferNow: mocks.projectNow, abandonOfferIntent: mocks.abandon,
}));
vi.mock("./contract-card-context", () => ({ loadContractCardData: mocks.load }));

import { novationBase as novationBaseForActions } from "./fixtures";
import {
  cancelContractAction, loadContractCard, reassignAndLogOfferAction, retryOfferProjectionAction, sendContractCardAction,
  supersedeOfferAction,
} from "./contract-card-actions";

const P = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const input = {
  propertyId: P, templateId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", sendIntentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  priceCents: 100, closingDate: "2099-01-01", titleCompanyId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  buyerEntityId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", earnestMoneyCents: 0, overrides: {}, signers: [{ role: "Seller", order: 0, name: "n", emailAddress: "e@x.test" }],
};

describe("sendContractCardAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.myLeadsViewer.mockResolvedValue({ userId: "u1", orgId: "o1", isOwner: false, client: {} });
    mocks.authenticate.mockResolvedValue({ userId: "u1", orgId: "o1", role: "member" });
    mocks.getMyLeadsFlag.mockResolvedValue(true);
    mocks.schemaReady.mockResolvedValue(true);
    mocks.getMyLeadsQueueRow.mockResolvedValue({ status: "found" });
  });

  it("is blocked FEATURE_DISABLED when the contract_card flag is off, with no eSign call", async () => {
    mocks.getMyLeadsFlag.mockResolvedValue(false);
    expect(await sendContractCardAction(input)).toMatchObject({ status: "blocked", code: "FEATURE_DISABLED" });
    expect(mocks.getMyLeadsFlag).toHaveBeenCalledWith("o1", "contract_card");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("is blocked FEATURE_DISABLED until the offer projection schema is ready (default state of this slice)", async () => {
    mocks.schemaReady.mockImplementation(async (f: string) => f !== "offer_projection");
    expect(await sendContractCardAction(input)).toMatchObject({ status: "blocked", code: "FEATURE_DISABLED" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("rejects an eSign actor that does not match the signed-in member", async () => {
    mocks.authenticate.mockResolvedValue({ userId: "someone-else", orgId: "o1", role: "owner" });
    expect(await sendContractCardAction(input)).toMatchObject({ status: "blocked", code: "FORBIDDEN" });
    mocks.authenticate.mockResolvedValue(null);
    expect(await sendContractCardAction(input)).toMatchObject({ status: "blocked", code: "FORBIDDEN" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("refuses a lead outside the caller's own queue", async () => {
    mocks.getMyLeadsQueueRow.mockResolvedValue({ status: "unavailable", reason: "other_rep" });
    expect(await sendContractCardAction(input)).toMatchObject({ status: "blocked", code: "NOT_IN_QUEUE" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("replays a known intent without precheck, intent creation or a second send (lost response)", async () => {
    mocks.resolveIntent.mockResolvedValue({
      projectionId: "p1", actorUserId: "u1", requestHash: "h", submissionHash: "not-matching", sendPayload: {}, state: "logged", esignRequestId: "r1", offerId: "o",
    });
    const res = await sendContractCardAction(input);
    expect(res).toMatchObject({ status: "blocked", code: "IDEMPOTENCY_CONFLICT" });
    expect(mocks.precheck).not.toHaveBeenCalled();
    expect(mocks.createIntent).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("maps an open-contract refusal from the database to blocked with nothing sent", async () => {
    mocks.resolveIntent.mockResolvedValue(null);
    mocks.precheck.mockResolvedValue({ ok: true, motivationRecorded: true });
    mocks.createIntent.mockResolvedValue({ error: "OPEN_CONTRACT_EXISTS" });
    mocks.load.mockResolvedValue({ ctx: null });
    const res = await sendContractCardAction(input);
    expect(res.status).toBe("blocked");
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe("loadContractCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.myLeadsViewer.mockResolvedValue({ userId: "u1", orgId: "o1", isOwner: false, client: {} });
    mocks.getMyLeadsFlag.mockResolvedValue(true);
    mocks.schemaReady.mockResolvedValue(true);
    mocks.getMyLeadsQueueRow.mockResolvedValue({ status: "found" });
  });
  it("is disabled when the flag is off or the schema is not ready", async () => {
    mocks.getMyLeadsFlag.mockResolvedValue(false);
    expect(await loadContractCard(P)).toMatchObject({ enabled: false });
    mocks.getMyLeadsFlag.mockResolvedValue(true);
    mocks.schemaReady.mockResolvedValue(false);
    expect(await loadContractCard(P)).toMatchObject({ enabled: false });
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("is disabled for an invalid id or a lead outside the caller's queue", async () => {
    expect(await loadContractCard("nope")).toMatchObject({ enabled: false });
    mocks.getMyLeadsQueueRow.mockResolvedValue({ status: "unavailable", reason: "unassigned" });
    expect(await loadContractCard(P)).toMatchObject({ enabled: false });
  });
  it("returns the loaded state when everything is ready", async () => {
    mocks.getMyLeadsQueueRow.mockResolvedValue({ status: "found", row: { motivationKind: "no_motivation" } });
    mocks.loadProjection.mockResolvedValue(null);
    mocks.load.mockResolvedValue({ state: { enabled: true, marker: 1 } });
    expect(await loadContractCard(P)).toMatchObject({ enabled: true, marker: 1 });
  });
});

describe("loadContractCard projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.myLeadsViewer.mockResolvedValue({ userId: "u1", orgId: "o1", isOwner: false, client: {} });
    mocks.getMyLeadsFlag.mockResolvedValue(true);
    mocks.schemaReady.mockResolvedValue(true);
  });
  it("attaches the lead's projection and whether motivation is recorded", async () => {
    mocks.getMyLeadsQueueRow.mockResolvedValue({ status: "found", row: { motivationKind: null } });
    mocks.load.mockResolvedValue({ state: { enabled: true } });
    mocks.loadProjection.mockResolvedValue({ id: "p1", state: "conflict" });
    expect(await loadContractCard(P)).toMatchObject({ enabled: true, motivationRecorded: false, projection: { id: "p1" } });
    expect(mocks.loadProjection).toHaveBeenCalledWith("o1", P);
  });
});

const PID = "11111111-1111-4111-8111-111111111111";
const RID = "22222222-2222-4222-8222-222222222222";
const KEY = "33333333-3333-4333-8333-333333333333";

function recoveryClient(row: Record<string, unknown> | null, rpcResult: { data?: unknown; error?: { message?: string } | null } = { data: { state: "logged" }, error: null }) {
  const rpc = vi.fn(async () => ({ data: rpcResult.data ?? null, error: rpcResult.error ?? null }));
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.maybeSingle = async () => ({ data: row, error: null });
  return { client: { from: () => chain, rpc }, rpc };
}

describe("offer recovery actions never send a contract", () => {
  const row = { id: PID, property_id: P, actor_user_id: "u1", esign_request_id: RID, state: "conflict" };
  const setup = (isOwner: boolean, r: Record<string, unknown> | null = row, rpcResult?: Parameters<typeof recoveryClient>[1]) => {
    vi.clearAllMocks();
    const c = recoveryClient(r, rpcResult);
    mocks.myLeadsViewer.mockResolvedValue({ userId: "u1", orgId: "o1", isOwner, client: c.client });
    mocks.getMyLeadsFlag.mockResolvedValue(true);
    mocks.schemaReady.mockResolvedValue(true);
    return c;
  };

  it("retry and supersede call only their RPCs", async () => {
    const c = setup(false);
    expect(await retryOfferProjectionAction(PID)).toMatchObject({ ok: true });
    expect(c.rpc).toHaveBeenCalledWith("fn_retry_offer_projection", { p_org_id: "o1", p_projection_id: PID });
    expect(await supersedeOfferAction(PID, KEY)).toMatchObject({ ok: true });
    expect(c.rpc).toHaveBeenCalledWith("fn_supersede_offer_and_log", { p_org_id: "o1", p_projection_id: PID, p_idempotency_key: KEY });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/my-leads");
  });

  it("maps database refusals to plain copy and changes nothing", async () => {
    setup(false, row, { error: { message: "PROJECTION_NOT_LOGGED" } });
    expect(await supersedeOfferAction(PID, KEY)).toMatchObject({ ok: false, code: "PROJECTION_NOT_LOGGED" });
    setup(false, row, { error: { message: "FORBIDDEN" } });
    expect(await retryOfferProjectionAction(PID)).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("rejects invalid ids, a missing projection and a disabled feature", async () => {
    setup(false);
    expect(await retryOfferProjectionAction("nope")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await supersedeOfferAction(PID, "bad")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    setup(false, null);
    expect(await retryOfferProjectionAction(PID)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    setup(false);
    mocks.getMyLeadsFlag.mockResolvedValue(false);
    expect(await retryOfferProjectionAction(PID)).toMatchObject({ ok: false, code: "FEATURE_DISABLED" });
  });

  it("reassign reassigns to the viewer then logs as reassigned; a non-owner non-sender is refused", async () => {
    const c = setup(false);
    mocks.updateAssignee.mockResolvedValue({ ok: true, data: null });
    expect(await reassignAndLogOfferAction(PID)).toMatchObject({ ok: true });
    expect(mocks.updateAssignee).toHaveBeenCalledWith(P, "u1");
    expect(c.rpc).toHaveBeenCalledWith("fn_retry_offer_projection", { p_org_id: "o1", p_projection_id: PID, p_resolution: "reassigned" });
    setup(false, { ...row, actor_user_id: "someone-else" });
    expect(await reassignAndLogOfferAction(PID)).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(mocks.updateAssignee).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("a failed reassign stops before logging", async () => {
    const c = setup(true);
    mocks.updateAssignee.mockResolvedValue({ ok: false, error: { code: "DNC", message: "locked" } });
    expect(await reassignAndLogOfferAction(PID)).toMatchObject({ ok: false, code: "DNC" });
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it("cancel voids through the existing action only for the sender or an owner", async () => {
    setup(false);
    mocks.voidContract.mockResolvedValue({ ok: true, data: null });
    expect(await cancelContractAction(RID)).toMatchObject({ ok: true, state: "cancelled" });
    expect(mocks.voidContract).toHaveBeenCalledWith({ requestId: RID });
    setup(false, { ...row, actor_user_id: "someone-else" });
    expect(await cancelContractAction(RID)).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(mocks.voidContract).not.toHaveBeenCalled();
    setup(true, { ...row, actor_user_id: "someone-else" });
    mocks.voidContract.mockResolvedValue({ ok: false, error: { code: "VOID_IN_PROGRESS", message: "busy" } });
    expect(await cancelContractAction(RID)).toMatchObject({ ok: false, code: "VOID_IN_PROGRESS" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe("saving typed entities is authorized like contract defaults", () => {
  it("only an owner's own client inserts into the org lists; a non-owner never writes", async () => {
    vi.clearAllMocks();
    const inserts: { table: string; row: Record<string, unknown> }[] = [];
    const client = { from: (table: string) => ({ insert: async (row: Record<string, unknown>) => { inserts.push({ table, row }); return { error: null }; } }) };
    mocks.getMyLeadsFlag.mockResolvedValue(true);
    mocks.schemaReady.mockResolvedValue(true);
    mocks.getMyLeadsQueueRow.mockResolvedValue({ status: "found" });
    mocks.authenticate.mockResolvedValue({ userId: "u1", orgId: "o1", role: "member" });
    mocks.resolveIntent.mockResolvedValue(null);
    mocks.precheck.mockResolvedValue({ ok: true });
    mocks.createIntent.mockResolvedValue({ projectionId: "p1" });
    mocks.projectNow.mockResolvedValue({ state: "pending" });
    mocks.send.mockResolvedValue({ ok: true, data: { requestId: "r1" } });
    mocks.load.mockResolvedValue({ ctx: { prefillBase: { ...novationBaseForActions() }, titleCompanies: [], buyerEntities: [], todayCentral: "2026-10-04", tomorrowCentral: "2026-10-05" } });
    const typedInput = { ...input, titleCompanyId: "", buyerEntityId: "", titleCompanyNew: { name: "T", closingAgentName: "A" }, buyerEntityNew: { name: "B", email: "b@x.test" }, closingDate: "2099-01-01" };
    for (const isOwner of [false, true]) {
      inserts.length = 0;
      mocks.myLeadsViewer.mockResolvedValue({ userId: "u1", orgId: "o1", isOwner, client });
      const res = await sendContractCardAction(typedInput as never);
      expect(inserts.length).toBe(isOwner && res.status === "sent" ? 2 : 0);
      if (isOwner && res.status === "sent") expect(inserts.map((i) => i.table).sort()).toEqual(["acquisition_contract_buyer_entities", "acquisition_contract_title_companies"]);
    }
  });
});
