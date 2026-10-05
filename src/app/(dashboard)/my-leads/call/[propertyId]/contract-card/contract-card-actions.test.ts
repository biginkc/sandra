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
vi.mock("./contract-card-context", () => ({ loadContractCardData: mocks.load }));

import { loadContractCard, sendContractCardAction } from "./contract-card-actions";

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

  it("never sends when the projection library is unavailable even if everything else is ready", async () => {
    mocks.load.mockResolvedValue({ ctx: { prefillBase: {}, titleCompanies: [], buyerEntities: [], todayCentral: "", tomorrowCentral: "" } });
    const res = await sendContractCardAction(input);
    expect(res.status).toBe("blocked");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
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
    mocks.load.mockResolvedValue({ state: { enabled: true, marker: 1 } });
    expect(await loadContractCard(P)).toMatchObject({ enabled: true, marker: 1 });
  });
});
